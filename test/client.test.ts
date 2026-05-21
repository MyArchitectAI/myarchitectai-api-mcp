import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Config } from '../src/config.js';
import { MyArchitectAIClient } from '../src/client.js';
import type { FetchLike } from '../src/client.js';
import {
  AuthError,
  NetworkError,
  RequestError,
  TimeoutError,
  UpstreamError,
} from '../src/errors.js';

const baseConfig: Config = {
  apiKey: 'test-key',
  baseUrl: 'https://api.test/v1',
  timeoutMs: 1000,
  maxRetries: 2,
  downloadDir: 'renders',
  maxPreviewBytes: 5_000_000,
  stateFile: undefined,
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Build a stub fetch that responds based on the (0-based) attempt index. */
function stubFetch(fn: (attempt: number) => Response | Promise<Response>): {
  fetch: FetchLike;
  count: () => number;
} {
  let attempt = 0;
  const fetch: FetchLike = async () => fn(attempt++);
  return { fetch, count: () => attempt };
}

describe('MyArchitectAIClient.generate', () => {
  it('returns the normalized result on 200', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(200, { output: ['https://img/1.png'], balance: 9.5, cost: 0.5 }),
    );
    const client = new MyArchitectAIClient(baseConfig, fetch);
    const result = await client.generate('/render/exterior', { image: 'https://x/y.png' });
    assert.deepEqual(result, { output: ['https://img/1.png'], balance: 9.5, cost: 0.5 });
  });

  it('normalizes a string `output` to an array (live API shape, e.g. upscale-4k)', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(200, { output: 'https://img/only.jpg', balance: 9.97, cost: 0.03 }),
    );
    const client = new MyArchitectAIClient(baseConfig, fetch);
    const result = await client.generate('/upscale-4k', { image: 'https://x/y.png' });
    assert.deepEqual(result, { output: ['https://img/only.jpg'], balance: 9.97, cost: 0.03 });
  });

  it('sends the API key, JSON body, and correct URL', async () => {
    let captured: { url: string | URL; init: RequestInit | undefined } | undefined;
    const fetch: FetchLike = async (url, init) => {
      captured = { url, init };
      return jsonResponse(200, { output: [], balance: 1, cost: 0 });
    };
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await client.generate('/text-to-image', { prompt: 'a glass house' });

    assert.equal(captured?.url, 'https://api.test/v1/text-to-image');
    const headers = captured?.init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'test-key');
    assert.equal(headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(String(captured?.init?.body)), { prompt: 'a glass house' });
  });

  it('throws a non-retryable RequestError on 400 with balance/cost', async () => {
    const { fetch, count } = stubFetch(() =>
      jsonResponse(400, { error: 'invalid image', balance: 9, cost: 0 }),
    );
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await assert.rejects(
      () => client.generate('/render/exterior', {}),
      (err: unknown) => {
        assert.ok(err instanceof RequestError);
        assert.equal(err.message, 'invalid image');
        assert.equal(err.balance, 9);
        assert.equal(err.cost, 0);
        assert.equal(err.retryable, false);
        return true;
      },
    );
    assert.equal(count(), 1);
  });

  it('throws AuthError on 403 without retrying', async () => {
    const { fetch, count } = stubFetch(() => jsonResponse(403, { message: 'Forbidden' }));
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await assert.rejects(() => client.generate('/upscale-4k', {}), AuthError);
    assert.equal(count(), 1);
  });

  it('retries a transient 503 and then succeeds', async () => {
    const { fetch, count } = stubFetch((attempt) =>
      attempt === 0
        ? jsonResponse(503, { message: 'unavailable' })
        : jsonResponse(200, { output: ['ok'], balance: 1, cost: 0.1 }),
    );
    const client = new MyArchitectAIClient(baseConfig, fetch);
    const result = await client.generate('/render/exterior', {});
    assert.equal(result.output[0], 'ok');
    assert.equal(count(), 2);
  });

  it('gives up with UpstreamError after exhausting retries on persistent 500', async () => {
    const { fetch, count } = stubFetch(() => jsonResponse(500, { message: 'boom' }));
    const client = new MyArchitectAIClient({ ...baseConfig, maxRetries: 1 }, fetch);
    await assert.rejects(() => client.generate('/render/interior', {}), UpstreamError);
    assert.equal(count(), 2);
  });

  it('honors Retry-After on 429 and retries', async () => {
    const { fetch, count } = stubFetch((attempt) =>
      attempt === 0
        ? jsonResponse(429, { message: 'slow down' }, { 'retry-after': '0' })
        : jsonResponse(200, { output: [], balance: 1, cost: 0 }),
    );
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await client.generate('/text-to-image', {});
    assert.equal(count(), 2);
  });

  it('wraps fetch failures as a retryable NetworkError', async () => {
    const { fetch, count } = stubFetch((attempt) => {
      if (attempt === 0) throw new TypeError('fetch failed');
      return jsonResponse(200, { output: [], balance: 1, cost: 0 });
    });
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await client.generate('/upscale-4k', {});
    assert.equal(count(), 2);
  });

  it('maps an aborted request to a retryable TimeoutError', async () => {
    const { fetch } = stubFetch(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const client = new MyArchitectAIClient({ ...baseConfig, maxRetries: 0 }, fetch);
    await assert.rejects(() => client.generate('/render/exterior', {}), TimeoutError);
  });

  it('surfaces an unexpected NetworkError type when fetch rejects oddly', async () => {
    const { fetch } = stubFetch(() => {
      throw new TypeError('connection reset');
    });
    const client = new MyArchitectAIClient({ ...baseConfig, maxRetries: 0 }, fetch);
    await assert.rejects(() => client.generate('/x', {}), NetworkError);
  });

  it('treats a malformed 200 body as a non-retryable UpstreamError', async () => {
    const { fetch, count } = stubFetch(() => jsonResponse(200, { unexpected: true }));
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await assert.rejects(() => client.generate('/render/exterior', {}), UpstreamError);
    assert.equal(count(), 1);
  });
});
