import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

  it('counts a failed generation and takes lastKnownBalance from the error', () => {
    const store = new SessionStore();
    store.recordFailure(42);
    const summary = store.summary();
    assert.equal(summary.failedGenerations, 1);
    assert.equal(summary.totalGenerations, 0);
    assert.equal(summary.lastKnownBalance, 42);
  });

  it('uses the most recent balance across successes and failures', async () => {
    const store = new SessionStore();
    await store.record({ tool: 't', output: ['a'], cost: 1, balance: 9 });
    store.recordFailure(8); // a later call failed; the API reported balance 8
    const summary = store.summary();
    assert.equal(summary.lastKnownBalance, 8);
    assert.equal(summary.totalGenerations, 1);
    assert.equal(summary.failedGenerations, 1);
  });

  it('leaves lastKnownBalance unchanged when a failure reports no balance', async () => {
    const store = new SessionStore();
    await store.record({ tool: 't', output: ['a'], cost: 1, balance: 9 });
    store.recordFailure();
    assert.equal(store.summary().lastKnownBalance, 9);
    assert.equal(store.summary().failedGenerations, 1);
  });
});
