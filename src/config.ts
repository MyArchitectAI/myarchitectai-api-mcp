/**
 * Server identity and runtime configuration, loaded and validated from the
 * environment. Keep {@link SERVER_VERSION} in sync with `package.json`.
 */

import { ConfigError } from './errors.js';

export const SERVER_NAME = 'myarchitectai-mcp';
export const SERVER_VERSION = '0.1.0';

export const DEFAULT_BASE_URL = 'https://api.myarchitectai.com/v1';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RETRIES = 10;

export interface Config {
  /** API key sent as the `x-api-key` header. */
  apiKey: string;
  /** API base URL, without a trailing slash. */
  baseUrl: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Maximum number of retries for transient failures (0 disables retries). */
  maxRetries: number;
}

/**
 * Build a {@link Config} from environment variables.
 *
 * @throws {ConfigError} if the API key is missing or an override is invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.MYARCHITECTAI_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      'MYARCHITECTAI_API_KEY is not set. Provide your MyArchitectAI API key via the ' +
        'MYARCHITECTAI_API_KEY environment variable. Get a key at https://portal.myarchitectai.com.',
    );
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(env.MYARCHITECTAI_BASE_URL),
    timeoutMs: parseBoundedInt(env.MYARCHITECTAI_TIMEOUT_MS, {
      name: 'MYARCHITECTAI_TIMEOUT_MS',
      fallback: DEFAULT_TIMEOUT_MS,
      min: MIN_TIMEOUT_MS,
      max: MAX_TIMEOUT_MS,
    }),
    maxRetries: parseBoundedInt(env.MYARCHITECTAI_MAX_RETRIES, {
      name: 'MYARCHITECTAI_MAX_RETRIES',
      fallback: DEFAULT_MAX_RETRIES,
      min: 0,
      max: MAX_RETRIES,
    }),
  };
}

function normalizeBaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_BASE_URL;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`MYARCHITECTAI_BASE_URL is not a valid URL: "${value}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`MYARCHITECTAI_BASE_URL must use http or https: "${value}"`);
  }
  return value.replace(/\/+$/, '');
}

function parseBoundedInt(
  raw: string | undefined,
  opts: { name: string; fallback: number; min: number; max: number },
): number {
  const value = raw?.trim();
  if (!value) return opts.fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < opts.min || parsed > opts.max) {
    throw new ConfigError(
      `${opts.name} must be an integer between ${opts.min} and ${opts.max}. Received: "${value}".`,
    );
  }
  return parsed;
}
