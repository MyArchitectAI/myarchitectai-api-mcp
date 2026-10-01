// Cross-repository synthetic HTTP proof. No production services or paid API calls.
// Link the companion checkout at .portal-smoke, then run npm run smoke:portal.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHostedServer } from '../dist/hosted-config.js';
import { createPortalHealthProbe } from '../dist/portal-account.js';
import { RemoteSessionRegistry } from '../dist/remote-session.js';
import { createMcpPortalHandler } from '../.portal-smoke/server/services/mcp-bridge/mcp-bridge.service.ts';

const portalBaseUrl = 'https://portal.example.test';
const canonicalResource = 'https://mcp.example.test/mcp';
const oauthIssuer = 'https://auth.example.test/auth/v1';
const signingSecret = 'synthetic-cross-repo-signing-secret-at-least-32-characters';
const userA = '00000000-0000-0000-0000-000000000001';
const userB = '00000000-0000-0000-0000-000000000002';
const unboundUser = '00000000-0000-0000-0000-000000000003';
const keys = { 1: 'synthetic-private-api-key-a', 2: 'synthetic-private-api-key-b' };
const disabled = new Set();
const calls = [];
const logs = [];
const receivedAssertions = [];
const clients = [];
const registrations = [];
const checks = [];
let failure;
const check = (name, actual, expected = true) => {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
const handler = createMcpPortalHandler({
  config: { signingSecret, canonicalResource, portalBaseUrl, oauthIssuer,
    oauthClientIds: ['smoke-client'], keyBindings: { [userA]: 1, [userB]: 2 },
    apiHost: 'https://api.example.test/v1' },
  getClientIdByUserId: async (id) => id === userA ? 101 : id === userB ? 102 : null,
  getApiKeyById: async (id) => ({ id, client_id: id + 100, aws_key_id: `aws-${id}` }),
  getAwsApiKey: async (id, options) => {
    assert.equal(options.bypassCache, true);
    return { id, enabled: !disabled.has(id), value: keys[id === 'aws-1' ? 1 : 2] };
  },
  fetch: async (url, init) => {
    assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers);
    assert.equal(headers.has('authorization'), false);
    const apiKey = headers.get('x-api-key');
    assert.ok(Object.values(keys).includes(apiKey));
    calls.push({ url: String(url), apiKey });
    if (failure === 'network') throw new Error('synthetic upstream connection lost');
    if (typeof failure === 'number') return Response.json({ error: 'synthetic upstream failure' }, { status: failure });
    const balance = apiKey === keys[1] ? 10 : 20;
    if (String(url).endsWith('/balance')) return Response.json({ balance, apiKey });
    if (String(url).endsWith('/auto-prompt')) return Response.json({
      output: 'synthetic architectural prompt', balance, cost: 0.05, requestId: 303, apiKey,
    });
    return Response.json({ output: ['https://cdn.example.test/result.png'], balance,
      cost: 0.25, requestId: apiKey === keys[1] ? 101 : 202, apiKey });
  },
  log: (event) => { logs.push(event); },
});
const portalServer = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const response = await handler(new Request(`${portalBaseUrl}${req.url}`, {
      method: req.method, headers: req.headers, body: Buffer.concat(chunks), signal: controller.signal,
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end();
  }
});
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const portalAddress = await listen(portalServer);
const portalFetch = async (url, init) => {
  assert.equal(new URL(url).origin, portalBaseUrl);
  const headers = new Headers(init.headers);
  assert.equal(headers.has('x-api-key'), false);
  assert.equal(headers.has('cookie'), false);
  receivedAssertions.push(headers.get('authorization'));
  switch (new URL(url).pathname) {
    case '/api/mcp/account': return fetch(`${portalAddress}/api/mcp/account`, init);
    case '/api/mcp/execute': return fetch(`${portalAddress}/api/mcp/execute`, init);
    case '/api/mcp/health': return fetch(`${portalAddress}/api/mcp/health`, init);
    default: throw new Error('Unexpected Portal operation');
  }
};
const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = await exportJWK(publicKey);
const mcpServer = createHostedServer({
  MCP_BILLING_MODE: 'api-balance', MCP_DEPLOYMENT_REVISION: 'a'.repeat(40),
  MCP_CANONICAL_RESOURCE: canonicalResource, PORTAL_SUPABASE_URL: 'https://auth.example.test',
  PORTAL_BASE_URL: portalBaseUrl, MCP_PORTAL_SIGNING_SECRET: signingSecret,
  MCP_OAUTH_CLIENT_IDS: '["smoke-client"]', MCP_ALLOWED_HOSTS: '["127.0.0.1"]',
  UPSTASH_REDIS_REST_URL: 'https://synthetic.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'synthetic',
  MCP_HISTORY_KEY_SECRET: 'synthetic-history-secret-at-least-32-characters',
}, {
  portalFetch, jwks: createLocalJWKSet({ keys: [{ ...jwk, alg: 'ES256', use: 'sig' }] }),
  sessions: new RemoteSessionRegistry(), registerWork: (work) => registrations.push(work),
});
const endpoint = new URL('/mcp', await listen(mcpServer));
const incomingTokens = [];
const connect = async (subject) => {
  const token = await new SignJWT({ client_id: 'smoke-client' }).setProtectedHeader({ alg: 'ES256' })
    .setIssuer(oauthIssuer).setAudience(canonicalResource).setSubject(subject)
    .setExpirationTime('5m').sign(privateKey);
  incomingTokens.push(token);
  const client = new Client({ name: 'portal-bridge-smoke', version: '0.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
};
const tool = (client, name, args = {}) => client.callTool({ name, arguments: args });
try {
  const a = await connect(userA);
  const b = await connect(userB);
  check('user A balance', (await tool(a, 'balance')).structuredContent, { balance: 10 });
  check('user B balance', (await tool(b, 'balance')).structuredContent, { balance: 20 });
  const generated = await tool(a, 'render_interior', { image: 'https://cdn.example.test/input.png', outputFormat: 'png' });
  check('generation succeeds', Boolean(generated.isError), false);
  check('cost preserved', generated.structuredContent.cost, 0.25);
  check('request id preserved', generated.structuredContent.requestId, 101);
  check('API key never returned', JSON.stringify(generated).includes(keys[1]), false);
  const prompt = await tool(b, 'auto_prompt', { image: 'https://cdn.example.test/input.png' });
  check('prompt remains scalar text', prompt.structuredContent.output, 'synthetic architectural prompt');
  check('user B API key used', calls.at(-1).apiKey, keys[2]);
  check('user B history isolated', (await tool(b, 'usage_summary')).structuredContent.totalCost, 0.05);
  await assert.rejects(connect(unboundUser));
  checks.push('unbound account rejected');
  const beforeDisable = calls.length;
  disabled.add('aws-1');
  await assert.rejects(tool(a, 'balance'));
  check('disabled account never calls API', calls.length, beforeDisable);
  disabled.clear();
  for (const mode of [429, 502, 'network']) {
    failure = mode;
    const before = calls.length;
    const result = await tool(a, 'render_interior', { image: 'https://cdn.example.test/input.png', outputFormat: 'png' });
    check(`failure ${mode} returned`, result.isError);
    check(`failure ${mode} no paid retry`, calls.length - before, 1);
  }
  failure = undefined;
  const beforeHealth = calls.length;
  check('service health delegates to Portal', await createPortalHealthProbe({ baseUrl: portalBaseUrl,
    issuer: oauthIssuer, canonicalResource, signingSecret }, { portalFetch })(new AbortController().signal));
  check('health never calls generation API', calls.length, beforeHealth);
  check('OAuth tokens never forwarded', receivedAssertions.some((value) => incomingTokens.some((token) => value.includes(token))), false);
  check('Portal logs exclude secrets', Object.values(keys).some((key) => JSON.stringify(logs).includes(key)), false);
  process.stdout.write(`${JSON.stringify({ status: 'PASS', checks: checks.length, transport: 'loopback HTTP for both services',
    realCloudCalls: 0, paidCalls: 0, assertions: checks })}\n`);
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  await Promise.allSettled(registrations);
  for (const server of [mcpServer, portalServer]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
