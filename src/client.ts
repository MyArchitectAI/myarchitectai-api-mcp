/**
 * HTTP client for the MyArchitectAI REST API.
 *
 * Responsibilities:
 *  - attach the `x-api-key` header and JSON content negotiation
 *  - enforce a per-request timeout via AbortController
 *  - retry transient failures (429/5xx/network/timeout) with exponential
 *    backoff + jitter, honoring `Retry-After`
 *  - map HTTP responses onto the typed error hierarchy in {@link ./errors.js}
 *
 * All endpoints share the same response contract, so a single
 * {@link MyArchitectAIClient.generate} method covers every tool.
 */

import type { Config } from './config.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import {
  AuthError,
  MyArchitectAIError,
  NetworkError,
  RateLimitError,
  RequestError,
  TimeoutError,
  UpstreamError,
} from './errors.js';

/** Normalized success payload returned by every generation endpoint. */
export interface GenerationResult {
  /** URLs of the generated image(s). */
  output: string[];
  /** Remaining account credit balance after the request. */
  balance: number;
  /** Credits charged for the request. */
  cost: number;
}

/** Minimal `fetch` signature so tests can inject a stub. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

export class MyArchitectAIClient {
  readonly #config: Config;
  readonly #fetch: FetchLike;

  constructor(config: Config, fetchImpl?: FetchLike) {
    this.#config = config;
    this.#fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * POST `body` to `path` (e.g. `/render/exterior`) and return the normalized
   * result, retrying transient failures up to `config.maxRetries` times.
   *
   * @throws {MyArchitectAIError} on a non-retryable failure or exhausted retries.
   */
  async generate(path: string, body: Record<string, unknown>): Promise<GenerationResult> {
    const url = `${this.#config.baseUrl}${path}`;
    let lastError: MyArchitectAIError | undefined;

    for (let attempt = 0; attempt <= this.#config.maxRetries; attempt++) {
      try {
        return await this.#attempt(url, body);
      } catch (err) {
        const error =
          err instanceof MyArchitectAIError
            ? err
            : new NetworkError(`Unexpected client error: ${describe(err)}`, err);
        lastError = error;

        if (!error.retryable || attempt >= this.#config.maxRetries) {
          throw error;
        }
        await sleep(backoffDelay(attempt, error.retryAfterMs));
      }
    }

    // Loop always returns or throws; this satisfies the type checker.
    throw lastError ?? new UpstreamError('Request failed without a recorded error.');
  }

  async #attempt(url: string, body: Record<string, unknown>): Promise<GenerationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': this.#config.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': `${SERVER_NAME}/${SERVER_VERSION}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new TimeoutError(
          `Request to ${url} timed out after ${this.#config.timeoutMs} ms.`,
        );
      }
      throw new NetworkError(`Network error calling ${url}: ${describe(err)}`, err);
    } finally {
      clearTimeout(timer);
    }

    return this.#handleResponse(response, url);
  }

  async #handleResponse(response: Response, url: string): Promise<GenerationResult> {
    const raw = await response.text();
    const parsed = safeJsonParse(raw);

    if (response.ok) {
      const result = asGenerationResult(parsed);
      if (!result) {
        throw new UpstreamError(
          `Malformed success response from ${url}: ${truncate(raw)}`,
          { status: response.status, retryable: false },
        );
      }
      return result;
    }

    switch (response.status) {
      case 400: {
        const errorBody = asErrorResponse(parsed);
        if (errorBody) {
          throw new RequestError(errorBody.error, errorBody.balance, errorBody.cost);
        }
        throw new RequestError(gatewayMessage(parsed) ?? `Bad request: ${truncate(raw)}`);
      }
      case 401:
      case 403:
        throw new AuthError(
          gatewayMessage(parsed) ??
            'Missing or invalid API key. Check the MYARCHITECTAI_API_KEY environment variable.',
        );
      case 429:
        throw new RateLimitError(
          gatewayMessage(parsed) ?? 'Rate limit exceeded.',
          parseRetryAfter(response.headers.get('retry-after')),
        );
      default: {
        const message =
          gatewayMessage(parsed) ??
          asErrorResponse(parsed)?.error ??
          `HTTP ${response.status}: ${truncate(raw)}`;
        throw new UpstreamError(message, {
          status: response.status,
          retryable: RETRYABLE_STATUS.has(response.status),
        });
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, capped, preferring a server hint. */
function backoffDelay(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, BACKOFF_MAX_MS);
  }
  const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function safeJsonParse(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Validate a 200 body against the `GenerationResponse` contract. */
function asGenerationResult(value: unknown): GenerationResult | undefined {
  if (!isRecord(value)) return undefined;
  const { output, balance, cost } = value;
  if (!Array.isArray(output) || !output.every((item) => typeof item === 'string')) {
    return undefined;
  }
  if (typeof balance !== 'number' || typeof cost !== 'number') return undefined;
  return { output: output as string[], balance, cost };
}

/** Parse a 400 body against the `ErrorResponse` contract. */
function asErrorResponse(
  value: unknown,
): { error: string; balance: number; cost: number } | undefined {
  if (!isRecord(value) || typeof value.error !== 'string') return undefined;
  return {
    error: value.error,
    balance: typeof value.balance === 'number' ? value.balance : 0,
    cost: typeof value.cost === 'number' ? value.cost : 0,
  };
}

/** Extract `message` from a gateway-style error body (`{ "message": "..." }`). */
function gatewayMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.message === 'string' ? value.message : undefined;
}

/** Parse a `Retry-After` header (delta-seconds or HTTP date) into milliseconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
