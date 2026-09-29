/**
 * Authorization layer for the Jasper window.
 *
 * The window authenticates with a JWT signed with the per-launch HMAC key that only the server and
 * the Electron main process know. This hook is the only thing that adds it, so only the Electron
 * window is admin. Anything else reaching the client (browser tabs, other processes) is anonymous.
 *
 * No runtime Electron imports, so it can be unit tested with node:test.
 */
import type { BeforeSendResponse, OnBeforeSendHeadersListenerDetails, WebRequest } from 'electron';

export const AUTHORIZATION_HEADER = 'Authorization';
/** Headers the page may never set on requests to the client */
const STRIPPED_HEADERS = [AUTHORIZATION_HEADER, 'User-Role', 'X-Jasper-Key'].map(h => h.toLowerCase());
/** Same endpoint jasper-ui uses to load the current user's roles */
export const WHOAMI_PATH = '/api/v1/user/whoami';

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
 * Requests started by the Jasper UI itself, or by the browser (no initiator, ex. window navigation).
 * Anything else, like an embedded third party iframe, is treated as anonymous.
 */
export function isTrustedInitiator(initiatorOrigin: string | undefined, port: string | number): boolean {
  return initiatorOrigin === undefined || clientOrigins(port).includes(initiatorOrigin);
}

/** Drop auth headers set by the page, and add the window token for trusted initiators only. */
export function authHeaders(headers: Record<string, string>, token: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    if (STRIPPED_HEADERS.includes(name.toLowerCase())) continue;
    result[name] = headers[name];
  }
  if (token) result[AUTHORIZATION_HEADER] = 'Bearer ' + token;
  return result;
}

export function beforeSendHeaders(
  details: Pick<OnBeforeSendHeadersListenerDetails, 'requestHeaders' | 'initiatorOrigin'>,
  port: string | number,
  getToken: () => string,
): BeforeSendResponse {
  let token: string | undefined;
  try {
    if (isTrustedInitiator(details.initiatorOrigin, port)) token = getToken();
  } catch {
    // Fail closed: send the request anonymously
  }
  return { requestHeaders: authHeaders(details.requestHeaders, token) };
}

/**
 * Register on a session. Replaces any previous registration, so call again when the port changes.
 * The token getter is called for every request, so refreshed tokens are picked up.
 */
export function register(webRequest: Pick<WebRequest, 'onBeforeSendHeaders'>, port: string | number, getToken: () => string): void {
  webRequest.onBeforeSendHeaders({ urls: clientUrls(port) },
    (details, callback) => callback(beforeSendHeaders(details, port, getToken)));
}
