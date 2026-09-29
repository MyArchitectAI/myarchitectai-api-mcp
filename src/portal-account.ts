import { signedGetApiKeyRequest } from './aws-api-key.js';
import { DEFAULT_BASE_URL, type Config } from './config.js';
import { ConfigError } from './errors.js';
import type { ResolveAccount } from './remote.js';

export type PortalAccountOptions = Readonly<{
  issuer: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  keyBindings: ReadonlyMap<string, number>;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
}>;

export type PortalAccountDependencies = Readonly<{
  portalFetch?: typeof fetch;
  awsFetch?: typeof fetch;
  now?: () => Date;
  lookupTimeoutMs?: number;
}>;

const LOOKUP_TIMEOUT_MS = 5_000;
const PORTAL_RESPONSE_BYTES = 8_192;
const AWS_RESPONSE_BYTES = 65_536;

const isPositiveId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ensureActive = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new Error('Account lookup cancelled');
  }
};

const readBoundedJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  const advertised = response.headers.get('content-length');
  if (advertised !== null && Number(advertised) > maxBytes) {
    throw new Error('Account lookup response too large');
  }
  if (!response.body) {
    throw new Error('Account lookup response missing');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let next = await reader.read();
  while (!next.done) {
    bytes += next.value.byteLength;
    if (bytes > maxBytes) {
      void reader.cancel();
      throw new Error('Account lookup response too large');
    }
    chunks.push(next.value);
    next = await reader.read();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('Account lookup response invalid');
  }
};

const boundedJsonGet = async (
  fetcher: typeof fetch,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  maxBytes: number,
): Promise<unknown> => {
  ensureActive(signal);
  const response = await fetcher(url, { method: 'GET', headers, signal, redirect: 'error' });
  ensureActive(signal);
  if (!response.ok) {
    throw new Error('Account lookup unavailable');
  }
  const body = await readBoundedJson(response, maxBytes);
  ensureActive(signal);
  return body;
};

const withLookupDeadline = async <T>(
  signal: AbortSignal,
  timeoutMs: number,
  work: (boundedSignal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  let rejectDeadline: (error: Error) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const onAbort = (): void => {
    controller.abort();
    rejectDeadline(new Error('Account lookup cancelled'));
  };
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new Error('Account lookup timed out'));
  }, timeoutMs);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) {
      onAbort();
    }
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
};

/** Read only. The selected key is checked in both portal ownership and AWS on every request. */
export const createPortalAccountResolver = (
  options: PortalAccountOptions,
  dependencies: PortalAccountDependencies = {},
): ResolveAccount => {
  let portal: URL;
  try {
    portal = new URL(options.supabaseUrl);
  } catch {
    throw new ConfigError('Portal Supabase URL must be an HTTPS origin');
  }
  if (portal.protocol !== 'https:' || portal.pathname !== '/' || portal.search || portal.hash ||
      portal.username || portal.password || options.issuer !== `${portal.origin}/auth/v1`) {
    throw new ConfigError('Portal OAuth issuer must match the Portal Supabase origin');
  }
  const portalFetch = dependencies.portalFetch ?? fetch;
  const awsFetch = dependencies.awsFetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const timeoutMs = dependencies.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LOOKUP_TIMEOUT_MS) {
    throw new RangeError('Account lookup timeout must be 1–5000 milliseconds');
  }
  const portalHeaders = { apikey: options.serviceRoleKey, authorization: `Bearer ${options.serviceRoleKey}` };
  return async (identity, { signal }): Promise<Config | undefined> => {
    if (identity.issuer !== options.issuer || signal.aborted) {
      return undefined;
    }
    const selectedId = options.keyBindings.get(identity.subject);
    if (selectedId === undefined) {
      return undefined;
    }
    return withLookupDeadline(signal, timeoutMs, async (lookupSignal) => {
      const clientsUrl = new URL('/rest/v1/clients', options.supabaseUrl);
      clientsUrl.searchParams.set('select', 'id,user_id');
      clientsUrl.searchParams.set('user_id', `eq.${identity.subject}`);
      clientsUrl.searchParams.set('limit', '2');
      const clients = await boundedJsonGet(portalFetch, clientsUrl, portalHeaders, lookupSignal, PORTAL_RESPONSE_BYTES);
      if (!Array.isArray(clients) || clients.length > 2) {
        throw new Error('Portal account response invalid');
      }
      if (clients.length !== 1) {
        return undefined;
      }
      const client: unknown = clients[0];
      if (!isRecord(client) || !isPositiveId(client.id) || client.user_id !== identity.subject) {
        return undefined;
      }
      const keysUrl = new URL('/rest/v1/api_keys', options.supabaseUrl);
      keysUrl.searchParams.set('select', 'id,client_id,aws_key_id,deleted_at');
      keysUrl.searchParams.set('id', `eq.${selectedId}`);
      keysUrl.searchParams.set('client_id', `eq.${client.id}`);
      keysUrl.searchParams.set('deleted_at', 'is.null');
      keysUrl.searchParams.set('limit', '2');
      const keys = await boundedJsonGet(portalFetch, keysUrl, portalHeaders, lookupSignal, PORTAL_RESPONSE_BYTES);
      if (!Array.isArray(keys) || keys.length > 2) {
        throw new Error('Portal key response invalid');
      }
      if (keys.length !== 1) {
        return undefined;
      }
      const key: unknown = keys[0];
      if (!isRecord(key) || key.id !== selectedId || key.client_id !== client.id || key.deleted_at !== null ||
          typeof key.aws_key_id !== 'string' || !key.aws_key_id || key.aws_key_id.length > 256) {
        return undefined;
      }
      const aws = await signedGetApiKeyRequest(options, key.aws_key_id, now());
      const result = await boundedJsonGet(awsFetch, aws.url, aws.headers, lookupSignal, AWS_RESPONSE_BYTES);
      if (!isRecord(result) || result.id !== key.aws_key_id || result.enabled !== true ||
          typeof result.value !== 'string' || !result.value.trim() || result.value.trim() !== result.value) {
        return undefined;
      }
      return {
        apiKey: result.value,
        baseUrl: DEFAULT_BASE_URL,
        timeoutMs: 120_000,
        maxRetries: 2,
        downloadDir: 'renders',
        maxPreviewBytes: 1_000_000,
        stateFile: undefined,
      };
    });
  };
};
