import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { logEvent } from './logger.js';

export type ExternalFetchOptions = Readonly<{
  vendor: 'portal_supabase' | 'aws_api_gateway' | 'upstash_redis' | 'supabase_jwks';
  operation: string;
  /** The caller enforces this deadline through response-body consumption. */
  timeoutMs: number;
  maxAttempts: number;
}>;

type EmitEvent = typeof logEvent;

/** Observes one external attempt without changing fetch semantics. Callers own deadlines through body consumption. */
export const instrumentExternalFetch = (
  fetchImpl: typeof fetch,
  options: ExternalFetchOptions,
  emit: EmitEvent = logEvent,
): typeof fetch => {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(options.operation) ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.maxAttempts !== 1) {
    throw new Error('Invalid external fetch instrumentation policy');
  }
  return async (input, init) => {
    const requestId = randomUUID();
    const started = performance.now();
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      emit({ event: 'remote_external_fetch', vendor: options.vendor, operation: options.operation,
        request_id: requestId, duration_ms: Math.round(performance.now() - started),
        timeout_ms: options.timeoutMs, max_attempts: 1, outcome: 'server_error',
        fingerprint: `remote.external.${options.vendor}.${options.operation}` });
      throw error;
    }
    let outcome: 'ok' | 'client_error' | 'server_error';
    if (response.ok) {
      outcome = 'ok';
    } else if (response.status >= 400 && response.status < 500) {
      outcome = 'client_error';
    } else {
      outcome = 'server_error';
    }
    emit({ event: 'remote_external_fetch', vendor: options.vendor, operation: options.operation,
      request_id: requestId, 'http.response.status_code': response.status,
      duration_ms: Math.round(performance.now() - started), timeout_ms: options.timeoutMs,
      max_attempts: 1, outcome });
    return response;
  };
};
