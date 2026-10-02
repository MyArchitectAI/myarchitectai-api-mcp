import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyDeployment } from './verify-deployment.mjs';

const origin = 'https://mcp.myarchitectai.com';
const revision = 'a'.repeat(40);
const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

const fixture = (overrides = {}) => {
  const requests = [];
  const replies = {
    '/health': json({ status: 'ok', scope: 'process', revision }),
    '/.well-known/oauth-protected-resource': json({
      resource: `${origin}/mcp`, authorization_servers: ['https://auth.example.test'],
    }),
    '/mcp': new Response('', { status: 401, headers: {
      'www-authenticate': `Bearer resource_metadata="${metadataUrl}", scope="openid"`,
    } }),
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url: url.href, method: init.method ?? 'GET', redirect: init.redirect, cache: init.cache });
    const response = replies[url.pathname];
    assert.ok(response, `Unexpected path: ${url.pathname}`);
    return response;
  };
  return { fetchImpl, requests };
};

test('verifies the live revision, canonical discovery and unauthenticated challenge', async () => {
  const { fetchImpl, requests } = fixture();
  const result = await verifyDeployment({ origin, revision, fetchImpl });
  assert.equal(result.resource, `${origin}/mcp`);
  assert.deepEqual(requests.map(({ url, method }) => [url, method]), [
    [`${origin}/health`, 'GET'],
    [metadataUrl, 'GET'],
    [`${origin}/mcp`, 'POST'],
  ]);
  assert.ok(requests.every(({ redirect, cache }) => redirect === 'manual' && cache === 'no-store'));
});

test('rejects a healthy older deployment before probing the MCP route', async () => {
  const { fetchImpl, requests } = fixture({ '/health': json({ status: 'ok', scope: 'process', revision: 'b'.repeat(40) }) });
  await assert.rejects(verifyDeployment({ origin, revision, fetchImpl }), /live revision/);
  assert.equal(requests.length, 1);
});

test('rejects metadata for another resource', async () => {
  const { fetchImpl } = fixture({
    '/.well-known/oauth-protected-resource': json({ resource: `${origin}/other`, authorization_servers: ['https://auth.example.test'] }),
  });
  await assert.rejects(verifyDeployment({ origin, revision, fetchImpl }), /canonical resource mismatch/);
});

test('rejects a challenge without the exact canonical metadata URL', async () => {
  const { fetchImpl } = fixture({ '/mcp': new Response('', { status: 401, headers: {
    'www-authenticate': 'Bearer resource_metadata="https://other.example.test/.well-known/oauth-protected-resource"',
  } }) });
  await assert.rejects(verifyDeployment({ origin, revision, fetchImpl }), /did not advertise canonical/);
});

test('rejects an unauthenticated MCP endpoint that accepts the request', async () => {
  const { fetchImpl } = fixture({ '/mcp': json({ jsonrpc: '2.0', result: {} }) });
  await assert.rejects(verifyDeployment({ origin, revision, fetchImpl }), /expected unauthenticated HTTP 401/);
});

test('rejects redirects and invalid metadata rather than treating them as readiness', async () => {
  const redirect = fixture({ '/health': new Response('', { status: 302, headers: { location: '/login' } }) });
  await assert.rejects(verifyDeployment({ origin, revision, fetchImpl: redirect.fetchImpl }), /expected HTTP 200/);
  const invalidIssuer = fixture({
    '/.well-known/oauth-protected-resource': json({ resource: `${origin}/mcp`, authorization_servers: ['http://auth.example.test'] }),
  });
  await assert.rejects(verifyDeployment({ origin, revision, fetchImpl: invalidIssuer.fetchImpl }), /HTTPS authorization server/);
});
