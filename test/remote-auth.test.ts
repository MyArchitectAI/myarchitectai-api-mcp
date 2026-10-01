import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT,
  type KeyLike } from 'jose';
import { createRemoteServer } from '../src/remote.js';

const resource = 'https://mcp.example.com/mcp';
const issuer = 'https://auth.example.com/auth/v1';
const clientId = 'trusted-client';
const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });

describe('remote bearer authentication', () => {
  let server: Server;
  let endpoint: URL;
  let sign: (claims?: Record<string, unknown>) => Promise<string>;
  let signingKey: KeyLike;

  before(async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    signingKey = privateKey;
    const publicJwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...publicJwk, alg: 'ES256', use: 'sig' }] });
    sign = async (claims = {}) => new SignJWT({ client_id: clientId, ...claims })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject('user-1')
      .setExpirationTime('5m')
      .sign(privateKey);
    server = createRemoteServer({
      auth: { canonicalResource: resource, issuer,
        allowedHosts: ['127.0.0.1'], jwks },
      resolveAccount: () => undefined,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const post = async (authorization?: string, suffix = ''): Promise<Response> => fetch(`${endpoint}${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: requestBody,
  });

  it('requires a bearer token and advertises protected-resource metadata', async () => {
    const response = await post();
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource"/);
    assert.ok(response.headers.get('x-request-id'));
    const metadata = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', endpoint));
    assert.deepEqual(await metadata.json(), {
      resource,
      authorization_servers: [issuer],
      scopes_supported: ['openid'],
    });
    const rootMetadata = await fetch(new URL('/.well-known/oauth-protected-resource', endpoint));
    assert.equal(rootMetadata.status, 200);
  });

  it('rejects missing, malformed, and non-bearer credential channels', async () => {
    const token = await sign();
    const attempts = [
      post(`Basic ${token}`),
      post(`Bearer ${token}`, '?access_token=leak'),
      fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'other' }, body: requestBody }),
      fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `token=${token}` }, body: requestBody }),
    ];
    const [basic, query, apiKey, cookie] = await Promise.all(attempts);
    assert.equal(basic?.status, 401);
    assert.equal(query?.status, 400);
    assert.equal(apiKey?.status, 401);
    assert.equal(cookie?.status, 401);
  });

  it('rejects wrong audience, issuer, malformed client claims, expiry, signature, and multi-audience tokens', async () => {
    const { privateKey: alienKey } = await generateKeyPair('ES256');
    const valid = await sign();
    const badTokens = [
      new SignJWT({ client_id: clientId }).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer)
        .setAudience('authenticated').setSubject('user-1').setExpirationTime('5m').sign(signingKey),
      new SignJWT({ client_id: clientId }).setProtectedHeader({ alg: 'ES256' }).setIssuer('https://alien.example')
        .setAudience(resource).setSubject('user-1').setExpirationTime('5m').sign(signingKey),
      ...['', ' ', ' client', 'client ', 42, null, ['client'], { id: 'client' }].map((value) => sign({ client_id: value })),
      new SignJWT({ client_id: clientId }).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer)
        .setAudience(resource).setSubject('user-1').setExpirationTime(-1).sign(signingKey),
      new SignJWT({ client_id: clientId }).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer)
        .setAudience(resource).setSubject('user-1').setExpirationTime('5m').sign(alienKey),
      new SignJWT({ client_id: clientId }).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer)
        .setAudience([resource, 'other']).setSubject('user-1').setExpirationTime('5m').sign(signingKey),
      new SignJWT({ client_id: clientId }).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer)
        .setAudience(resource).setSubject('user-1').sign(signingKey),
      new SignJWT({ client_id: clientId }).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer)
        .setAudience(resource).setSubject(' ').setExpirationTime('5m').sign(signingKey),
      new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer)
        .setAudience(resource).setSubject('user-1').setExpirationTime('5m').sign(signingKey),
      new SignJWT({ client_id: clientId }).setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer)
        .setAudience(resource).setSubject('user-1').setExpirationTime('5m').sign(new Uint8Array(32).fill(7)),
      Promise.resolve(`${valid.slice(0, -2)}xx`),
    ];
    for (const tokenPromise of badTokens) {
      const response = await post(`Bearer ${await tokenPromise}`);
      assert.equal(response.status, 401);
    }
    assert.equal((await post(`Bearer ${valid}`)).status, 403);
  });

  it('accepts another registered client token while still requiring an authorized Portal account', async () => {
    const token = await sign({ client_id: 'second-native-client' });
    const response = await post(`Bearer ${token}`);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Account not linked' });
  });

  it('returns 503 before account or tool work when JWKS is unavailable, while an unknown key remains 401', async () => {
    let lookups = 0;
    let clients = 0;
    const capturedErrors: Array<{ fingerprint: string; status: number }> = [];
    let failAsUnknownKey = false;
    const unavailableServer = createRemoteServer({
      auth: { canonicalResource: resource, issuer,
        allowedHosts: ['127.0.0.1'], jwks: async () => {
          if (failAsUnknownKey) {
            throw new errors.JWKSNoMatchingKey();
          }
          throw new Error('synthetic JWKS outage details');
        } },
      resolveAccount: () => { lookups++; return undefined; },
      createClient: () => { clients++; throw new Error('unexpected client creation'); },
      onError: (event) => { capturedErrors.push(event); },
    });
    unavailableServer.listen(0, '127.0.0.1');
    await once(unavailableServer, 'listening');
    const address = unavailableServer.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const send = (token?: string) => fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: requestBody });
    try {
      const unavailable = await send(await sign());
      assert.equal(unavailable.status, 503);
      assert.deepEqual(await unavailable.json(), { error: 'Authentication unavailable' });
      assert.equal(unavailable.headers.get('www-authenticate'), null);
      assert.deepEqual(capturedErrors.map(({ fingerprint, status }) => ({ fingerprint, status })),
        [{ fingerprint: 'remote.auth', status: 503 }]);
      assert.equal((await send()).status, 401);
      failAsUnknownKey = true;
      const unknownKey = await send(await sign());
      assert.equal(unknownKey.status, 401);
      assert.match(unknownKey.headers.get('www-authenticate') ?? '', /^Bearer /);
      assert.deepEqual([lookups, clients], [0, 0]);
    } finally {
      await new Promise<void>((resolve) => unavailableServer.close(() => resolve()));
    }
  });
});
