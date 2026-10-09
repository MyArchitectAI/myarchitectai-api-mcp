import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHostedServer } from '../src/hosted-config.js';
import { hostedEnv } from './fixtures/hosted-env.js';

const subject = '00000000-0000-0000-0000-000000000001';
const issuer = 'https://portal-project.supabase.co/auth/v1';
const resource = 'https://mcp.myarchitectai.com/mcp';

describe('hosted Node server assembly', () => {
  it('passes public safety errors through the authenticated Portal bridge once per tool call', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: 'ES256', use: 'sig' }] });
    const registrations: Promise<void>[] = [];
    let executions = 0;
    let status = 200;
    let code = 'CONTENT_POLICY_VIOLATION';
    let expectedPath = '/render/exterior';
    const server = createHostedServer(hostedEnv(), {
      registerWork: (work) => { registrations.push(work); }, jwks,
      portalFetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/account')) return Response.json({ authorized: true });
        assert.equal(url.pathname, '/api/mcp/execute');
        assert.ok(new Headers(init?.headers).get('authorization')?.startsWith('Bearer '));
        assert.equal(new Headers(init?.headers).has('x-api-key'), false);
        const request = JSON.parse(String(init?.body)) as { path: string };
        assert.equal(request.path, expectedPath);
        executions++;
        return Response.json({ error: 'private upstream detail', code, balance: 4.75,
          cost: code === 'CONTENT_POLICY_VIOLATION' ? 0.25 : 0, requestId: 884,
          providerDetail: 'private provider response' }, { status, headers: { 'retry-after': '0' } });
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const token = await new SignJWT({ client_id: 'trusted-client' })
      .setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer).setAudience(resource)
      .setSubject(subject).setExpirationTime('5m').sign(privateKey);
    const client = new Client({ name: 'synthetic-hosted-safety-test', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }) as unknown as Parameters<Client['connect']>[0]);
      await client.listTools();
      for (const safetyCode of ['CONTENT_POLICY_VIOLATION', 'SAFETY_CHECK_UNAVAILABLE']) {
        code = safetyCode;
        for (const httpStatus of [200, 429, 502]) {
          status = httpStatus;
          for (const operation of [
            { name: 'render_exterior', path: '/render/exterior', args: { image: 'https://x/i.png', outputFormat: 'png' } },
            { name: 'auto_prompt', path: '/auto-prompt', args: { image: 'https://x/i.png' } },
          ]) {
            expectedPath = operation.path;
            const before = executions;
            const result = await client.callTool({ name: operation.name, arguments: operation.args });
            assert.equal(result.isError, true);
            assert.deepEqual(result.structuredContent, {
              error: code === 'CONTENT_POLICY_VIOLATION' ? 'Request blocked by content policy' : 'Content safety check unavailable',
              code, balance: 4.75, cost: code === 'CONTENT_POLICY_VIOLATION' ? 0.25 : 0, requestId: 884,
            });
            assert.doesNotMatch(JSON.stringify(result), /private|providerDetail/);
            assert.equal(executions, before + 1);
          }
        }
      }
    } finally {
      await client.close();
      await Promise.all(registrations);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

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
      registerWork: (work) => { registrations.push(work); }, jwks,
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
