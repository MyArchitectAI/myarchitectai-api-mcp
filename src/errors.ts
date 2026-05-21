/**
 * Typed error hierarchy for the MyArchitectAI MCP server.
 *
 * Every operational failure surfaces as a {@link MyArchitectAIError} so the
 * HTTP client can make retry decisions (`retryable`) and the tool layer can
 * render a useful message — including `balance`/`cost` when the API reports
 * them on a failed generation.
 */

export type ErrorKind =
  | 'config'
  | 'auth'
  | 'request'
  | 'rate_limit'
  | 'upstream'
  | 'network'
  | 'timeout';

export interface MyArchitectAIErrorOptions {
  kind: ErrorKind;
  status?: number | undefined;
  balance?: number | undefined;
  cost?: number | undefined;
  retryable?: boolean | undefined;
  retryAfterMs?: number | undefined;
  cause?: unknown;
}

/** Base class for all errors raised by this server. */
export class MyArchitectAIError extends Error {
  readonly kind: ErrorKind;
  readonly status: number | undefined;
  readonly balance: number | undefined;
  readonly cost: number | undefined;
  /** Whether the HTTP client may safely retry the request. */
  readonly retryable: boolean;
  /** Suggested delay before retrying, if the server provided one. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: MyArchitectAIErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.kind = options.kind;
    this.status = options.status;
    this.balance = options.balance;
    this.cost = options.cost;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Missing or invalid local configuration (e.g. no API key). Fatal at startup. */
export class ConfigError extends MyArchitectAIError {
  constructor(message: string) {
    super(message, { kind: 'config' });
  }
}

/** 401/403 — the API key is missing, malformed, or rejected. Not retryable. */
export class AuthError extends MyArchitectAIError {
  constructor(message: string) {
    super(message, { kind: 'auth', status: 403, retryable: false });
  }
}

/**
 * 400 — the request was rejected (invalid input or a processing error).
 * The API still reports `balance` and `cost` (cost is typically 0). Not retryable.
 */
export class RequestError extends MyArchitectAIError {
  constructor(message: string, balance?: number, cost?: number) {
    super(message, { kind: 'request', status: 400, retryable: false, balance, cost });
  }
}

/** 429 — rate limited. Retryable, honoring `Retry-After` when present. */
export class RateLimitError extends MyArchitectAIError {
  constructor(message: string, retryAfterMs?: number) {
    super(message, { kind: 'rate_limit', status: 429, retryable: true, retryAfterMs });
  }
}

/** 5xx or an unexpected status / malformed body. Retryable unless told otherwise. */
export class UpstreamError extends MyArchitectAIError {
  constructor(
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, {
      kind: 'upstream',
      status: options.status,
      retryable: options.retryable ?? true,
      cause: options.cause,
    });
  }
}

/** Transport-level failure (DNS, connection reset, etc.). Retryable. */
export class NetworkError extends MyArchitectAIError {
  constructor(message: string, cause?: unknown) {
    super(message, { kind: 'network', retryable: true, cause });
  }
}

/** The request exceeded the configured timeout and was aborted. Retryable. */
export class TimeoutError extends MyArchitectAIError {
  constructor(message: string) {
    super(message, { kind: 'timeout', retryable: true });
  }
}
