import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { MyArchitectAIClient, type FetchLike } from '../src/client.js';
import type { Config } from '../src/config.js';
import { createRemoteServer, type RemoteServerOptions } from '../src/remote.js';

const resource = 'https://mcp.example.com/mcp';
const issuer = 'https://auth.example.com/auth/v1';
const account = (subject: string): Config => ({
  apiKey: `key-${subject}`,
  baseUrl: 'https://api.synthetic.test/v1',
  timeoutMs: 1000,
  maxRetries: 0,
  downloadDir: 'renders',
  maxPreviewBytes: 100_000,
  stateFile: undefined,
});

const fixture = async (overrides: Partial<RemoteServerOptions> = {}) => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: 'ES256', use: 'sig' }] });
  const upstreamKeys: string[] = [];
  const syntheticFetch: FetchLike = async (input, init) => {
    const key = (init?.headers as Record<string, string>)['x-api-key'];
    assert.ok(key);
    upstreamKeys.push(key);
    const path = new URL(String(input)).pathname;
    const body = path.endsWith('/balance')
      ? { balance: key === 'key-user-a' ? 11 : 22 }
      : { output: [`https://images.synthetic.test/${key}.png`], balance: 10, cost: 1 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const server = createRemoteServer({
    auth: { canonicalResource: resource, issuer, jwks, allowedOAuthClientIds: ['trusted-client'],
      allowedHosts: ['127.0.0.1'], maxBodyBytes: 2_000, ...overrides.auth },
    resolveAccount: overrides.resolveAccount ?? ((identity) => account(identity.subject)),
    createClient: overrides.createClient ?? ((config) => new MyArchitectAIClient(config, syntheticFetch)),
    ...(overrides.sessions ? { sessions: overrides.sessions } : {}),
    ...(overrides.onError ? { onError: overrides.onError } : {}),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const token = async (subject: string) => new SignJWT({ client_id: 'trusted-client' })
    .setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer).setAudience(resource)
    .setSubject(subject).setExpirationTime('5m').sign(privateKey);
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, endpoint, token, close, upstreamKeys };
};

const connect = async (endpoint: URL, token: string): Promise<Client> => {
  const client = new Client({ name: 'synthetic-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  return client;
};

describe('remote MCP HTTP boundary', () => {
  it('handles initialize, tools/list, balance, generation and isolated user history', async () => {
    const app = await fixture();
    try {
      const alice = await connect(app.endpoint, await app.token('user-a'));
      const bob = await connect(app.endpoint, await app.token('user-b'));
      try {
        const list = await alice.listTools();
        assert.ok(list.tools.some((tool) => tool.name === 'text_to_image'));
        assert.ok(list.tools.some((tool) => tool.name === 'balance'));
        assert.ok(!list.tools.some((tool) => tool.name === 'save_image'));
        const balance = await alice.callTool({ name: 'balance', arguments: {} });
        assert.deepEqual(balance.structuredContent, { balance: 11 });
        const generation = await alice.callTool({ name: 'text_to_image', arguments: {
          prompt: 'Synthetic pavilion', outputFormat: 'png', outputWidth: 512, outputHeight: 512,
        } });
        assert.equal(generation.isError, undefined);
        assert.deepEqual(generation.structuredContent, {
          output: ['https://images.synthetic.test/key-user-a.png'], balance: 10, cost: 1,
        });
        const aliceRecent = await alice.callTool({ name: 'list_recent_generations', arguments: {} });
        const bobRecent = await bob.callTool({ name: 'list_recent_generations', arguments: {} });
        assert.equal((aliceRecent.structuredContent as { generations: unknown[] }).generations.length, 1);
        assert.equal((bobRecent.structuredContent as { generations: unknown[] }).generations.length, 0);
        const bobBalance = await bob.callTool({ name: 'balance', arguments: {} });
        assert.deepEqual(bobBalance.structuredContent, { balance: 22 });
        assert.deepEqual(app.upstreamKeys, ['key-user-a', 'key-user-a', 'key-user-b']);
      } finally {
        await alice.close();
        await bob.close();
      }
    } finally {
      await app.close();
    }
  });

  it('enforces methods, origins, body size, JSON syntax, and health access', async () => {
    const app = await fixture({ auth: {
      canonicalResource: resource, issuer, allowedOAuthClientIds: ['trusted-client'],
      allowedOrigins: ['https://trusted.example'], healthToken: 'synthetic-observer-token',
    } });
    try {
      const auth = `Bearer ${await app.token('user-a')}`;
      for (const method of ['GET', 'DELETE']) {
        const response = await fetch(app.endpoint, { method, headers: { authorization: auth } });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'POST');
      }
      const metadata = await fetch(new URL('/.well-known/oauth-protected-resource', app.endpoint), { method: 'POST' });
      assert.equal(metadata.status, 405);
      assert.equal(metadata.headers.get('allow'), 'GET');
      const blockedOrigin = await fetch(app.endpoint, { method: 'POST',
        headers: { authorization: auth, origin: 'https://blocked.example', 'content-type': 'application/json' },
        body: '{}' });
      assert.equal(blockedOrigin.status, 403);
      const oversized = await fetch(app.endpoint, { method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' }, body: 'x'.repeat(2_001) });
      assert.equal(oversized.status, 413);
      const malformed = await fetch(app.endpoint, { method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' }, body: '{' });
      assert.equal(malformed.status, 400);
      const deepUrl = new URL('/health/deep', app.endpoint);
      assert.equal((await fetch(deepUrl)).status, 401);
      const deep = await fetch(deepUrl, { headers: { 'x-obs-token': 'synthetic-observer-token' } });
      assert.deepEqual(await deep.json(), { status: 'ok', scope: 'process' });
      assert.deepEqual(app.upstreamKeys, []);
    } finally {
      await app.close();
    }
  });

  it('holds capacity during lookup, then frees it, and never dispatches after a timeout', async () => {
    let releaseLookup: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    let lookups = 0;
    const app = await fixture({
      auth: { canonicalResource: resource, issuer, allowedOAuthClientIds: ['trusted-client'],
        maxConcurrentRequests: 1, requestTimeoutMs: 50 },
      resolveAccount: async (identity) => {
        lookups++;
        if (lookups === 1) {
          await lookupGate;
        }
        return account(identity.subject);
      },
      onError: () => { throw new Error('observer failed'); },
    });
    try {
      const auth = `Bearer ${await app.token('user-a')}`;
      const post = () => fetch(app.endpoint, { method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
      const first = post();
      while (lookups === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const busy = await post();
      assert.equal(busy.status, 503);
      const timedOut = await first;
      assert.equal(timedOut.status, 504);
      releaseLookup?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(app.upstreamKeys, []);
      const after = await post();
      assert.notEqual(after.status, 503);
    } finally {
      releaseLookup?.();
      await app.close();
    }
  });

  it('releases capacity when an account resolver never settles', async () => {
    let lookups = 0;
    let firstSignal: AbortSignal | undefined;
    const app = await fixture({
      auth: { canonicalResource: resource, issuer, allowedOAuthClientIds: ['trusted-client'],
        maxConcurrentRequests: 1, requestTimeoutMs: 40 },
      resolveAccount: (identity, { signal }) => {
        lookups++;
        if (lookups === 1) {
          firstSignal = signal;
          return new Promise<Config | undefined>(() => {});
        }
        return account(identity.subject);
      },
    });
    try {
      const signed = await app.token('user-a');
      const timedOut = await fetch(app.endpoint, { method: 'POST',
        headers: { authorization: `Bearer ${signed}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
      assert.equal(timedOut.status, 504);
      assert.equal(firstSignal?.aborted, true);
      const client = await connect(app.endpoint, signed);
      try {
        const listed = await client.listTools();
        assert.ok(listed.tools.some((tool) => tool.name === 'balance'));
      } finally {
        await client.close();
      }
      assert.deepEqual(app.upstreamKeys, []);
    } finally {
      await app.close();
    }
  });

  it('retains completed generation history when the HTTP response times out mid-generation', async () => {
    let releaseUpstream: (() => void) | undefined;
    let signalUpstreamStarted: (() => void) | undefined;
    const upstreamGate = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const upstreamStarted = new Promise<void>((resolve) => { signalUpstreamStarted = resolve; });
    const app = await fixture({
      auth: { canonicalResource: resource, issuer, allowedOAuthClientIds: ['trusted-client'],
        requestTimeoutMs: 100, maxConcurrentRequests: 1 },
      createClient: (config) => new MyArchitectAIClient(config, async () => {
        signalUpstreamStarted?.();
        await upstreamGate;
        return new Response(JSON.stringify({ output: ['https://images.synthetic.test/finished.png'],
          balance: 9, cost: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    });
    try {
      const signed = await app.token('user-a');
      const client = await connect(app.endpoint, signed);
      try {
        let callFailed = false;
        const call = client.callTool({ name: 'text_to_image', arguments: {
          prompt: 'Synthetic pavilion', outputFormat: 'png', outputWidth: 512, outputHeight: 512,
        } }).then(() => undefined, () => { callFailed = true; });
        await upstreamStarted;
        await new Promise((resolve) => setTimeout(resolve, 160));
        await call;
        assert.equal(callFailed, true);
        const busy = await fetch(app.endpoint, { method: 'POST',
          headers: { authorization: `Bearer ${signed}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) });
        assert.equal(busy.status, 503);
        releaseUpstream?.();
        const historyClient = await connect(app.endpoint, signed);
        try {
          let count = 0;
          for (let attempt = 0; attempt < 20; attempt++) {
            const recent = await historyClient.callTool({ name: 'list_recent_generations', arguments: {} });
            count = (recent.structuredContent as { generations: unknown[] }).generations.length;
            if (count === 1) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(count, 1);
        } finally {
          await historyClient.close();
        }
      } finally {
        releaseUpstream?.();
        await client.close();
      }
    } finally {
      releaseUpstream?.();
      await app.close();
    }
  });
});
