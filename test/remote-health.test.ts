import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHostedHealthCheck } from '../src/remote-health.js';
import { UpstashRemoteSessionProvider } from '../src/remote-history.js';

const jwks = () => Response.json({ keys: [{ kty: 'RSA', kid: 'active-key', n: 'n', e: 'AQAB' }] });

describe('hosted deep health', () => {
  it('coalesces concurrent probes, checks all dependencies, and caches success for 30 seconds', async () => {
    let now = 0;
    let accountCalls = 0;
    let jwksCalls = 0;
    let redisCalls = 0;
    const check = createHostedHealthCheck({
      jwksUrl: 'https://portal.example/auth/v1/.well-known/jwks.json',
      checkAccount: async (signal) => {
        accountCalls++;
        assert.equal(signal.aborted, false);
        return true;
      },
      fetch: (async (_url, init) => {
        jwksCalls++;
        assert.equal(init?.redirect, 'error');
        assert.equal(init?.signal?.aborted, false);
        return jwks();
      }) as typeof fetch,
      history: { ping: async (signal) => { redisCalls++; assert.equal(signal?.aborted, false); } },
      now: () => now,
    });
    const [first, second] = await Promise.all([check(), check()]);
    assert.deepEqual(first, { status: 'ok', checks: { account: true, jwks: true, redis: true } });
    assert.equal(first, second);
    assert.deepEqual([accountCalls, jwksCalls, redisCalls], [1, 1, 1]);
    now = 29_999;
    assert.equal(await check(), first);
    now = 30_000;
    await check();
    assert.deepEqual([accountCalls, jwksCalls, redisCalls], [2, 2, 2]);
  });

  it('fails without an explicit binding and caches failure for only five seconds', async () => {
    let now = 0;
    let accountCalls = 0;
    const events: unknown[] = [];
    const check = createHostedHealthCheck({
      jwksUrl: 'https://portal.example/jwks',
      checkAccount: async () => { accountCalls++; return false; },
      fetch: (async () => jwks()) as typeof fetch,
      history: { ping: async () => {} }, now: () => now,
      onError: (event) => events.push(event),
    });
    assert.deepEqual(await check(), { status: 'unavailable', checks: { account: false, jwks: true, redis: true } });
    now = 4_999;
    await check();
    assert.equal(events.length, 1);
    now = 5_000;
    await check();
    assert.equal(events.length, 2);
    assert.equal(accountCalls, 2);
    assert.deepEqual(events[0], { fingerprint: 'remote.health.dependencies', check: 'account' });
  });

  it('does not report health when Portal rejects its representative account', async () => {
    const check = createHostedHealthCheck({
      jwksUrl: 'https://portal.example/jwks', checkAccount: async () => false,
      fetch: (async () => jwks()) as typeof fetch, history: { ping: async () => {} },
    });
    assert.equal((await check()).checks.account, false);
  });

  it('rejects malformed JWKS without exposing its contents and retries after the failure TTL', async () => {
    let now = 0;
    let calls = 0;
    const events: unknown[] = [];
    const check = createHostedHealthCheck({
      jwksUrl: 'https://portal.example/jwks', checkAccount: async () => true,
      fetch: (async () => { calls++; return Response.json({ keys: [] }); }) as typeof fetch,
      history: { ping: async () => {} }, now: () => now,
      onError: (event) => events.push(event),
    });
    assert.deepEqual(await check(), { status: 'unavailable', checks: { account: true, jwks: false, redis: true } });
    now = 5_000;
    await check();
    assert.equal(calls, 2);
    assert.deepEqual(events, [
      { fingerprint: 'remote.health.dependencies', check: 'jwks' },
      { fingerprint: 'remote.health.dependencies', check: 'jwks' },
    ]);
  });

  it('bounds the total deadline even if a dependency ignores abort', async () => {
    const events: unknown[] = [];
    let observedSignal: AbortSignal | undefined;
    const check = createHostedHealthCheck({
      jwksUrl: 'https://portal.example/jwks',
      checkAccount: async (signal) => {
        observedSignal = signal;
        return new Promise<boolean>(() => {});
      },
      fetch: (async () => jwks()) as typeof fetch,
      history: { ping: async () => {} }, deadlineMs: 15,
      onError: (event) => events.push(event),
    });
    const started = Date.now();
    assert.deepEqual(await check(), { status: 'unavailable', checks: { account: false, jwks: true, redis: true } });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(observedSignal?.aborted, true);
    assert.deepEqual(events, [{ fingerprint: 'remote.health.dependencies', check: 'deadline' }]);
  });

  it('uses only Redis PING for availability and honors abort without a history-key read', async () => {
    const commands: unknown[] = [];
    const provider = new UpstashRemoteSessionProvider({
      restUrl: 'https://redis.example/', restToken: 'synthetic-token',
      keySecret: 'x'.repeat(32), namespace: 'mya:tests',
      fetch: (async (_url, init) => {
        commands.push(JSON.parse(String(init?.body)) as unknown);
        return Response.json({ result: 'PONG' });
      }) as typeof fetch,
    });
    await provider.ping();
    assert.deepEqual(commands, [['PING']]);
    const controller = new AbortController();
    controller.abort();
    const abortingProvider = new UpstashRemoteSessionProvider({
      restUrl: 'https://redis.example/', restToken: 'synthetic-token',
      keySecret: 'x'.repeat(32), namespace: 'mya:tests',
      fetch: (async (_url, init) => {
        assert.equal(init?.signal?.aborted, true);
        throw new Error('synthetic transport failure');
      }) as typeof fetch,
    });
    await assert.rejects(abortingProvider.ping(controller.signal), /Remote generation history is unavailable/);
  });
});
