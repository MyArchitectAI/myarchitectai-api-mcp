import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { createRemoteAuthenticator, RemoteAuthenticationUnavailableError } from '../src/remote-auth.js';
import { validateRemoteHttpConfig } from '../src/remote-config.js';
import { instrumentExternalFetch } from '../src/remote-observability.js';

type Event = Record<string, string | number | undefined>;
const secret = 'synthetic-secret-should-never-appear';

describe('external boundary observability', () => {
  it('logs one safe event for a response and no request data', async () => {
    const events: Event[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls++;
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, `Bearer ${secret}`);
      return new Response('{}', { status: 200 });
    };
    const observed = instrumentExternalFetch(fetchImpl,
      { vendor: 'api_portal', operation: 'account', timeoutMs: 5000, maxAttempts: 1 },
      (fields) => { events.push(fields); });
    await observed(`https://portal.example.test/path?token=${secret}`, {
      method: 'GET', headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(calls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.['http.response.status_code'], 200);
    assert.equal(events[0]?.outcome, 'ok');
    assert.match(String(events[0]?.request_id), /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(events), /synthetic-secret|portal\.example|token=|authorization|path/);
  });

  it('logs a fixed failure shape and preserves the error without retrying', async () => {
    const events: Event[] = [];
    let calls = 0;
    const failure = new Error(secret);
    const fetchImpl: typeof fetch = async () => { calls++; throw failure; };
    const observed = instrumentExternalFetch(fetchImpl,
      { vendor: 'api_portal', operation: 'execute', timeoutMs: 5000, maxAttempts: 1 },
      (fields) => { events.push(fields); });
    await assert.rejects(observed('https://apigateway.example.test/apikeys/secret'), (error) => error === failure);
    assert.equal(calls, 1);
    assert.equal(events[0]?.outcome, 'server_error');
    assert.equal(events[0]?.fingerprint, 'remote.external.api_portal.execute');
    assert.equal(events[0]?.['http.response.status_code'], undefined);
    assert.doesNotMatch(JSON.stringify(events), /synthetic-secret|apikeys/);
  });

  it('keeps the caller signal attached to a streamed body after headers arrive', async () => {
    const abort = new AbortController();
    const init: RequestInit = { method: 'POST', signal: abort.signal };
    const fetchImpl: typeof fetch = async (_input, receivedInit) => {
      assert.equal(receivedInit, init);
      assert.equal(receivedInit.signal, abort.signal);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          receivedInit.signal?.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true });
        },
      });
      return new Response(stream, { status: 200 });
    };
    const observed = instrumentExternalFetch(fetchImpl,
      { vendor: 'api_portal', operation: 'execute', timeoutMs: 120000, maxAttempts: 1 },
      () => undefined);
    const response = await observed('https://portal.example.test/api/mcp/execute', init);
    const body = response.text();
    abort.abort();
    await assert.rejects(body, /body aborted/);
  });

  it('labels signing-key resolution separately from HTTP egress and omits JWTs', async () => {
    const events: Event[] = [];
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const resource = 'https://mcp.example.test/mcp';
    const issuer = 'https://auth.example.test';
    const token = await new SignJWT({ client_id: 'trusted-client' }).setProtectedHeader({ alg: 'ES256' })
      .setIssuer(issuer).setAudience(resource).setSubject('synthetic-user').setExpirationTime('5m').sign(privateKey);
    const config = validateRemoteHttpConfig({ canonicalResource: resource, issuer });
    const request = { rawHeaders: ['Authorization', `Bearer ${token}`],
      headers: { authorization: `Bearer ${token}` } } as IncomingMessage;
    const resolveKey = async (): Promise<typeof publicKey> => publicKey;
    const auth = createRemoteAuthenticator(config, resolveKey, (fields) => { events.push(fields); });
    assert.equal((await auth(request)).subject, 'synthetic-user');
    assert.equal(events[0]?.event, 'remote_jwks_key_resolution');
    assert.equal(events[0]?.operation, 'resolve_signing_key');
    assert.equal(events[0]?.outcome, 'ok');
    const failing = createRemoteAuthenticator(config, async () => { throw new Error(secret); },
      (fields) => { events.push(fields); });
    await assert.rejects(failing(request), RemoteAuthenticationUnavailableError);
    assert.equal(events[1]?.outcome, 'server_error');
    assert.doesNotMatch(JSON.stringify(events), /synthetic-secret|synthetic-user|eyJ/);
  });

  it('keeps the Vercel manifest scoped to account and JWKS dependencies', async () => {
    const manifest: unknown = JSON.parse(await readFile(new URL('../deploy/manifest.json', import.meta.url), 'utf8'));
    assert.ok(manifest && typeof manifest === 'object' && 'deployment' in manifest && 'health' in manifest && 'dependencies' in manifest);
    const record = manifest as { deployment: { provider: string; productionOrigin: string }; health: { deepChecks: string[] };
      dependencies: Array<{ service: string; maxAttempts: number; timeoutMs: number }> };
    assert.equal(record.deployment.provider, 'vercel');
    assert.equal(record.deployment.productionOrigin, 'https://mcp.myarchitectai.com');
    assert.deepEqual(record.health.deepChecks, ['account', 'jwks']);
    assert.deepEqual(record.dependencies.map((dependency) => dependency.service),
      ['api_portal', 'supabase_jwks']);
    assert.ok(record.dependencies.every((dependency) => dependency.maxAttempts === 1 && dependency.timeoutMs === 5000));
    assert.doesNotMatch(JSON.stringify(manifest), /laserfocused|systemd|localhost|127\.0\.0\.1/i);
  });
});
