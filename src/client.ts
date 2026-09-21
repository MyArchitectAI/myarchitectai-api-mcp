/**
 * HTTP client for the MyArchitectAI REST API.
 *
 * Responsibilities:
 *  - attach the `x-api-key` header and JSON content negotiation
 *  - enforce a per-request timeout via AbortController
 *  - retry documented uncharged failures (429/502), and transient balance
 *    lookup failures, with backoff inside one total timeout budget
 *  - map HTTP responses onto the typed error hierarchy in {@link ./errors.js}
 *
 * Image/video outputs normalize to arrays; prompt text and live balance use
 * their own response decoders.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { logEvent } from './logger.js';
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
  /** Remaining account balance in USD after the request. */
  balance: number;
  /** USD charged for the request. */
  cost: number;
  requestId?: number;
}

export type AutoPromptResult = Omit<GenerationResult, 'output'> & { output: string };
export type BalanceResult = { balance: number };

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
   * result, retrying only documented uncharged responses up to `maxRetries`.
   *
   * @throws {MyArchitectAIError} on a non-retryable failure or exhausted retries.
   */
  async generate(path: string, body: Record<string, unknown>): Promise<GenerationResult> {
    return this.#request(path, body, asGenerationResult);
  }

  async autoPrompt(body: Record<string, unknown>): Promise<AutoPromptResult> {
    return this.#request('/auto-prompt', body, (value) => {
      if (!isRecord(value) || typeof value.output !== 'string') {
        return undefined;
      }
      const result = asGenerationResult(value);
      return result ? { ...result, output: value.output } : undefined;
    });
  }

  async balance(): Promise<BalanceResult> {
    return this.#request('/balance', undefined, (value) => {
      if (!isRecord(value) || typeof value.balance !== 'number' || !Number.isFinite(value.balance)) {
        return undefined;
      }
      return { balance: value.balance };
    });
  }

  async #request<T>(path: string, body: Record<string, unknown> | undefined, parse: (value: unknown) => T | undefined): Promise<T> {
    const url = `${this.#config.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    const timeout = (): TimeoutError => new TimeoutError(`Request exceeded its ${this.#config.timeoutMs} ms total budget (including retries and response body).`);
    try {
      for (let attempt = 0; ; attempt++) {
        if (controller.signal.aborted) {
          throw timeout();
        }
        try {
          return await this.#attempt(url, path, body, parse, controller.signal);
        } catch (err) {
          const error = err instanceof MyArchitectAIError ? err : new NetworkError(`Unexpected client error: ${describe(err)}`, err);
          // Only these paid-request failures are explicitly documented as never
          // charged. Balance is read-only; other uncertain outcomes are not replayed.
          const canRetry = path === '/balance' || error.status === 429 || error.status === 502;
          if (controller.signal.aborted) {
            throw timeout();
          }
          if (!canRetry || !error.retryable || attempt >= this.#config.maxRetries) {
            throw error;
          }
          await delay(backoffDelay(attempt, error.retryAfterMs), undefined, { signal: controller.signal });
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        throw timeout();
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async #attempt<T>(url: string, path: string, body: Record<string, unknown> | undefined, parse: (value: unknown) => T | undefined, signal: AbortSignal): Promise<T> {
    const started = Date.now();
    let status: number | undefined;

    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': this.#config.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': `${SERVER_NAME}/${SERVER_VERSION}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      status = response.status;
      const result = await this.#handleResponse(response, url, parse);
      logEvent({ event: 'api_request', endpoint: path, method: 'POST', outcome: 'success', status, durationMs: Date.now() - started,
        ...(isRecord(result) && typeof result.requestId === 'number' ? { requestId: result.requestId } : {}),
      });
      return result;
    } catch (err) {
      const transportKind = isAbortError(err) ? 'timeout' : 'network';
      logEvent({ event: 'api_request', endpoint: path, method: 'POST', outcome: 'error', status, durationMs: Date.now() - started,
        kind: err instanceof MyArchitectAIError ? err.kind : transportKind,
        fingerprint: `api_request:${path}:${err instanceof MyArchitectAIError ? err.kind : 'transport'}`,
        ...(err instanceof MyArchitectAIError && err.requestId !== undefined ? { requestId: err.requestId } : {}),
      });
      if (err instanceof MyArchitectAIError) {
        throw err;
      }
      if (isAbortError(err)) {
        throw new TimeoutError(
          `Request to ${url} timed out after ${this.#config.timeoutMs} ms.`,
        );
      }
      throw new NetworkError(`Network error calling ${url}: ${describe(err)}`, err);
    }
  }

  async #handleResponse<T>(response: Response, url: string, parse: (value: unknown) => T | undefined): Promise<T> {
    const raw = await response.text();
    const parsed = safeJsonParse(raw);

    if (response.ok) {
      // Streamed generation failures retain HTTP 200. Inspect errors before
      // parsing success, including balance-only responses.
      const errorBody = asErrorResponse(parsed);
      if (errorBody) {
        throw new RequestError(errorBody.error, errorBody.balance, errorBody.cost, errorBody.requestId, response.status);
      }

      const result = parse(parsed);
      if (result) return result;

      throw new UpstreamError(
        `Malformed success response from ${url}: ${truncate(raw)}`,
        { status: response.status, retryable: false },
      );
    }

    switch (response.status) {
      case 400: {
        const errorBody = asErrorResponse(parsed);
        if (errorBody) {
          throw new RequestError(errorBody.error, errorBody.balance, errorBody.cost, errorBody.requestId);
        }
        throw new RequestError(gatewayMessage(parsed) ?? `Bad request: ${truncate(raw)}`);
      }
      case 401:
      case 403:
        throw new AuthError(
          gatewayMessage(parsed) ??
            'Missing or invalid API key. Check the MYARCHITECTAI_API_KEY environment variable.',
          response.status,
        );
      case 429:
        throw new RateLimitError(
          gatewayMessage(parsed) ?? 'Rate limit exceeded.',
          parseRetryAfter(response.headers.get('retry-after')),
        );
      case 413:
        throw new UpstreamError('Request exceeds the API 10 MB body limit. Use public image URLs instead of large inline base64 images.', { status: 413, retryable: false });
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

/**
 * Validate a 200 body against the generation response contract and normalize
 * `output` to an array.
 *
 * The API declares arrays for render variants and strings for single outputs.
 * Preserve the MCP array contract for both image and video URLs.
 */
function asGenerationResult(value: unknown): GenerationResult | undefined {
  if (!isRecord(value)) return undefined;
  const { output, balance, cost } = value;

  let urls: string[] | undefined;
  if (typeof output === 'string') {
    urls = [output];
  } else if (Array.isArray(output) && output.every((item) => typeof item === 'string')) {
    urls = output as string[];
  }
  if (urls === undefined) return undefined;
  if (typeof balance !== 'number' || typeof cost !== 'number') return undefined;

  return { output: urls, balance, cost, ...(Number.isInteger(value.requestId) ? { requestId: value.requestId as number } : {}) };
}

/** Parse streamed or pre-generation error bodies without inventing balances. */
function asErrorResponse(
  value: unknown,
): { error: string; balance?: number; cost?: number; requestId?: number } | undefined {
  if (!isRecord(value) || typeof value.error !== 'string') return undefined;
  return {
    error: value.error,
    ...(typeof value.balance === 'number' ? { balance: value.balance } : {}),
    ...(typeof value.cost === 'number' ? { cost: value.cost } : {}),
    ...(Number.isInteger(value.requestId) ? { requestId: value.requestId as number } : {}),
  };
}

/** Extract `message` from a gateway-style error body (`{ "message": "..." }`). */
function gatewayMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.error === 'string') {
    return value.error;
  }
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
