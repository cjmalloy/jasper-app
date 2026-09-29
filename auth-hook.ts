/**
 * Authorization layer for the Jasper window.
 *
 * The client container only listens on 127.0.0.1 and rejects requests without the per-launch
 * X-Jasper-Key, and the server trusts the User-Role header. This hook is the only thing that adds
 * them, so only the Electron window can use the client, and only it can escalate to admin.
 *
 * No runtime Electron imports, so it can be unit tested with node:test.
 */
import type {
  BeforeSendResponse,
  OnBeforeSendHeadersListenerDetails,
  OnCompletedListenerDetails,
  WebRequest,
} from 'electron';

export const CLIENT_KEY_HEADER = 'X-Jasper-Key';
export const USER_ROLE_HEADER = 'User-Role';
export const ADMIN_ROLE = 'ROLE_ADMIN';
/** Same endpoint jasper-ui uses to load the current user's roles */
export const WHOAMI_PATH = '/api/v1/user/whoami';

/** Role flags in the whoami response (RolesDto). Roles are already expanded by the role hierarchy. */
const ROLE_FLAGS = ['admin', 'mod', 'editor', 'user', 'viewer', 'banned'];

export function clientOrigins(port: string | number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/** webRequest URL filter for the client, including WebSocket upgrades */
export function clientUrls(port: string | number): string[] {
  return [
    `http://localhost:${port}/*`,
    `http://127.0.0.1:${port}/*`,
    `ws://localhost:${port}/*`,
    `ws://127.0.0.1:${port}/*`,
  ];
}

/**
 * Whether the window needs User-Role: ROLE_ADMIN, given the whoami response for a request
 * without it. Only true when the server positively reports no role at all, which means the
 * +user User has no role or has ROLE_ANONYMOUS. Anything unexpected fails closed.
 */
export function needsAdmin(roles: unknown): boolean {
  if (!roles || typeof roles !== 'object') return false;
  const dto = roles as Record<string, unknown>;
  return ROLE_FLAGS.every(flag => dto[flag] === false);
}

/**
 * Requests started by the Jasper UI itself, or by the browser (no initiator, ex. window navigation).
 * Anything else, like an embedded third party iframe, is treated as anonymous.
 */
export function isTrustedInitiator(initiatorOrigin: string | undefined, port: string | number): boolean {
  return initiatorOrigin === undefined || clientOrigins(port).includes(initiatorOrigin);
}

/** Always add the client key, and User-Role only when admin. Values set by the page are dropped. */
export function authHeaders(headers: Record<string, string>, clientKey: string, admin: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === CLIENT_KEY_HEADER.toLowerCase() || lower === USER_ROLE_HEADER.toLowerCase()) continue;
    result[name] = headers[name];
  }
  result[CLIENT_KEY_HEADER] = clientKey;
  if (admin) result[USER_ROLE_HEADER] = ADMIN_ROLE;
  return result;
}

/** A successful change to a User (or SCIM profile) may change the roles of +user */
export function isUserSave(details: { method: string, url: string, statusCode: number }): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(details.method.toUpperCase())) return false;
  if (details.statusCode < 200 || details.statusCode >= 300) return false;
  let pathname: string;
  try {
    pathname = new URL(details.url).pathname;
  } catch {
    return false;
  }
  return ['/api/v1/user', '/api/v1/profile'].some(p => pathname === p || pathname.startsWith(p + '/'));
}

export function isDenied(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403;
}

export interface ClientAuthOptions {
  /** Per-launch secret required by the client container */
  clientKey: string;
  /** Current client port */
  port: () => string | number;
  /** Fetch whoami through the client as the window would, but without User-Role. Rejects on errors. */
  whoami: () => Promise<unknown>;
  /** Minimum time between checks triggered by 403 responses */
  cooldownMs?: number;
  now?: () => number;
}

export class ClientAuth {
  /** Fail closed: no User-Role until a check succeeds */
  needsAdmin = false;

  private readonly opts: ClientAuthOptions;
  private running?: Promise<boolean>;
  private again = false;
  private lastCheck = -Infinity;

  constructor(opts: ClientAuthOptions) {
    this.opts = opts;
  }

  /**
   * Recompute needsAdmin. Resolves with whether the server answered, never rejects.
   * If the check fails needsAdmin is false. Calls during a running check share it
   * and run one more check afterwards, so a save is never missed.
   */
  refresh(): Promise<boolean> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.lastCheck = this.now();
    this.running = Promise.resolve()
      .then(() => this.opts.whoami())
      .then(roles => {
        this.needsAdmin = needsAdmin(roles);
        return true;
      }, () => {
        this.needsAdmin = false;
        return false;
      })
      .then(answered => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.refresh();
        }
        return answered;
      });
    return this.running;
  }

  beforeSendHeaders(details: Pick<OnBeforeSendHeadersListenerDetails, 'requestHeaders' | 'initiatorOrigin'>): BeforeSendResponse {
    const admin = this.needsAdmin && isTrustedInitiator(details.initiatorOrigin, this.opts.port());
    return { requestHeaders: authHeaders(details.requestHeaders, this.opts.clientKey, admin) };
  }

  completed(details: Pick<OnCompletedListenerDetails, 'method' | 'url' | 'statusCode'>): void {
    if (isUserSave(details)) {
      this.refresh();
    } else if (isDenied(details.statusCode) && !this.running &&
        this.now() - this.lastCheck >= (this.opts.cooldownMs ?? 5000)) {
      this.refresh();
    }
  }

  /** Register on a session. Replaces any previous registration, so call again when the port changes. */
  register(webRequest: Pick<WebRequest, 'onBeforeSendHeaders' | 'onCompleted'>): void {
    const filter = { urls: clientUrls(this.opts.port()) };
    webRequest.onBeforeSendHeaders(filter, (details, callback) => callback(this.beforeSendHeaders(details)));
    webRequest.onCompleted(filter, details => this.completed(details));
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}
