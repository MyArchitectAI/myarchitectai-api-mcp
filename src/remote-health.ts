import type { PortalAccountOptions } from './portal-account.js';
import type { ResolveAccount } from './remote.js';

export type HostedHealthResult = Readonly<{
  status: 'ok' | 'unavailable';
  checks: Readonly<{ account: boolean; jwks: boolean; redis: boolean }>;
}>;

export type HostedHealthErrorEvent = Readonly<{
  fingerprint: 'remote.health.dependencies';
  check: 'account' | 'jwks' | 'redis' | 'deadline';
}>;

export type HostedHealthOptions = Readonly<{
  portal: PortalAccountOptions;
  resolveAccount: ResolveAccount;
  jwksUrl: string | URL;
  history: { ping(signal?: AbortSignal): Promise<void> };
  fetch?: typeof fetch;
  now?: () => number;
  /** A shorter synthetic-test deadline; production defaults to five seconds. */
  deadlineMs?: number;
  onError?: (event: HostedHealthErrorEvent) => void;
}>;

const DEADLINE_MS = 5_000;
const JWKS_MAX_BYTES = 65_536;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const advertised = response.headers.get('content-length');
  if ((advertised !== null && Number(advertised) > JWKS_MAX_BYTES) || !response.body) {
    throw new Error('Invalid JWKS response.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) {
      break;
    }
    size += part.value.byteLength;
    if (size > JWKS_MAX_BYTES) {
      void reader.cancel();
      throw new Error('JWKS response too large.');
    }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

/** A representative, explicitly bound account plus JWKS and Redis dependency probe. */
export const createHostedHealthCheck = (options: HostedHealthOptions):
  (signal?: AbortSignal) => Promise<HostedHealthResult> => {
  let jwksUrl: URL;
  try { jwksUrl = new URL(String(options.jwksUrl)); } catch { throw new TypeError('JWKS URL must be HTTPS.'); }
  if (jwksUrl.protocol !== 'https:' || jwksUrl.username || jwksUrl.password || jwksUrl.hash) {
    throw new TypeError('JWKS URL must be HTTPS.');
  }
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > DEADLINE_MS) {
    throw new RangeError('Health deadline must be between 1 and 5000 milliseconds.');
  }
  const selectedSubject = options.portal.keyBindings.keys().next().value;
  let cached: { result: HostedHealthResult; expiresAt: number } | undefined;
  let pending: Promise<HostedHealthResult> | undefined;

  const capture = (check: HostedHealthErrorEvent['check']): void => {
    try { options.onError?.({ fingerprint: 'remote.health.dependencies', check }); } catch { /* callback isolation */ }
  };

  const probe = async (callerSignal?: AbortSignal): Promise<{ result: HostedHealthResult; cancelled: boolean }> => {
    const checks = { account: false, jwks: false, redis: false };
    const controller = new AbortController();
    let cancelled = false;
    let resolveDeadline: () => void = () => undefined;
    const deadline = new Promise<void>((resolve) => { resolveDeadline = resolve; });
    const onCallerAbort = (): void => {
      cancelled = true;
      controller.abort();
      resolveDeadline();
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (callerSignal?.aborted) {
      onCallerAbort();
    }
    const timer = setTimeout(() => {
      controller.abort();
      capture('deadline');
      resolveDeadline();
    }, deadlineMs);
    const run = async (name: 'account' | 'jwks' | 'redis', action: () => Promise<boolean>): Promise<void> => {
      try {
        if (await action() && !controller.signal.aborted) {
          checks[name] = true;
        } else if (!controller.signal.aborted) {
          capture(name);
        }
      } catch {
        if (!controller.signal.aborted) {
          capture(name);
        }
      }
    };
    try {
      const work = Promise.all([
        run('account', async () => {
          if (!selectedSubject || !options.portal.keyBindings.has(selectedSubject)) {
            return false;
          }
          const account = await options.resolveAccount({ issuer: options.portal.issuer,
            subject: selectedSubject, clientId: 'health-check' }, { signal: controller.signal });
          return typeof account?.apiKey === 'string' && account.apiKey.length > 0;
        }),
        run('jwks', async () => {
          const response = await fetcher(jwksUrl, { method: 'GET', redirect: 'error',
            headers: { accept: 'application/json' }, signal: controller.signal });
          if (!response.ok) {
            return false;
          }
          const body = await readBoundedJson(response);
          return isRecord(body) && Array.isArray(body.keys) && body.keys.some((key: unknown) =>
            isRecord(key) && typeof key.kty === 'string' && key.kty.length > 0 &&
            typeof key.kid === 'string' && key.kid.length > 0);
        }),
        run('redis', async () => {
          await options.history.ping(controller.signal);
          return true;
        }),
      ]);
      await Promise.race([work, deadline]);
      const snapshot = Object.freeze({ ...checks });
      return { result: Object.freeze({ status: checks.account && checks.jwks && checks.redis ? 'ok' : 'unavailable',
        checks: snapshot }), cancelled };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  };

  return (signal?: AbortSignal): Promise<HostedHealthResult> => {
    if (signal?.aborted) {
      return Promise.resolve({ status: 'unavailable', checks: { account: false, jwks: false, redis: false } });
    }
    if (cached && now() < cached.expiresAt) {
      return Promise.resolve(cached.result);
    }
    if (pending) {
      return pending;
    }
    pending = probe(signal).then(({ result, cancelled }) => {
      if (!cancelled) {
        cached = { result, expiresAt: now() + (result.status === 'ok' ? 30_000 : 5_000) };
      }
      return result;
    }).finally(() => { pending = undefined; });
    return pending;
  };
};
