import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { SessionStore } from '../src/session.js';

describe('SessionStore', () => {
  it('starts empty', () => {
    const store = new SessionStore();
    const summary = store.summary();
    assert.equal(summary.totalGenerations, 0);
    assert.equal(summary.failedGenerations, 0);
    assert.equal(summary.totalCost, 0);
    assert.equal(summary.lastKnownBalance, null);
    assert.deepEqual(store.recent(), []);
  });

  it('records generations and summarizes cost/balance per tool', async () => {
    const store = new SessionStore();
    await store.record({ tool: 'render_exterior', output: ['a'], cost: 0.5, balance: 9.5 });
    await store.record({ tool: 'render_exterior', output: ['b'], cost: 0.5, balance: 9.0 });
    await store.record({ tool: 'upscale_4k', output: ['c'], cost: 1, balance: 8.0 });

    const summary = store.summary();
    assert.equal(summary.totalGenerations, 3);
    assert.equal(summary.totalCost, 2);
    assert.equal(summary.lastKnownBalance, 8.0);
    assert.equal(summary.byTool.render_exterior?.count, 2);
    assert.equal(summary.byTool.render_exterior?.cost, 1);
    assert.equal(summary.byTool.upscale_4k?.count, 1);
  });

  it('returns recent generations most-recent-first, honoring the limit', async () => {
    const store = new SessionStore();
    for (let i = 1; i <= 5; i++) {
      await store.record({ tool: 't', output: [`${i}`], cost: 0, balance: i });
    }
    const recent = store.recent(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0]?.balance, 5);
    assert.equal(recent[1]?.balance, 4);
  });

  it('persists to and reloads from a state file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-session-'));
    const file = path.join(dir, 'history.json');
    try {
      const first = new SessionStore(file);
      await first.init();
      await first.record({ tool: 'text_to_image', output: ['x'], cost: 0.2, balance: 5 });

      const second = new SessionStore(file);
      await second.init();
      const summary = second.summary();
      assert.equal(summary.totalGenerations, 1);
      assert.equal(summary.lastKnownBalance, 5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts a failed generation and takes lastKnownBalance from the error', async () => {
    const store = new SessionStore();
    await store.recordFailure(42);
    const summary = store.summary();
    assert.equal(summary.failedGenerations, 1);
    assert.equal(summary.totalGenerations, 0);
    assert.equal(summary.lastKnownBalance, 42);
  });

  it('uses the most recent balance across successes and failures', async () => {
    const store = new SessionStore();
    await store.record({ tool: 't', output: ['a'], cost: 1, balance: 9 });
    await store.recordFailure(8); // a later call failed; the API reported balance 8
    const summary = store.summary();
    assert.equal(summary.lastKnownBalance, 8);
    assert.equal(summary.totalGenerations, 1);
    assert.equal(summary.failedGenerations, 1);
  });

  it('leaves lastKnownBalance unchanged when a failure reports no balance', async () => {
    const store = new SessionStore();
    await store.record({ tool: 't', output: ['a'], cost: 1, balance: 9 });
    await store.recordFailure();
    assert.equal(store.summary().lastKnownBalance, 9);
    assert.equal(store.summary().failedGenerations, 1);
  });

  it('includes retained policy charges without successful counts or output history', async () => {
    const store = new SessionStore();
    await store.record({ tool: 'render_exterior', output: ['a'], cost: 0.5, balance: 9.5 });
    await store.recordFailure(9.25, { tool: 'render_exterior', code: 'CONTENT_POLICY_VIOLATION', cost: 0.25 });
    await store.recordFailure(9, { tool: 'auto_prompt', code: 'CONTENT_POLICY_VIOLATION', cost: 0.25 });
    await store.recordFailure(9, { tool: 'auto_prompt', code: 'SAFETY_CHECK_UNAVAILABLE', cost: 0 });
    const summary = store.summary();
    assert.equal(summary.totalGenerations, 1);
    assert.equal(summary.failedGenerations, 3);
    assert.equal(summary.totalCost, 1);
    assert.equal(summary.lastKnownBalance, 9);
    assert.deepEqual(summary.byTool, {
      render_exterior: { count: 1, cost: 0.75 },
      auto_prompt: { count: 0, cost: 0.25 },
    });
    assert.equal(store.recent().length, 1);
    assert.deepEqual(store.recent()[0]?.output, ['a']);
  });

  it('counts a policy-only session as failed with retained spend and no results', async () => {
    const store = new SessionStore();
    await store.recordFailure(4.5, { tool: 'animate', code: 'CONTENT_POLICY_VIOLATION', cost: 0.5 });
    assert.deepEqual(store.summary(), {
      totalGenerations: 0, failedGenerations: 1, totalCost: 0.5,
      lastKnownBalance: 4.5, byTool: { animate: { count: 0, cost: 0.5 } }, since: null,
    });
    assert.deepEqual(store.recent(), []);
  });

  it('does not treat arbitrary failed cost values as retained policy charges', async () => {
    const store = new SessionStore();
    const charges = [
      { code: undefined, cost: 0.5 },
      { code: 'SAFETY_CHECK_UNAVAILABLE', cost: 0.5 },
      { code: 'OTHER_ERROR', cost: 0.5 },
      { code: 'CONTENT_POLICY_VIOLATION', cost: 0 },
      { code: 'CONTENT_POLICY_VIOLATION', cost: -0.5 },
      { code: 'CONTENT_POLICY_VIOLATION', cost: undefined },
      { code: 'CONTENT_POLICY_VIOLATION', cost: Number.NaN },
      { code: 'CONTENT_POLICY_VIOLATION', cost: Number.POSITIVE_INFINITY },
    ];
    for (const charge of charges) await store.recordFailure(undefined, { tool: 't', ...charge });
    assert.equal(store.summary().totalCost, 0);
    assert.equal(store.summary().failedGenerations, charges.length);
    assert.deepEqual(store.summary().byTool, {});
  });

  it('restores retained charges, failures and balance without adding failed output history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-session-policy-'));
    const file = path.join(dir, 'history.json');
    try {
      const first = new SessionStore(file);
      await first.record({ tool: 'render_exterior', output: ['a'], cost: 0.5, balance: 9.5 });
      await first.recordFailure(9, { tool: 'auto_prompt', code: 'CONTENT_POLICY_VIOLATION', cost: 0.5 });
      await first.recordFailure(9, { tool: 'auto_prompt', code: 'SAFETY_CHECK_UNAVAILABLE', cost: 0 });
      const restored = new SessionStore(file);
      await restored.init();
      assert.deepEqual(restored.summary(), first.summary());
      assert.deepEqual(restored.recent(), first.recent());
      const next = await restored.record({ tool: 'render_exterior', output: ['b'], cost: 0.5, balance: 8.5 });
      assert.equal(next.id, 2);
      assert.equal(restored.summary().totalCost, 1.5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads legacy history arrays and includes new retained charges after another restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-session-legacy-'));
    const file = path.join(dir, 'history.json');
    const legacy = [{ id: 7, tool: 't', createdAt: '2026-10-09T10:00:00Z', output: ['a'], cost: 0.5, balance: 9.5 }];
    try {
      await writeFile(file, JSON.stringify(legacy));
      const store = new SessionStore(file);
      await store.init();
      assert.deepEqual(store.recent(), legacy);
      assert.equal(store.summary().totalCost, 0.5);
      assert.equal(store.summary().failedGenerations, 0);
      await store.recordFailure(9, { tool: 't', code: 'CONTENT_POLICY_VIOLATION', cost: 0.5 });
      const restored = new SessionStore(file);
      await restored.init();
      assert.deepEqual(restored.summary(), store.summary());
      assert.deepEqual(restored.recent(), legacy);
      assert.equal((await restored.record({ tool: 't', output: ['b'], cost: 0, balance: 9 })).id, 8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves the newest retained totals when successful and failed calls persist concurrently', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-session-concurrent-'));
    const file = path.join(dir, 'history.json');
    try {
      const store = new SessionStore(file);
      await Promise.all([
        store.record({ tool: 't', output: ['a'], cost: 0.5, balance: 9.5 }),
        store.recordFailure(9.25, { tool: 't', code: 'CONTENT_POLICY_VIOLATION', cost: 0.25 }),
        store.record({ tool: 't', output: ['b'], cost: 0.5, balance: 8.75 }),
        store.recordFailure(8.5, { tool: 'auto_prompt', code: 'CONTENT_POLICY_VIOLATION', cost: 0.25 }),
      ]);
      const restored = new SessionStore(file);
      await restored.init();
      assert.deepEqual(restored.summary(), store.summary());
      assert.equal(restored.summary().totalCost, 1.5);
      assert.equal(restored.summary().failedGenerations, 2);
      assert.equal(restored.summary().totalGenerations, 2);
      assert.equal(restored.summary().lastKnownBalance, 8.5);
      assert.deepEqual(restored.recent(), store.recent());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
