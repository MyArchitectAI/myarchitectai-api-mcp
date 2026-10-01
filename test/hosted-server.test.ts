import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHostedServer } from '../src/hosted-config.js';
import { RemoteSessionRegistry } from '../src/remote-session.js';
import { hostedEnv } from './fixtures/hosted-env.js';

const subject = '00000000-0000-0000-0000-000000000001';
const issuer = 'https://portal-project.supabase.co/auth/v1';
const resource = 'https://mcp.myarchitectai.com/mcp';

describe('hosted Node server assembly', () => {
  it('registers the full MCP request lifetime and keeps API keys inside Portal', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: 'ES256', use: 'sig' }] });
    const registrations: Promise<void>[] = [];
    let portalReads = 0;
    let executions = 0;
    let upstreamStarted: (() => void) | undefined;
    let finishUpstream: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { upstreamStarted = resolve; });
    const upstreamGate = new Promise<void>((resolve) => { finishUpstream = resolve; });
    const portalFetch: typeof fetch = async (input, init) => {
      portalReads++;
      assert.ok(new Headers(init?.headers).get('authorization')?.startsWith('Bearer '));
      assert.equal(new Headers(init?.headers).has('x-api-key'), false);
      const url = new URL(String(input));
      if (url.pathname.endsWith('/account')) { return Response.json({ authorized: true }); }
      assert.equal(url.pathname, '/api/mcp/execute');
      executions++;
      upstreamStarted?.();
      await upstreamGate;
      return Response.json({ balance: 17 });
    };
    const server = createHostedServer({ ...hostedEnv(), MYARCHITECTAI_API_KEY: 'wrong-shared-guest-key' }, {
      registerWork: (work) => { registrations.push(work); }, jwks, sessions: new RemoteSessionRegistry(),
      portalFetch,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    try {
      const health = await fetch(new URL('/health', endpoint));
      assert.deepEqual(await health.json(), { status: 'ok', scope: 'process',
        revision: '0123456789abcdef0123456789abcdef01234567' });
      assert.equal((await fetch(new URL('/health/deep', endpoint))).status, 404);
      assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
      const token = await new SignJWT({ client_id: 'trusted-client' })
        .setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer).setAudience(resource)
        .setSubject(subject).setExpirationTime('5m').sign(privateKey);
      const client = new Client({ name: 'synthetic-hosted-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
      try {
        const balanceWork = client.callTool({ name: 'balance', arguments: {} });
        await started;
        const registeredBalance = registrations.at(-1);
        assert.ok(registeredBalance);
        let settled = false;
        void registeredBalance.then(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(settled, false);
        finishUpstream?.();
        const balance = await balanceWork;
        assert.deepEqual(balance.structuredContent, { balance: 17 });
        await registeredBalance;
        assert.equal(settled, true);
        assert.equal(executions, 1);
        assert.ok(portalReads >= 3);
      } finally {
        finishUpstream?.();
        await client.close();
      }
      await Promise.all(registrations);
    } finally {
      finishUpstream?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects before handler admission when lifecycle registration fails', async () => {
    let portalReads = 0;
    const server = createHostedServer(hostedEnv(), {
      registerWork: () => { throw new Error('synthetic lifecycle failure'); },
      sessions: new RemoteSessionRegistry(),
      portalFetch: async () => { portalReads++; return new Response('[]'); },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      assert.equal(response.status, 503);
      assert.equal(portalReads, 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
