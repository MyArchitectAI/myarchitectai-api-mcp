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

  it('retries an explicitly uncharged 502 and then succeeds', async () => {
    const { fetch, count } = stubFetch((attempt) =>
      attempt === 0
        ? jsonResponse(502, { message: 'billing temporarily unreachable' })
        : jsonResponse(200, { output: ['ok'], balance: 1, cost: 0.1 }),
    );
    const client = new MyArchitectAIClient(baseConfig, fetch);
    const result = await client.generate('/render/exterior', {});
    assert.equal(result.output[0], 'ok');
    assert.equal(count(), 2);
  });

  it('does not replay paid requests after an uncertain 500', async () => {
    const { fetch, count } = stubFetch(() => jsonResponse(500, { message: 'boom' }));
    const client = new MyArchitectAIClient({ ...baseConfig, maxRetries: 1 }, fetch);
    await assert.rejects(() => client.generate('/render/interior', {}), UpstreamError);
    assert.equal(count(), 1);
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

  it('does not replay a paid request after a transport failure', async () => {
    const { fetch, count } = stubFetch((attempt) => {
      if (attempt === 0) throw new TypeError('fetch failed');
      return jsonResponse(200, { output: [], balance: 1, cost: 0 });
    });
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await assert.rejects(() => client.generate('/upscale-4k', {}), NetworkError);
    assert.equal(count(), 1);
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

  it('surfaces an HTTP 200 ErrorResponse body as a non-retryable RequestError', async () => {
    const { fetch, count } = stubFetch(() =>
      jsonResponse(200, {
        error: 'An error occurred. Please try again with different parameters or contact us',
        balance: 100,
        cost: 0,
      }),
    );
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await assert.rejects(
      () => client.generate('/render/interior', {}),
      (err: unknown) => {
        assert.ok(err instanceof RequestError);
        assert.match(err.message, /An error occurred/);
        assert.equal(err.balance, 100);
        assert.equal(err.cost, 0);
        assert.equal(err.retryable, false);
        return true;
      },
    );
    assert.equal(count(), 1); // not retried — it's a request-level rejection
  });
});


describe('current API response handling', () => {
  it('keeps the timeout active while a streamed body is pending', async () => {
    let bodyAborted = false;
    const fetch: FetchLike = async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(' '));
        init?.signal?.addEventListener('abort', () => {
          bodyAborted = true;
          controller.error(new DOMException('Body aborted', 'AbortError'));
        }, { once: true });
      },
    }));
    const client = new MyArchitectAIClient({ ...baseConfig, timeoutMs: 15, maxRetries: 0 }, fetch);
    await assert.rejects(() => client.generate('/animate', {}), TimeoutError);
    assert.equal(bodyAborted, true);
  });

  it('retains a request ID on streamed failures, without retrying or inventing a balance', async () => {
    const { fetch, count } = stubFetch(() => jsonResponse(200, { error: 'generation failed', requestId: 701 }));
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await assert.rejects(() => client.autoPrompt({ image: 'https://x/i.png' }), (err: unknown) => {
      assert.ok(err instanceof RequestError);
      assert.equal(err.requestId, 701);
      assert.equal(err.status, 200);
      assert.equal(err.balance, undefined);
      assert.equal(err.cost, undefined);
      return true;
    });
    assert.equal(count(), 1);
  });

  it('reads the current error field in preference to the deprecated message', async () => {
    const { fetch, count } = stubFetch(() => jsonResponse(403, { error: 'current error', message: 'old message' }));
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await assert.rejects(() => client.balance(), { message: 'current error' });
    assert.equal(count(), 1);
  });

  it('does not treat an error containing balance as a successful balance lookup', async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, { error: 'lookup failed', balance: 10 }));
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await assert.rejects(() => client.balance(), RequestError);
  });

  it('explains a plain-text 413 without retrying', async () => {
    const { fetch, count } = stubFetch(() => new Response('HTTP content length exceeded 10485760 bytes.', { status: 413 }));
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await assert.rejects(() => client.generate('/render/interior', {}), (err: unknown) => {
      assert.ok(err instanceof UpstreamError);
      assert.equal(err.status, 413);
      assert.equal(err.retryable, false);
      assert.match(err.message, /10 MB/);
      return true;
    });
    assert.equal(count(), 1);
  });
});


describe('request budget and safe retries', () => {
  it('bounds retry backoff inside the total request budget', async () => {
    const { fetch, count } = stubFetch(() => jsonResponse(429, { error: 'slow down' }, { 'retry-after': '8' }));
    const client = new MyArchitectAIClient({ ...baseConfig, timeoutMs: 30 }, fetch);
    const start = performance.now();
    await assert.rejects(() => client.generate('/render/exterior', {}), TimeoutError);
    assert.ok(performance.now() - start < 300, 'must not wait the 8-second retry delay');
    assert.equal(count(), 1);
  });

  it('does not replay auto-prompt when its paid outcome is unknown', async () => {
    const { fetch, count } = stubFetch(() => { throw new TypeError('connection closed'); });
    const client = new MyArchitectAIClient(baseConfig, fetch);
    await assert.rejects(() => client.autoPrompt({ image: 'https://x/i.png' }), NetworkError);
    assert.equal(count(), 1);
  });

  it('can retry a read-only balance lookup after a network failure', async () => {
    const { fetch, count } = stubFetch((attempt) => {
      if (attempt === 0) throw new TypeError('connection closed');
      return jsonResponse(200, { balance: 12 });
    });
    const client = new MyArchitectAIClient(baseConfig, fetch);
    assert.deepEqual(await client.balance(), { balance: 12 });
    assert.equal(count(), 2);
  });

  it('gives subsequent attempts only the remaining response-body budget', async () => {
    let calls = 0;
    let firstSignal: AbortSignal | null | undefined;
    const fetch: FetchLike = async (_url, init) => {
      calls++;
      if (calls === 1) {
        firstSignal = init?.signal;
        return jsonResponse(429, { error: 'slow down' }, { 'retry-after': '0' });
      }
      assert.equal(init?.signal, firstSignal, 'attempts must share one deadline signal');
      return new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
        },
      }));
    };
    const client = new MyArchitectAIClient({ ...baseConfig, timeoutMs: 30 }, fetch);
    await assert.rejects(() => client.generate('/animate', {}), TimeoutError);
    assert.equal(calls, 2);
  });
});
