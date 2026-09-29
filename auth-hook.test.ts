import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  authHeaders,
  beforeSendHeaders,
  clientOrigins,
  clientUrls,
  isTrustedInitiator,
  register,
} from './auth-hook.ts';

const bearer = (token: string) => ['Bearer', token].join(' ');

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

describe('clientOrigins', () => {
  it('is localhost and 127.0.0.1 on the client port', () => {
    assert.deepEqual(clientOrigins(8082), ['http://localhost:8082', 'http://127.0.0.1:8082']);
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
  it('adds the window token', () => {
    assert.deepEqual(authHeaders({ Accept: '*/*' }, 'jwt'), { Accept: '*/*', Authorization: bearer('jwt') });
  });

  it('adds nothing without a token', () => {
    assert.deepEqual(authHeaders({ Accept: '*/*' }, undefined), { Accept: '*/*' });
  });

  it('drops forged auth headers set by the page and keeps the rest', () => {
    const forged = {
      'authorization': bearer('forged'),
      'AUTHORIZATION': 'Basic forged',
      'user-role': 'ROLE_ADMIN',
      'USER-ROLE': 'ROLE_MOD',
      'x-jasper-key': 'guess',
      'User-Tag': '+user/chris',
    };
    assert.deepEqual(authHeaders(forged, 'jwt'), {
      'User-Tag': '+user/chris',
      'Authorization': bearer('jwt'),
    });
    assert.deepEqual(authHeaders(forged, undefined), { 'User-Tag': '+user/chris' });
  });
});

describe('beforeSendHeaders', () => {
  const forged = { 'Authorization': bearer('forged'), 'User-Role': 'ROLE_ADMIN' };

  it('authenticates trusted initiators', () => {
    for (const initiatorOrigin of [undefined, 'http://localhost:8082', 'http://127.0.0.1:8082']) {
      const { requestHeaders } = beforeSendHeaders({ requestHeaders: { ...forged }, initiatorOrigin }, '8082', () => 'jwt');
      assert.deepEqual(requestHeaders, { Authorization: bearer('jwt') }, initiatorOrigin);
    }
  });

  it('leaves untrusted initiators anonymous', () => {
    let calls = 0;
    const { requestHeaders } = beforeSendHeaders({ requestHeaders: { ...forged }, initiatorOrigin: 'https://example.com' }, '8082', () => {
      calls++;
      return 'jwt';
    });
    assert.deepEqual(requestHeaders, {});
    assert.equal(calls, 0);
  });

  it('fails closed when the token is unavailable', () => {
    const { requestHeaders } = beforeSendHeaders({ requestHeaders: { ...forged } }, '8082', () => {
      throw new Error('boom');
    });
    assert.deepEqual(requestHeaders, {});
  });
});

describe('register', () => {
  function webRequest() {
    const registered: { filter?: { urls: string[] }, listener?: Function } = {};
    const onBeforeSendHeaders = (filter: { urls: string[] }, listener: Function) => {
      registered.filter = filter;
      registered.listener = listener;
    };
    return { registered, webRequest: { onBeforeSendHeaders } as any };
  }

  function send(listener: Function, details: object) {
    let response: any;
    listener(details, (r: any) => response = r);
    return response;
  }

  it('registers on the client URLs, including ws', () => {
    const { registered, webRequest: wr } = webRequest();
    register(wr, '8082', () => 'jwt');
    assert.deepEqual(registered.filter!.urls, clientUrls('8082'));
    assert.ok(registered.filter!.urls.includes('ws://127.0.0.1:8082/*'));
    assert.deepEqual(send(registered.listener!, {
      url: 'ws://127.0.0.1:8082/api/v1/ws',
      requestHeaders: { Accept: '*/*', 'user-role': 'ROLE_ADMIN' },
    }), { requestHeaders: { Accept: '*/*', Authorization: bearer('jwt') } });
  });

  it('picks up refreshed tokens', () => {
    const { registered, webRequest: wr } = webRequest();
    let token = 'first';
    register(wr, '8082', () => token);
    assert.equal(send(registered.listener!, { requestHeaders: {} }).requestHeaders.Authorization, bearer('first'));
    token = 'second';
    assert.equal(send(registered.listener!, { requestHeaders: {} }).requestHeaders.Authorization, bearer('second'));
  });

  it('uses the new port when registered again', () => {
    const { registered, webRequest: wr } = webRequest();
    register(wr, '8082', () => 'jwt');
    register(wr, '9000', () => 'jwt');
    assert.deepEqual(registered.filter!.urls, clientUrls('9000'));
    assert.deepEqual(send(registered.listener!, { requestHeaders: {}, initiatorOrigin: 'http://localhost:8082' }), { requestHeaders: {} });
    assert.deepEqual(send(registered.listener!, { requestHeaders: {}, initiatorOrigin: 'http://localhost:9000' }), { requestHeaders: { Authorization: bearer('jwt') } });
  });
});
