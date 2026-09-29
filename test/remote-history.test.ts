import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UpstashRemoteSessionProvider } from '../src/remote-history.js';
import { RemoteSessionUnavailableError } from '../src/remote-session.js';

type State = {
  version: number; seq: number; records: Array<Record<string, unknown>>;
  failedGenerations: number; totalGenerations: number; totalCost: number;
  lastKnownBalance: number | null; byTool: Record<string, { count: number; cost: number }>;
  since: string | null;
};

class FakeUpstash {
  readonly data = new Map<string, { value: string; expiresAt: number }>();
  readonly commands: Array<Array<string | number>> = [];
  now = 0;
  unavailable = false;
  malformed = false;

  readonly fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.unavailable) throw new Error('private connection detail');
    if (this.malformed) return Response.json({ unexpected: 'private data' });
    const args = JSON.parse(String(init?.body)) as Array<string | number>;
    this.commands.push(args);
    assert.equal(args[0], 'EVAL');
    assert.equal(args[2], 1);
    const key = String(args[3]);
    const stored = this.data.get(key);
    if (stored && stored.expiresAt <= this.now) this.data.delete(key);
    const current = this.data.get(key);
    const script = String(args[1]);
    if (script.includes("redis.call('EXPIRE'")) {
      if (current) current.expiresAt = this.now + Number(args[4]) * 1000;
      return Response.json({ result: current?.value ?? null });
    }
    assert.match(script, /redis\.call\('SET'.*'EX'/);
    const operation = args[4];
    const value = JSON.parse(String(args[5])) as Record<string, unknown>;
    const ttl = Number(args[6]);
    const cap = Number(args[7]);
    const state = (current ? JSON.parse(current.value) : JSON.parse(String(args[8]))) as State;
    let result = 'OK';
    if (operation === 'record') {
      value.id = ++state.seq;
      state.totalGenerations += 1;
      state.totalCost += Number(value.cost);
      state.lastKnownBalance = Number(value.balance);
      state.since ??= String(value.createdAt);
      const bucket = (state.byTool[String(value.tool)] ??= { count: 0, cost: 0 });
      bucket.count += 1;
      bucket.cost += Number(value.cost);
      state.records.push(value);
      state.records = state.records.slice(-cap);
      while (Buffer.byteLength(JSON.stringify(state)) > Number(args[9]) && state.records.length > 1) {
        state.records.shift();
      }
      result = JSON.stringify(value);
    } else if (operation === 'failure') {
      state.failedGenerations += 1;
      if (value.balance !== null) state.lastKnownBalance = Number(value.balance);
    } else if (operation === 'balance') {
      state.lastKnownBalance = Number(value.balance);
    } else {
      throw new Error('Unexpected fake operation.');
    }
    this.data.set(key, { value: JSON.stringify(state), expiresAt: this.now + ttl * 1000 });
    return Response.json({ result });
  }) as typeof fetch;
}

const options = (redis: FakeUpstash, extras: Record<string, unknown> = {}) => ({
  restUrl: 'https://redis.example/', restToken: 'test-token', keySecret: 'x'.repeat(32),
  namespace: 'myarchitectai:mcp:production', fetch: redis.fetch, ...extras,
});
const alice = { issuer: 'https://issuer.example', subject: 'alice' };

describe('UpstashRemoteSessionProvider', () => {
  it('shares one user across instances and isolates issuer or subject without plaintext keys', async () => {
    const redis = new FakeUpstash();
    const first = new UpstashRemoteSessionProvider(options(redis));
    const second = new UpstashRemoteSessionProvider(options(redis));
    const firstLease = await first.acquire(alice);
    await firstLease.session.record({ tool: 'render_exterior', output: ['https://cdn.example/result'], cost: 1, balance: 9 });
    const same = await second.acquire(alice);
    assert.equal((await same.session.recent()).length, 1);
    assert.equal((await (await second.acquire({ ...alice, subject: 'bob' })).session.recent()).length, 0);
    assert.equal((await (await second.acquire({ ...alice, issuer: 'https://other.example' })).session.recent()).length, 0);
    assert.equal(redis.data.size, 1);
    assert.ok([...redis.data.keys()].every((key) => !key.includes('alice') && !key.includes('issuer')));
  });

  it('keeps concurrent increments, aggregate totals and the record cap', async () => {
    const redis = new FakeUpstash();
    const a = new UpstashRemoteSessionProvider(options(redis, { maxRecordsPerUser: 2 }));
    const b = new UpstashRemoteSessionProvider(options(redis, { maxRecordsPerUser: 2 }));
    const [one, two] = await Promise.all([a.acquire(alice), b.acquire(alice)]);
    const records = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? one : two).session.record({ tool: 'render', output: [`https://cdn.example/${index}`], cost: 0.5, balance: 10 })));
    assert.deepEqual(records.map((record) => record.id).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.deepEqual((await one.session.recent()).map((record) => record.id), [20, 19]);
    assert.deepEqual(await two.session.summary(), {
      totalGenerations: 20, failedGenerations: 0, totalCost: 10,
      lastKnownBalance: 10, byTool: { render: { count: 20, cost: 10 } },
      since: records[0]?.createdAt,
    });
    assert.equal(redis.commands.filter((command) => command[4] === 'record').length, 20);
  });

  it('refreshes idle expiry on reads and mutations, then expires after inactivity', async () => {
    const redis = new FakeUpstash();
    const provider = new UpstashRemoteSessionProvider(options(redis, { ttlSeconds: 10 }));
    const lease = await provider.acquire(alice);
    await lease.session.record({ tool: 'render', output: [], cost: 1, balance: 9 });
    redis.now = 9_000;
    assert.equal((await lease.session.summary()).totalGenerations, 1);
    redis.now = 18_000;
    assert.equal((await (await provider.acquire(alice)).session.recent()).length, 1);
    redis.now = 29_000;
    assert.equal((await (await provider.acquire(alice)).session.summary()).totalGenerations, 0);
  });

  it('retains long text output and evicts oldest records before the state exceeds one megabyte', async () => {
    const redis = new FakeUpstash();
    const session = (await new UpstashRemoteSessionProvider(options(redis)).acquire(alice)).session;
    for (let index = 0; index < 70; index++) {
      await session.record({ tool: 'auto_prompt', output: [`${index}:${'x'.repeat(20_000)}`],
        outputType: 'text', cost: 0.1, balance: 1 });
    }
    const newest = (await session.recent(1))[0];
    assert.equal(newest?.output[0]?.length, 20_003);
    assert.equal((await session.summary()).totalGenerations, 70);
    assert.ok((await session.recent(100)).length < 70);
    assert.ok(Buffer.byteLength([...redis.data.values()][0]?.value ?? '') <= 1_000_000);
  });

  it('preserves failed-call and balance semantics', async () => {
    const redis = new FakeUpstash();
    const session = (await new UpstashRemoteSessionProvider(options(redis)).acquire(alice)).session;
    await session.recordFailure(8);
    await session.recordFailure();
    assert.equal((await session.summary()).failedGenerations, 2);
    assert.equal((await session.summary()).lastKnownBalance, 8);
    await session.updateBalance(7);
    assert.equal((await session.summary()).lastKnownBalance, 7);
  });

  it('rejects unavailable or malformed Redis responses at admission and on reads', async () => {
    const redis = new FakeUpstash();
    const events: unknown[] = [];
    const provider = new UpstashRemoteSessionProvider(options(redis, { onError: (event: unknown) => events.push(event) }));
    redis.unavailable = true;
    await assert.rejects(provider.acquire(alice), RemoteSessionUnavailableError);
    redis.unavailable = false;
    redis.malformed = true;
    await assert.rejects(provider.acquire(alice), RemoteSessionUnavailableError);
    redis.malformed = false;
    const lease = await provider.acquire(alice);
    const key = String(redis.commands.at(-1)?.[3]);
    redis.data.set(key, { value: '{"version":1,"records":"bad"}', expiresAt: 99_999 });
    await assert.rejects(async () => lease.session.summary(), RemoteSessionUnavailableError);
    assert.deepEqual(events, [
      { fingerprint: 'remote.history.storage', operation: 'acquire' },
      { fingerprint: 'remote.history.storage', operation: 'acquire' },
      { fingerprint: 'remote.history.storage', operation: 'summary' },
    ]);
  });

  it('rejects nonfinite money values and captures the write failure', async () => {
    const redis = new FakeUpstash();
    const events: unknown[] = [];
    const session = (await new UpstashRemoteSessionProvider(options(redis, { onError: (event: unknown) => events.push(event) })).acquire(alice)).session;
    await assert.rejects(async () => session.record({ tool: 'render', output: [], cost: Number.NaN, balance: 1 }), RemoteSessionUnavailableError);
    assert.equal((await session.summary()).totalGenerations, 0);
    assert.deepEqual(events, [{ fingerprint: 'remote.history.storage', operation: 'record' }]);
  });
});
