import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
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
      auth: { canonicalResource: resource, issuer, allowedOAuthClientIds: [clientId],
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

  it('rejects wrong audience, issuer, client, expiry, signature, and multi-audience tokens', async () => {
    const { privateKey: alienKey } = await generateKeyPair('ES256');
    const valid = await sign();
    const badTokens = [
      new SignJWT({ client_id: clientId }).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer)
        .setAudience('authenticated').setSubject('user-1').setExpirationTime('5m').sign(signingKey),
      new SignJWT({ client_id: clientId }).setProtectedHeader({ alg: 'ES256' }).setIssuer('https://alien.example')
        .setAudience(resource).setSubject('user-1').setExpirationTime('5m').sign(signingKey),
      sign({ client_id: 'other-client' }),
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
});
