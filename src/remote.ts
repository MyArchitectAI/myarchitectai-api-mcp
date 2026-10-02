import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JWTVerifyGetKey } from 'jose';
import { MyArchitectAIClient, type ApiClient } from './client.js';
import { SERVER_NAME, SERVER_VERSION, type Config } from './config.js';
import { ConfigError } from './errors.js';
import { logEvent } from './logger.js';
import { createRemoteAuthenticator, RemoteAuthenticationUnavailableError,
  type VerifiedIdentity } from './remote-auth.js';
import { validateRemoteHttpConfig, type RemoteHttpConfig } from './remote-config.js';
import { registerTools } from './tools.js';

/** Hosted accounts use a Portal client without possessing database or API credentials. */
export type RemoteAccount = Config | { client: ApiClient };

export type ResolveAccount = (
  identity: VerifiedIdentity,
  context: { signal: AbortSignal },
) => RemoteAccount | undefined | Promise<RemoteAccount | undefined>;
export type RemoteErrorEvent = {
  fingerprint: 'remote.auth' | 'remote.account_lookup' | 'remote.request' | 'remote.timeout' | 'remote.health';
  route: '/mcp' | '/health/deep';
  status: number;
  requestId: string;
};

export type RemoteServerOptions = {
  auth: RemoteHttpConfig & { jwks?: JWTVerifyGetKey };
  resolveAccount: ResolveAccount;
  createClient?: (config: Config) => MyArchitectAIClient;
  onError?: (event: RemoteErrorEvent) => void;
  checkHealth?: (signal?: AbortSignal) => Promise<{
    status: 'ok' | 'unavailable';
    checks: { account: boolean; jwks: boolean };
  }>;
};

class RequestBodyError extends Error {
  constructor(readonly status: number) {
    super('Invalid request body');
  }
}

const sendJson = (response: ServerResponse, status: number, body: Record<string, unknown>): void => {
  if (response.headersSent || response.writableEnded || response.destroyed) {
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

const methodNotAllowed = (response: ServerResponse, allow: 'GET' | 'POST'): void => {
  response.setHeader('allow', allow);
  sendJson(response, 405, { error: 'Method not allowed' });
};

const healthTokenMatches = (expected: string | undefined, provided: string | string[] | undefined): boolean => {
  if (!expected || typeof provided !== 'string') {
    return false;
  }
  const expectedDigest = createHash('sha256').update(expected).digest();
  const providedDigest = createHash('sha256').update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
};

const readJsonBody = (request: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let length = 0;
  let complete = false;
  const cleanup = (): void => {
    request.off('data', onData);
    request.off('end', onEnd);
    request.off('error', onError);
    request.off('aborted', onAborted);
    signal.removeEventListener('abort', onAborted);
  };
  const fail = (error: RequestBodyError): void => {
    if (complete) {
      return;
    }
    complete = true;
    cleanup();
    request.resume();
    reject(error);
  };
  const onData = (chunk: Buffer): void => {
    length += chunk.length;
    if (length > maxBytes) {
      fail(new RequestBodyError(413));
      return;
    }
    chunks.push(chunk);
  };
  const onEnd = (): void => {
    if (complete) {
      return;
    }
    complete = true;
    cleanup();
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
    } catch {
      reject(new RequestBodyError(400));
    }
  };
  const onError = (): void => {
    fail(new RequestBodyError(400));
  };
  const onAborted = (): void => {
    fail(new RequestBodyError(400));
  };
  request.on('data', onData);
  request.on('end', onEnd);
  request.on('error', onError);
  request.on('aborted', onAborted);
  signal.addEventListener('abort', onAborted, { once: true });
  if (signal.aborted) {
    onAborted();
  }
});

const safeHost = (value: string | undefined): string | undefined => {
  if (!value || /[\s,/@]/.test(value)) {
    return undefined;
  }
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const awaitUntilAbort = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(new Error('Request aborted'));
    return;
  }
  const onAbort = (): void => {
    signal.removeEventListener('abort', onAbort);
    reject(new Error('Request aborted'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  work.then(
    (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
    (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(error instanceof Error ? error : new Error('Request failed'));
    },
  );
});

export type RemoteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export const createRemoteHandler = (options: RemoteServerOptions): RemoteHandler => {
  if (typeof options.resolveAccount !== 'function') {
    throw new ConfigError('resolveAccount is required for remote MCP');
  }
  const config = validateRemoteHttpConfig(options.auth);
  const authenticate = createRemoteAuthenticator(config, options.auth.jwks);
  const createClient = options.createClient ?? ((account: Config) => new MyArchitectAIClient(account));
  let activeRequests = 0;
  const capture = (event: RemoteErrorEvent): void => {
    try {
      options.onError?.(event);
    } catch {
      logEvent({ event: 'remote_error_callback_failure', request_id: event.requestId,
        'http.route': event.route, 'http.response.status_code': event.status,
        outcome: 'error', fingerprint: event.fingerprint });
    }
  };

  return async (request, response) => {
    const started = Date.now();
    const requestId = randomUUID();
    response.setHeader('x-request-id', requestId);
    const path = (() => {
      try { return new URL(request.url ?? '/', 'http://localhost').pathname; }
      catch { return '/invalid'; }
    })();
    let route: '/mcp' | '/health' | '/health/deep' | '/.well-known/oauth-protected-resource' | '/unknown' = '/unknown';
    if (path === config.mcpPath) {
      route = '/mcp';
    } else if (path === '/health') {
      route = '/health';
    } else if (path === '/health/deep') {
      route = '/health/deep';
    } else if (path === '/.well-known/oauth-protected-resource' || path === config.metadataPath) {
      route = '/.well-known/oauth-protected-resource';
    }
    let logged = false;
    const logCompletion = (): void => {
      if (logged) {
        return;
      }
      logged = true;
      const disconnected = !response.writableFinished && response.statusCode !== 504;
      const status = disconnected ? 499 : response.statusCode;
      const outcome = disconnected ? 'disconnected' : status >= 500 ? 'error' : status >= 400 ? 'rejected' : 'success';
      logEvent({ event: 'remote_http_request', request_id: requestId,
        'http.request.method': request.method ?? 'UNKNOWN', 'http.route': route,
        'http.response.status_code': status, duration_ms: Date.now() - started, outcome });
    };
    response.once('finish', logCompletion);
    response.once('close', logCompletion);
    const abortController = new AbortController();
    const isAdmissionAborted = (): boolean => abortController.signal.aborted;
    response.once('close', () => {
      if (!response.writableFinished) {
        abortController.abort();
      }
    });
    const processRequest = async (): Promise<void> => {
      const hostHeaders = request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'host');
      if (hostHeaders.length !== 1 || !config.allowedHosts.has(safeHost(request.headers.host) ?? '')) {
        sendJson(response, 400, { error: 'Invalid host' });
        return;
      }
      const origin = request.headers.origin;
      if (origin !== undefined && (typeof origin !== 'string' || !config.allowedOrigins.has(origin))) {
        sendJson(response, 403, { error: 'Origin forbidden' });
        return;
      }
      if (route === '/health' || route === '/health/deep') {
        if (request.method !== 'GET') {
          methodNotAllowed(response, 'GET');
          return;
        }
        if (route === '/health/deep') {
          if (!healthTokenMatches(config.healthToken, request.headers['x-obs-token']) || !options.checkHealth) {
            sendJson(response, 404, { error: 'Not found' });
            return;
          }
          try {
            const result = await options.checkHealth(abortController.signal);
            sendJson(response, result.status === 'ok' ? 200 : 503,
              { status: result.status, scope: 'dependencies', checks: result.checks });
          } catch {
            capture({ fingerprint: 'remote.health', route: '/health/deep', status: 503, requestId });
            sendJson(response, 503, { status: 'unavailable', scope: 'dependencies',
              checks: { account: false, jwks: false } });
          }
          return;
        }
        sendJson(response, 200, { status: 'ok', scope: 'process',
          ...(config.deploymentRevision === undefined ? {} : { revision: config.deploymentRevision }) });
        return;
      }
      if (route === '/.well-known/oauth-protected-resource') {
        if (request.method !== 'GET') {
          methodNotAllowed(response, 'GET');
          return;
        }
        sendJson(response, 200, {
          resource: config.canonicalResource,
          authorization_servers: [config.issuer],
          scopes_supported: ['openid'],
        });
        return;
      }
      if (route !== '/mcp') {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      if (request.method !== 'POST') {
        methodNotAllowed(response, 'POST');
        return;
      }
      if (request.url !== config.mcpPath) {
        sendJson(response, 400, { error: 'Invalid request target' });
        return;
      }
      if (activeRequests >= config.maxConcurrentRequests) {
        sendJson(response, 503, { error: 'Server busy' });
        return;
      }
      activeRequests++;
      let dispatchStarted = false;
      const timer = setTimeout(() => {
        abortController.abort();
        if (!response.writableEnded) {
          capture({ fingerprint: 'remote.timeout', route: '/mcp', status: 504, requestId });
          if (dispatchStarted) {
            // Once the SDK owns the response, a 504 body races its final JSON
            // write. End the socket while the admitted paid tool settles.
            response.statusCode = 504;
            response.destroy();
          } else {
            sendJson(response, 504, { error: 'Request timeout' });
          }
        }
      }, config.requestTimeoutMs);
      try {
        if (isAdmissionAborted()) {
          return;
        }
        let identity: VerifiedIdentity;
        try {
          identity = await awaitUntilAbort(authenticate(request), abortController.signal);
        } catch (error) {
          if (isAdmissionAborted()) {
            return;
          }
          if (error instanceof RemoteAuthenticationUnavailableError) {
            capture({ fingerprint: 'remote.auth', route: '/mcp', status: 503, requestId });
            sendJson(response, 503, { error: 'Authentication unavailable' });
            return;
          }
          response.setHeader('www-authenticate', `Bearer resource_metadata="${config.metadataUrl}", scope="openid"`);
          sendJson(response, 401, { error: 'Unauthorized' });
          return;
        }
        if (isAdmissionAborted()) {
          return;
        }
        const contentType = request.headers['content-type'];
        if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
          sendJson(response, 415, { error: 'Content type must be application/json' });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(request, config.maxBodyBytes, abortController.signal);
        } catch (error) {
          if (isAdmissionAborted()) {
            return;
          }
          const status = error instanceof RequestBodyError ? error.status : 400;
          sendJson(response, status, { error: status === 413 ? 'Request body too large' : 'Malformed JSON' });
          return;
        }
        if (isAdmissionAborted()) {
          return;
        }
        let account: RemoteAccount | undefined;
        try {
          account = await awaitUntilAbort(Promise.resolve(options.resolveAccount(identity, {
            signal: abortController.signal,
          })), abortController.signal);
        } catch {
          if (isAdmissionAborted()) {
            return;
          }
          capture({ fingerprint: 'remote.account_lookup', route: '/mcp', status: 503, requestId });
          sendJson(response, 503, { error: 'Account lookup unavailable' });
          return;
        }
        if (isAdmissionAborted()) {
          return;
        }
        if (!account || (!('client' in account) && !account.apiKey.trim())) {
          sendJson(response, 403, { error: 'Account not linked' });
          return;
        }
        const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
        // The 1.29 SDK types conflict with exactOptionalPropertyTypes; omitting
        // sessionIdGenerator is its documented stateless runtime mode.
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        try {
          if (isAdmissionAborted()) {
            return;
          }
          const client = 'client' in account ? account.client : createClient(account);
          registerTools(server, { client, mode: 'remote' });
          if (isAdmissionAborted()) {
            return;
          }
          await server.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
          if (isAdmissionAborted()) {
            return;
          }
          dispatchStarted = true;
          await transport.handleRequest(request, response, body);
        } finally {
          await server.close();
        }
      } catch {
        capture({ fingerprint: 'remote.request', route: '/mcp', status: 500, requestId });
        sendJson(response, 500, { error: 'Internal server error' });
      } finally {
        clearTimeout(timer);
        activeRequests--;
      }
    };
    await processRequest().catch(() => {
      if (route === '/mcp') {
        capture({ fingerprint: 'remote.request', route: '/mcp', status: 500, requestId });
      }
      sendJson(response, 500, { error: 'Internal server error' });
    });
  };
};

export const createRemoteServer = (options: RemoteServerOptions): Server => {
  const handler = createRemoteHandler(options);
  return createServer((request, response) => {
    void handler(request, response).catch(() => {
      logEvent({ event: 'remote_http_unhandled_error', fingerprint: 'remote.request' });
      sendJson(response, 500, { error: 'Internal server error' });
    });
  });
};
