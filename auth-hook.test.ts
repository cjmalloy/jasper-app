import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ADMIN_ROLE,
  authHeaders,
  CLIENT_KEY_HEADER,
  ClientAuth,
  clientUrls,
  isTrustedInitiator,
  isUserSave,
  needsAdmin,
  USER_ROLE_HEADER,
} from './auth-hook.ts';

const anonymous = { debug: false, tag: '', admin: false, mod: false, editor: false, user: false, viewer: false, banned: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function auth(whoami: () => Promise<unknown>, opts: { now?: () => number, cooldownMs?: number } = {}) {
  return new ClientAuth({ clientKey: 'key', port: () => '8082', whoami, ...opts });
}

describe('clientUrls', () => {
  it('matches localhost and 127.0.0.1 over http and ws on the client port', () => {
    assert.deepEqual(clientUrls('8082'), [
      'http://localhost:8082/*',
      'http://127.0.0.1:8082/*',
      'ws://localhost:8082/*',
      'ws://127.0.0.1:8082/*',
    ]);
  });
});

describe('needsAdmin', () => {
  it('is true when whoami reports no role at all', () => {
    assert.equal(needsAdmin(anonymous), true);
  });

  for (const role of ['admin', 'mod', 'editor', 'user', 'viewer', 'banned']) {
    it(`is false when whoami reports ${role}`, () => {
      assert.equal(needsAdmin({ ...anonymous, tag: '+user', [role]: true }), false);
    });
  }

  it('fails closed on unexpected responses', () => {
    for (const roles of [undefined, null, '', 'ok', 0, [], {}, { ...anonymous, banned: undefined }, { ...anonymous, admin: 'false' }]) {
      assert.equal(needsAdmin(roles), false, JSON.stringify(roles));
    }
  });
});

describe('isTrustedInitiator', () => {
  it('trusts the client origins and browser initiated requests', () => {
    assert.equal(isTrustedInitiator(undefined, '8082'), true);
    assert.equal(isTrustedInitiator('http://localhost:8082', '8082'), true);
    assert.equal(isTrustedInitiator('http://127.0.0.1:8082', '8082'), true);
  });

  it('does not trust other origins', () => {
    for (const origin of ['null', '', 'file://', 'https://example.com', 'http://localhost:8083', 'http://localhost', 'http://localhost.example.com:8082']) {
      assert.equal(isTrustedInitiator(origin, '8082'), false, origin);
    }
  });
});

describe('authHeaders', () => {
  it('always adds the client key', () => {
    assert.deepEqual(authHeaders({ Accept: '*/*' }, 'key', false), { Accept: '*/*', [CLIENT_KEY_HEADER]: 'key' });
  });

  it('adds User-Role only for admin', () => {
    assert.equal(authHeaders({}, 'key', true)[USER_ROLE_HEADER], ADMIN_ROLE);
    assert.equal(authHeaders({}, 'key', false)[USER_ROLE_HEADER], undefined);
  });

  it('drops values set by the page and keeps the rest', () => {
    const headers = authHeaders({
      'user-role': 'ROLE_ADMIN',
      'USER-ROLE': 'ROLE_MOD',
      'x-jasper-key': 'guess',
      'Authorization': '******',
      'User-Tag': '+user/chris',
    }, 'key', false);
    assert.deepEqual(headers, {
      'Authorization': '******',
      'User-Tag': '+user/chris',
      [CLIENT_KEY_HEADER]: 'key',
    });
  });
});

describe('isUserSave', () => {
  it('matches successful changes to users and profiles', () => {
    for (const [method, url] of [
      ['POST', 'http://localhost:8082/api/v1/user'],
      ['PUT', 'http://localhost:8082/api/v1/user'],
      ['PATCH', 'http://localhost:8082/api/v1/user?tag=%2Buser'],
      ['DELETE', 'http://127.0.0.1:8082/api/v1/user?tag=%2Buser'],
      ['POST', 'http://localhost:8082/api/v1/user/keygen?tag=%2Buser'],
      ['POST', 'http://localhost:8082/api/v1/profile/role?tag=%2Buser'],
    ]) {
      assert.equal(isUserSave({ method, url, statusCode: 200 }), true, `${method} ${url}`);
    }
  });

  it('ignores reads, failures and other entities', () => {
    assert.equal(isUserSave({ method: 'GET', url: 'http://localhost:8082/api/v1/user?tag=%2Buser', statusCode: 200 }), false);
    assert.equal(isUserSave({ method: 'PUT', url: 'http://localhost:8082/api/v1/user', statusCode: 403 }), false);
    assert.equal(isUserSave({ method: 'PUT', url: 'http://localhost:8082/api/v1/user', statusCode: 500 }), false);
    assert.equal(isUserSave({ method: 'POST', url: 'http://localhost:8082/api/v1/ref', statusCode: 201 }), false);
    assert.equal(isUserSave({ method: 'POST', url: 'http://localhost:8082/api/v1/users', statusCode: 201 }), false);
    assert.equal(isUserSave({ method: 'POST', url: 'not a url', statusCode: 201 }), false);
  });
});

describe('ClientAuth', () => {
  it('fails closed before the first check', () => {
    const a = auth(async () => anonymous);
    const { requestHeaders } = a.beforeSendHeaders({ requestHeaders: {} });
    assert.equal(requestHeaders![CLIENT_KEY_HEADER], 'key');
    assert.equal(requestHeaders![USER_ROLE_HEADER], undefined);
  });

  it('adds User-Role when +user has no role', async () => {
    const a = auth(async () => anonymous);
    assert.equal(await a.refresh(), true);
    assert.equal(a.needsAdmin, true);
    const { requestHeaders } = a.beforeSendHeaders({ requestHeaders: {}, initiatorOrigin: 'http://localhost:8082' });
    assert.equal(requestHeaders![USER_ROLE_HEADER], ADMIN_ROLE);
    assert.equal(requestHeaders![CLIENT_KEY_HEADER], 'key');
  });

  it('uses the role of +user once it has one', async () => {
    const a = auth(async () => ({ ...anonymous, tag: '+user', user: true, viewer: true }));
    await a.refresh();
    assert.equal(a.needsAdmin, false);
    const { requestHeaders } = a.beforeSendHeaders({ requestHeaders: { 'User-Role': 'ROLE_ADMIN' } });
    assert.equal(requestHeaders![USER_ROLE_HEADER], undefined);
    assert.equal(requestHeaders!['User-Role'], undefined);
  });

  it('does not escalate requests from other origins', async () => {
    const a = auth(async () => anonymous);
    await a.refresh();
    const { requestHeaders } = a.beforeSendHeaders({ requestHeaders: {}, initiatorOrigin: 'https://example.com' });
    assert.equal(requestHeaders![USER_ROLE_HEADER], undefined);
    assert.equal(requestHeaders![CLIENT_KEY_HEADER], 'key');
  });

  it('fails closed when the check errors', async () => {
    let fail = false;
    const a = auth(async () => {
      if (fail) throw new Error('502');
      return anonymous;
    });
    await a.refresh();
    assert.equal(a.needsAdmin, true);
    fail = true;
    assert.equal(await a.refresh(), false);
    assert.equal(a.needsAdmin, false);
  });

  it('fails closed when whoami throws synchronously', async () => {
    const a = auth(() => {
      throw new Error('boom');
    });
    assert.equal(await a.refresh(), false);
    assert.equal(a.needsAdmin, false);
  });

  it('shares a running check and runs once more afterwards', async () => {
    const calls: { resolve: (value: unknown) => void }[] = [];
    const a = auth(() => {
      const d = deferred<unknown>();
      calls.push(d);
      return d.promise;
    });
    const first = a.refresh();
    assert.equal(a.refresh(), first);
    assert.equal(a.refresh(), first);
    await flush();
    assert.equal(calls.length, 1);
    calls[0].resolve(anonymous);
    assert.equal(await first, true);
    assert.equal(a.needsAdmin, true);
    // One more check for the calls made during the first, ex. a save that raced it
    await flush();
    assert.equal(calls.length, 2);
    calls[1].resolve({ ...anonymous, user: true });
    await flush();
    assert.equal(a.needsAdmin, false);
    assert.equal(calls.length, 2);
  });

  it('rechecks after a user save', async () => {
    let calls = 0;
    const a = auth(async () => {
      calls++;
      return anonymous;
    });
    a.completed({ method: 'PUT', url: 'http://localhost:8082/api/v1/user', statusCode: 200 });
    await flush();
    assert.equal(calls, 1);
    assert.equal(a.needsAdmin, true);
    a.completed({ method: 'GET', url: 'http://localhost:8082/api/v1/user?tag=%2Buser', statusCode: 200 });
    a.completed({ method: 'POST', url: 'http://localhost:8082/api/v1/ref', statusCode: 201 });
    await flush();
    assert.equal(calls, 1);
  });

  it('rechecks on 403, at most once per cooldown', async () => {
    let now = 0;
    let calls = 0;
    const a = auth(async () => {
      calls++;
      return anonymous;
    }, { now: () => now, cooldownMs: 5000 });
    const denied = { method: 'GET', url: 'http://localhost:8082/api/v1/ref/page', statusCode: 403 };
    a.completed(denied);
    await flush();
    assert.equal(calls, 1);
    now = 1000;
    a.completed(denied);
    a.completed({ ...denied, statusCode: 401 });
    await flush();
    assert.equal(calls, 1);
    now = 6000;
    a.completed(denied);
    await flush();
    assert.equal(calls, 2);
  });

  it('registers both listeners on the client URLs', async () => {
    const registered: Record<string, { filter: { urls: string[] }, listener: Function }> = {};
    const webRequest = {
      onBeforeSendHeaders: (filter: { urls: string[] }, listener: Function) => registered.before = { filter, listener },
      onCompleted: (filter: { urls: string[] }, listener: Function) => registered.completed = { filter, listener },
    };
    const a = auth(async () => anonymous);
    a.register(webRequest as any);
    assert.deepEqual(registered.before.filter.urls, clientUrls('8082'));
    assert.deepEqual(registered.completed.filter.urls, clientUrls('8082'));
    await a.refresh();
    let response: any;
    registered.before.listener({ requestHeaders: { Accept: '*/*' } }, (r: any) => response = r);
    assert.deepEqual(response, { requestHeaders: { Accept: '*/*', [CLIENT_KEY_HEADER]: 'key', [USER_ROLE_HEADER]: ADMIN_ROLE } });
  });
});
