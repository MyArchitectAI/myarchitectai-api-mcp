import { createServer, type Server } from 'node:http';
import type { JWTVerifyGetKey } from 'jose';
import { ConfigError } from './errors.js';
import { logEvent } from './logger.js';
import { instrumentExternalFetch } from './remote-observability.js';
import { createHostedHealthCheck } from './remote-health.js';
import { createPortalAccountResolver, createPortalHealthProbe, type PortalAccountDependencies,
  type PortalAccountOptions } from './portal-account.js';
import { validatePortalOptions } from './portal-transport.js';
import { UpstashRemoteSessionProvider, type UpstashRemoteHistoryOptions } from './remote-history.js';
import { createRemoteHandler, type RemoteServerOptions } from './remote.js';
import { validateRemoteHttpConfig, type RemoteHttpConfig } from './remote-config.js';
import type { RemoteSessionProvider } from './remote-session.js';

const DEFAULT_RESOURCE = 'https://mcp.myarchitectai.com/mcp';
const HISTORY_NAMESPACE = 'myarchitectai:mcp:production';

export type HostedConfig = Readonly<{
  auth: RemoteHttpConfig;
  portal: PortalAccountOptions;
  history: UpstashRemoteHistoryOptions;
}>;

const required = (value: string | undefined, name: string): string => {
  if (!value || !value.trim() || value !== value.trim()) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
};

const jsonArray = (raw: string | undefined, name: string, optional = false): string[] => {
  if (raw === undefined && optional) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(required(raw, name)) as unknown;
  } catch {
    throw new ConfigError(`${name} must be a JSON array of strings`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' ||
      !item || item !== item.trim()) || new Set(value).size !== value.length) {
    throw new ConfigError(`${name} must be a JSON array of unique nonempty strings`);
  }
  return value as string[];
};

const portalOrigin = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('PORTAL_SUPABASE_URL must be an HTTPS origin');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash || url.port) {
    throw new ConfigError('PORTAL_SUPABASE_URL must be an HTTPS origin');
  }
  return url.origin;
};

/** Hosted startup is explicit: no billing mode, account or credential fallback. */
export const parseHostedConfig = (env: NodeJS.ProcessEnv): HostedConfig => {
  if (env.MCP_BILLING_MODE !== 'api-balance') {
    throw new ConfigError('MCP_BILLING_MODE must explicitly be api-balance');
  }
  const supabaseUrl = portalOrigin(required(env.PORTAL_SUPABASE_URL, 'PORTAL_SUPABASE_URL'));
  const issuer = `${supabaseUrl}/auth/v1`;
  const revision = required(env.MCP_DEPLOYMENT_REVISION, 'MCP_DEPLOYMENT_REVISION');
  const auth: RemoteHttpConfig = {
    canonicalResource: env.MCP_CANONICAL_RESOURCE ?? DEFAULT_RESOURCE,
    issuer,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    allowedOAuthClientIds: jsonArray(env.MCP_OAUTH_CLIENT_IDS, 'MCP_OAUTH_CLIENT_IDS'),
    allowedHosts: jsonArray(env.MCP_ALLOWED_HOSTS, 'MCP_ALLOWED_HOSTS', true),
    allowedOrigins: jsonArray(env.MCP_ALLOWED_ORIGINS, 'MCP_ALLOWED_ORIGINS', true),
    ...(env.OBS_HEALTH_TOKEN === undefined ? {} : { healthToken: env.OBS_HEALTH_TOKEN }),
    deploymentRevision: revision,
  };
  validateRemoteHttpConfig(auth);
  const portal: PortalAccountOptions = {
    issuer,
    baseUrl: required(env.PORTAL_BASE_URL, 'PORTAL_BASE_URL'),
    canonicalResource: auth.canonicalResource,
    signingSecret: required(env.MCP_PORTAL_SIGNING_SECRET, 'MCP_PORTAL_SIGNING_SECRET'),
  };
  validatePortalOptions(portal);
  const history: UpstashRemoteHistoryOptions = {
    restUrl: required(env.UPSTASH_REDIS_REST_URL, 'UPSTASH_REDIS_REST_URL'),
    restToken: required(env.UPSTASH_REDIS_REST_TOKEN, 'UPSTASH_REDIS_REST_TOKEN'),
    keySecret: required(env.MCP_HISTORY_KEY_SECRET, 'MCP_HISTORY_KEY_SECRET'),
    namespace: HISTORY_NAMESPACE,
    ttlSeconds: 1_800,
    maxRecordsPerUser: 100,
  };
  return { auth, portal, history };
};

/** Dependency overrides are for synthetic local verification; production uses the defaults. */
export type HostedServerDependencies = PortalAccountDependencies & Readonly<{
  registerWork: (work: Promise<void>) => void;
  jwks?: JWTVerifyGetKey;
  sessions?: RemoteSessionProvider;
  checkHealth?: RemoteServerOptions['checkHealth'];
  createMedia?: RemoteServerOptions['createMedia'];
}>;

export const createHostedServer = (env: NodeJS.ProcessEnv, dependencies: HostedServerDependencies): Server => {
  const config = parseHostedConfig(env);
  const portalFetch = instrumentExternalFetch(dependencies.portalFetch ?? fetch,
    { vendor: 'api_portal', operation: 'mcp_bridge', timeoutMs: 120_000, maxAttempts: 1 });
  const sessions = dependencies.sessions ?? new UpstashRemoteSessionProvider({
    ...config.history,
    fetch: instrumentExternalFetch(fetch,
      { vendor: 'upstash_redis', operation: 'history_command', timeoutMs: 5_000, maxAttempts: 1 }),
    onError: ({ fingerprint, operation }) => {
      logEvent({ event: 'remote_history_error', outcome: 'error', fingerprint, operation });
    },
  });
  const resolveAccount = createPortalAccountResolver(config.portal, { ...dependencies, portalFetch });
  const checkHealth = dependencies.checkHealth ?? (sessions instanceof UpstashRemoteSessionProvider
    ? createHostedHealthCheck({ checkAccount: createPortalHealthProbe(config.portal, { ...dependencies, portalFetch }),
      jwksUrl: config.auth.jwksUrl as string, history: sessions,
      fetch: instrumentExternalFetch(fetch,
        { vendor: 'supabase_jwks', operation: 'jwks_probe', timeoutMs: 5_000, maxAttempts: 1 }),
      onError: ({ fingerprint, check }) => {
        logEvent({ event: 'remote_health_error', outcome: 'error', fingerprint, check });
      } }) : undefined);
  const handler = createRemoteHandler({
    auth: { ...config.auth, ...(dependencies.jwks ? { jwks: dependencies.jwks } : {}) },
    resolveAccount,
    sessions,
    ...(checkHealth ? { checkHealth } : {}),
    ...(dependencies.createMedia ? { createMedia: dependencies.createMedia } : {}),
    onError: ({ fingerprint, requestId, route, status }) => {
      logEvent({ event: 'remote_request_error', outcome: 'error', fingerprint,
        request_id: requestId, 'http.route': route, 'http.response.status_code': status });
    },
  });
  return createServer((request, response) => {
    let startWork: () => void = () => undefined;
    const admission = new Promise<void>((resolve) => { startWork = resolve; });
    let registered = false;
    const work = admission.then(async () => {
      if (registered) {
        await handler(request, response);
      }
    });
    void work.catch(() => {
      logEvent({ event: 'remote_handler_failure', outcome: 'error', fingerprint: 'remote.request' });
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
    try {
      dependencies.registerWork(work);
      registered = true;
    } catch {
      logEvent({ event: 'remote_lifecycle_failure', outcome: 'error', fingerprint: 'remote.lifecycle' });
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: 'Service unavailable' }));
      }
    } finally {
      startWork();
    }
  });
};
