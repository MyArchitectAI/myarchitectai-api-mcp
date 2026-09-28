import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RemoteSessionRegistry } from '../src/remote-session.js';

describe('RemoteSessionRegistry', () => {
  it('shares history only for the same verified issuer and subject', async () => {
    const registry = new RemoteSessionRegistry();
    const alice = registry.acquire({ issuer: 'https://issuer.example', subject: 'alice' });
    await alice.session.record({ tool: 'render_exterior', output: ['https://cdn.example/a'], cost: 1, balance: 9 });
    const aliceAgain = registry.acquire({ issuer: 'https://issuer.example', subject: 'alice' });
    const differentIssuer = registry.acquire({ issuer: 'https://other.example', subject: 'alice' });
    const bob = registry.acquire({ issuer: 'https://issuer.example', subject: 'bob' });
    assert.equal(aliceAgain.session, alice.session);
    assert.equal(aliceAgain.session.recent().length, 1);
    assert.equal(differentIssuer.session.recent().length, 0);
    assert.equal(bob.session.recent().length, 0);
    alice.release();
    aliceAgain.release();
    differentIssuer.release();
    bob.release();
  });

  it('bounds records while preserving monotonic generation IDs', async () => {
    const registry = new RemoteSessionRegistry({ maxRecordsPerUser: 2 });
    const lease = registry.acquire({ issuer: 'issuer', subject: 'alice' });
    for (let i = 0; i < 4; i++) {
      await lease.session.record({ tool: 'render', output: [`${i}`], cost: 1, balance: i });
    }
    assert.deepEqual(lease.session.recent().map((record) => record.id), [4, 3]);
    assert.equal(lease.session.summary().totalGenerations, 4);
    lease.release();
  });

  it('retains active stores and rejects capacity until an inactive lease expires', () => {
    let now = 0;
    const registry = new RemoteSessionRegistry({ maxUsers: 1, idleTtlMs: 10, now: () => now });
    const active = registry.acquire({ issuer: 'issuer', subject: 'alice' });
    now = 100;
    assert.throws(() => registry.acquire({ issuer: 'issuer', subject: 'bob' }), /capacity/);
    const concurrent = registry.acquire({ issuer: 'issuer', subject: 'alice' });
    assert.equal(concurrent.session, active.session);
    active.release();
    now = 111;
    assert.throws(() => registry.acquire({ issuer: 'issuer', subject: 'bob' }), /capacity/);
    concurrent.release();
  });

  it('evicts only expired inactive stores and release is idempotent', () => {
    let now = 0;
    const registry = new RemoteSessionRegistry({ maxUsers: 1, idleTtlMs: 10, now: () => now });
    const alice = registry.acquire({ issuer: 'issuer', subject: 'alice' });
    alice.release();
    alice.release();
    now = 10;
    const bob = registry.acquire({ issuer: 'issuer', subject: 'bob' });
    assert.equal(registry.size, 1);
    assert.notEqual(bob.session, alice.session);
    bob.release();
  });

  it('requires a verified identity shape', () => {
    const registry = new RemoteSessionRegistry();
    assert.throws(() => registry.acquire({ issuer: '', subject: 'alice' }), /Verified issuer/);
    assert.throws(() => registry.acquire({ issuer: 'issuer', subject: '' }), /Verified issuer/);
  });
});
