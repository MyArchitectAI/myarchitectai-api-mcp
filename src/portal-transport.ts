import { createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { ConfigError } from './errors.js';
import type { VerifiedIdentity } from './remote-auth.js';

export type PortalOptions = Readonly<{
  baseUrl: string;
  issuer: string;
  canonicalResource: string;
  signingSecret: string;
}>;
export type PortalDependencies = Readonly<{ portalFetch?: typeof fetch; now?: () => number }>;
export type PortalOperation = 'account' | 'execute' | 'health';

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REQUEST_BYTES = 1_000_000;

export const validatePortalOptions = (options: PortalOptions): void => {
  let origin: URL;
  try { origin = new URL(options.baseUrl); } catch { throw new ConfigError('PORTAL_BASE_URL must be an HTTPS origin'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port ||
      origin.pathname !== '/' || origin.search || origin.hash) {
    throw new ConfigError('PORTAL_BASE_URL must be an HTTPS origin');
  }
  if (options.signingSecret.length < 32 || options.signingSecret !== options.signingSecret.trim()) {
    throw new ConfigError('MCP_PORTAL_SIGNING_SECRET needs at least 32 characters');
  }
};

/** The internal assertion is distinct from the incoming, audience-bound OAuth token. */
export const createPortalRequest = (options: PortalOptions, dependencies: PortalDependencies = {}):
  ((operation: PortalOperation, body: Record<string, unknown>, identity: VerifiedIdentity | undefined,
    signal: AbortSignal) => Promise<Response>) => {
  validatePortalOptions(options);
  const fetcher = dependencies.portalFetch ?? fetch;
  const origin = new URL(options.baseUrl).origin;
  const signingKey = new TextEncoder().encode(options.signingSecret);
  return async (operation, body, identity, callerSignal) => {
    if (operation !== 'health' && (!identity || identity.issuer !== options.issuer ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identity.subject) || !identity.clientId.trim())) {
      throw new Error('Invalid Portal delegation identity');
    }
    if (operation === 'health' && identity) {
      throw new Error('Health delegation cannot contain a user');
    }
    const pathname = `/api/mcp/${operation}`;
    const rawBody = JSON.stringify(body);
    if (Buffer.byteLength(rawBody) > MAX_REQUEST_BYTES) { throw new Error('Portal request too large'); }
    const issuedAt = Math.floor((dependencies.now ?? Date.now)() / 1000);
    const assertion = await new SignJWT({
      request_hash: createHash('sha256').update(`POST\n${pathname}\n${rawBody}`).digest('hex'),
      ...(identity ? { oauth_issuer: identity.issuer, client_id: identity.clientId } : {}),
    }).setProtectedHeader({ alg: 'HS256', typ: 'mcp-portal+jwt' })
      .setIssuer(options.canonicalResource).setAudience(`${origin}/api/mcp`)
      .setSubject(identity?.subject ?? 'mcp-service').setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 60).setJti(randomUUID()).sign(signingKey);
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    callerSignal.addEventListener('abort', abort, { once: true });
    if (callerSignal.aborted) { abort(); }
    const timer = setTimeout(abort, operation === 'execute' ? 120_000 : 5_000);
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(new DOMException('Portal request aborted', 'AbortError')); };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) { onAbort(); }
    });
    try {
      const work = async (): Promise<Response> => {
        controller.signal.throwIfAborted();
        const response = await fetcher(`${origin}${pathname}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${assertion}`, 'content-type': 'application/json', accept: 'application/json' },
          body: rawBody,
        });
        if (response.redirected || response.status >= 300 && response.status < 400) {
          void response.body?.cancel();
          throw new Error('Portal redirects are not permitted');
        }
        return await boundedResponse(response, controller.signal);
      };
      return await Promise.race([work(), aborted]);
    } finally {
      clearTimeout(timer);
      callerSignal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  };
};

const boundedResponse = async (response: Response, signal: AbortSignal): Promise<Response> => {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel();
    throw new Error('Invalid Portal response');
  }
  const reader = response.body.getReader();
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    signal.throwIfAborted();
    let chunk = await reader.read();
    while (!chunk.done) {
      signal.throwIfAborted();
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { throw new Error('Portal response too large'); }
      chunks.push(chunk.value);
      chunk = await reader.read();
    }
    signal.throwIfAborted();
    const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    const retryAfter = response.headers.get('retry-after');
    if (response.status === 429 && retryAfter !== null) { headers.set('retry-after', retryAfter); }
    return new Response(Buffer.concat(chunks), { status: response.status, headers });
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
};
