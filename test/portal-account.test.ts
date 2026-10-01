import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { jwtVerify } from 'jose';
import { createPortalAccountResolver, createPortalHealthProbe } from '../src/portal-account.js';
import { createPortalRequest, type PortalOptions } from '../src/portal-transport.js';

const subject = '00000000-0000-0000-0000-000000000001';
const options: PortalOptions = {
  baseUrl: 'https://portal.example', issuer: 'https://portal-project.supabase.co/auth/v1',
  canonicalResource: 'https://mcp.myarchitectai.com/mcp', signingSecret: 'synthetic-signing-secret-32-characters-long',
};
const identity = { issuer: options.issuer, subject, clientId: 'approved-client' };
const context = () => ({ signal: new AbortController().signal });

const verify = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  assert.equal(headers.has('x-api-key'), false);
  assert.equal(headers.has('cookie'), false);
  assert.equal(headers.has('apikey'), false);
  assert.equal(init?.redirect, 'error');
  const token = headers.get('authorization')?.replace(/^Bearer /, '');
  assert.ok(token);
  const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(options.signingSecret), {
    algorithms: ['HS256'], issuer: options.canonicalResource, audience: `${options.baseUrl}/api/mcp`,
  });
  assert.equal(protectedHeader.typ, 'mcp-portal+jwt');
  assert.equal(payload.exp! - payload.iat!, 60);
  assert.equal(payload.request_hash, createHash('sha256').update(`POST\n${new URL(String(input)).pathname}\n${String(init?.body)}`).digest('hex'));
  assert.ok(payload.jti);
  return payload;
};

describe('Portal-owned MCP accounts', () => {
  it('uses a separate signed, request-bound credential and keeps API keys out of MCP', async () => {
    const assertions: string[] = [];
    const resolve = createPortalAccountResolver(options, { portalFetch: async (url, init) => {
      const claims = await verify(url, init);
      assert.equal(claims.sub, subject);
      assert.equal(claims.client_id, identity.clientId);
      assert.equal(claims.oauth_issuer, identity.issuer);
      assertions.push(String(claims.jti));
      if (String(url).endsWith('/account')) { return Response.json({ authorized: true }); }
      assert.deepEqual(JSON.parse(String(init?.body)), { path: '/balance' });
      return Response.json({ balance: 23 });
    } });
    const account = await resolve(identity, context());
    assert.ok(account && 'client' in account);
    assert.equal('apiKey' in account, false);
    assert.equal('config' in account, false);
    assert.deepEqual(await account.client.balance(), { balance: 23 });
    assert.equal(new Set(assertions).size, 2);
  });

  it('checks admission every time and keeps two user identities isolated', async () => {
    const users: string[] = [];
    const resolve = createPortalAccountResolver(options, { portalFetch: async (url, init) => {
      const claims = await verify(url, init);
      users.push(String(claims.sub));
      return Response.json({ authorized: true });
    } });
    await resolve(identity, context());
    await resolve({ ...identity, subject: '00000000-0000-0000-0000-000000000002' }, context());
    await resolve(identity, context());
    assert.deepEqual(users, [subject, '00000000-0000-0000-0000-000000000002', subject]);
  });

  it('rejects foreign issuers, malformed subjects and cancellation before I/O', async () => {
    let calls = 0;
    const resolve = createPortalAccountResolver(options, { portalFetch: async () => { calls++; return Response.json({ authorized: true }); } });
    assert.equal(await resolve({ ...identity, issuer: 'https://foreign.example' }, context()), undefined);
    await assert.rejects(Promise.resolve(resolve({ ...identity, subject: 'not-a-uuid' }, context())));
    const controller = new AbortController(); controller.abort();
    assert.equal(await resolve(identity, { signal: controller.signal }), undefined);
    assert.equal(calls, 0);
  });

  it('refuses missing, deleted, ambiguous, foreign and disabled accounts when Portal denies access', async () => {
    const resolve = createPortalAccountResolver(options, { portalFetch: async () => Response.json({ error: 'Forbidden' }, { status: 403 }) });
    assert.equal(await resolve(identity, context()), undefined);
    for (const response of [Response.json({ authorized: false }), Response.json({}), Response.json({ error: 'Unavailable' }, { status: 503 })]) {
      const broken = createPortalAccountResolver(options, { portalFetch: async () => response });
      await assert.rejects(Promise.resolve(broken(identity, context())));
    }
  });

  it('preserves costs, balances, request IDs, scalar prompts and streamed API errors', async () => {
    let response = { output: ['https://images.example/result.png'], balance: 9, cost: 1, requestId: 42 };
    const resolve = createPortalAccountResolver(options, { portalFetch: async (url) => String(url).endsWith('/account')
      ? Response.json({ authorized: true }) : Response.json(response) });
    const account = await resolve(identity, context()); assert.ok(account && 'client' in account);
    assert.deepEqual(await account.client.generate('/render/interior', {}), response);
    const prompt = createPortalAccountResolver(options, { portalFetch: async (url) => String(url).endsWith('/account')
      ? Response.json({ authorized: true }) : Response.json({ ...response, output: 'A bright room' }) });
    const p = await prompt(identity, context()); assert.ok(p && 'client' in p);
    assert.deepEqual(await p.client.autoPrompt({}), { ...response, output: 'A bright room' });
    response = { ...response, ...{ error: 'Insufficient balance' } };
    await assert.rejects(account.client.generate('/render/interior', {}), /Insufficient balance/);
  });

  it('never retries a paid call after Portal 429, 502, 504 or an uncertain network failure', async () => {
    for (const status of [429, 502, 504, 0]) {
      let paidCalls = 0;
      const resolve = createPortalAccountResolver(options, { portalFetch: async (url) => {
        if (String(url).endsWith('/account')) { return Response.json({ authorized: true }); }
        paidCalls++;
        if (status === 0) { throw new Error('Connection lost'); }
        return Response.json({ error: 'Synthetic failure' }, { status });
      } });
      const account = await resolve(identity, context()); assert.ok(account && 'client' in account);
      await assert.rejects(account.client.generate('/render/interior', {}));
      assert.equal(paidCalls, 1);
    }
  });

  it('uses service-only health assertions and never executes generation during a health probe', async () => {
    const probe = createPortalHealthProbe(options, { portalFetch: async (url, init) => {
      assert.equal(String(url), `${options.baseUrl}/api/mcp/health`);
      assert.equal(init?.body, '{}');
      const claims = await verify(url, init);
      assert.equal(claims.sub, 'mcp-service');
      assert.equal(claims.oauth_issuer, undefined);
      assert.equal(claims.client_id, undefined);
      return Response.json({ status: 'ok' });
    } });
    assert.equal(await probe(context().signal), true);
    const fail = createPortalHealthProbe(options, { portalFetch: async () => Response.json({ status: 'unavailable' }, { status: 503 }) });
    assert.equal(await fail(context().signal), false);
  });

  it('preserves rate-limit backoff without forwarding unrelated upstream headers', async () => {
    const request = createPortalRequest(options, { portalFetch: async () => Response.json({ error: 'Slow down' }, {
      status: 429, headers: { 'retry-after': '8', 'set-cookie': 'private=secret', 'x-api-key': 'secret' },
    }) });
    const response = await request('execute', { path: '/balance' }, identity, context().signal);
    assert.equal(response.headers.get('retry-after'), '8');
    assert.equal(response.headers.has('set-cookie'), false);
    assert.equal(response.headers.has('x-api-key'), false);
  });

  it('rejects unsafe Portal origins, weak signing secrets and redirects', async () => {
    for (const baseUrl of ['http://portal.example', 'https://name:secret@portal.example', 'https://portal.example/forward', 'https://portal.example?host=other']) {
      assert.throws(() => createPortalRequest({ ...options, baseUrl }));
    }
    assert.throws(() => createPortalRequest({ ...options, signingSecret: 'short' }));
    const request = createPortalRequest(options, { portalFetch: async () => new Response(null, { status: 302, headers: { location: 'https://other.example' } }) });
    await assert.rejects(request('account', {}, identity, context().signal), /redirects/);
  });

  it('bounds request and response bodies and cancels oversized streams', async () => {
    let cancelled = false;
    const request = createPortalRequest(options, { portalFetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2_000_001)); },
      cancel() { cancelled = true; },
    })) });
    await assert.rejects(request('execute', { input: 'x'.repeat(1_000_001) }, identity, context().signal), /request too large/);
    await assert.rejects(request('account', {}, identity, context().signal), /response too large/);
    assert.equal(cancelled, true);
  });

  it('cancels uncooperative lookup and response-body dependencies without waiting for them', async () => {
    for (const bodyStall of [false, true]) {
      const controller = new AbortController();
      let cancelled = false;
      const request = createPortalRequest(options, { portalFetch: async () => {
        if (!bodyStall) { return await new Promise<Response>(() => undefined); }
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      } });
      const pending = request('account', {}, identity, controller.signal);
      const timer = setTimeout(() => controller.abort(), 10);
      try { await assert.rejects(pending, /aborted/); } finally { clearTimeout(timer); }
      if (bodyStall) { assert.equal(cancelled, true); }
    }
  });
});
