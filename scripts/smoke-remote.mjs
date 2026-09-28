// Synthetic runtime smoke for the published remote entry point. No production
// account, image host, or authorization server is contacted.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { MyArchitectAIClient } from '../dist/client.js';
import { MediaService } from '../dist/media.js';
import { createRemoteServer } from '../dist/remote.js';

const resource = 'https://mcp.example.test/mcp';
const issuer = 'https://auth.example.test';
const oauthClientId = 'synthetic-smoke-client';
const apiOrigin = 'https://api.example.test/v1';
const imageUrl = 'https://cdn.example.test/tiny.png';
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const dataUri = `data:image/png;base64,${tinyPng}`;
const pngBytes = Buffer.from(tinyPng, 'base64');
const expectedTools = [
  'animate', 'auto_prompt', 'balance', 'change_textures', 'edit_by_prompt',
  'list_recent_generations', 'preview_image', 'render_exterior', 'render_interior',
  'set_atmosphere', 'style_transfer', 'text_to_image', 'upscale', 'upscale_4k',
  'usage_summary', 'validate_image_url',
];
const fixtures = [
  ['render_exterior', { image: imageUrl, outputFormat: 'png' }],
  ['render_interior', { image: imageUrl, outputFormat: 'png' }],
  ['style_transfer', { image: imageUrl, referenceImage: imageUrl, outputFormat: 'webp' }],
  ['text_to_image', { prompt: 'synthetic exterior', outputFormat: 'png', outputWidth: 256, outputHeight: 256 }],
  ['upscale_4k', { image: imageUrl }],
  ['auto_prompt', { image: imageUrl }],
  ['edit_by_prompt', { image: imageUrl, prompt: 'synthetic edit' }],
  ['change_textures', { image: imageUrl, mask: imageUrl, prompt: 'oak' }],
  ['set_atmosphere', { image: imageUrl, sceneType: 'exterior', weather: 'clear' }],
  ['animate', { startFrameUrl: imageUrl, prompt: 'slow pan' }],
  ['upscale', { image: imageUrl, targetResolution: '8k', outputFormat: 'webp' }],
];

const checks = [];
let activeCheck = 'startup';
const check = (name, actual, expected = true) => {
  activeCheck = name;
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
const tool = async (client, name, args = {}) => client.callTool({ name, arguments: args });
const closeServer = (server) => new Promise((resolve, reject) => {
  server.closeAllConnections?.();
  server.close((error) => error ? reject(error) : resolve());
});

let server;
const clients = [];
try {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'synthetic-smoke-key';
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';
  const sign = (subject, audience = resource, clientId = oauthClientId) => new SignJWT({ client_id: clientId, scope: 'mcp:tools' })
    .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid, typ: 'JWT' })
    .setIssuer(issuer).setSubject(subject).setAudience(audience).setIssuedAt().setExpirationTime('5m')
    .sign(privateKey);
  const [tokenA, tokenB, wrongAudience, wrongClient] = await Promise.all([
    sign('user-a'), sign('user-b'), sign('user-a', 'https://other.example.test/mcp'),
    sign('user-a', resource, 'unapproved-client'),
  ]);

  const upstreamCalls = [];
  const mediaCalls = [];
  let sequence = 0;
  const apiFetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin + url.pathname.slice(0, 3), apiOrigin, 'Unexpected API destination');
    assert.equal(init?.method, 'POST');
    const key = init.headers['x-api-key'];
    assert.ok(key === 'synthetic-upstream-a' || key === 'synthetic-upstream-b');
    assert.notEqual(key, tokenA);
    assert.notEqual(key, tokenB);
    const path = url.pathname.slice('/v1'.length);
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    upstreamCalls.push({ key, path });
    const json = (bodyValue, status = 200) => new Response(JSON.stringify(bodyValue), {
      status, headers: { 'content-type': 'application/json' },
    });
    if (path === '/balance') return json({ balance: key.endsWith('-a') ? 0 : 24 });
    if (body?.prompt === 'synthetic-insufficient-balance') {
      return json({ error: 'Insufficient balance', balance: 0, cost: 0 }, 400);
    }
    if (body?.prompt === 'synthetic-streamed-failure') {
      return json({ error: 'Invalid image', balance: 0, cost: 0 });
    }
    sequence += 1;
    return json({
      output: path === '/auto-prompt' ? 'synthetic architectural description' : [`https://cdn.example.test/out-${sequence}.png`],
      balance: 20 - sequence * 0.25,
      cost: 0.25,
      requestId: sequence,
    });
  };
  const mediaFetch = async (input, init) => {
    assert.equal(String(input), imageUrl, 'Unexpected image destination');
    assert.ok(init?.method === 'GET' || init?.method === 'HEAD');
    mediaCalls.push(init.method);
    return new Response(init.method === 'HEAD' ? null : pngBytes, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(pngBytes.length) },
    });
  };
  const configFor = (subject) => ({
    apiKey: `synthetic-upstream-${subject === 'user-a' ? 'a' : 'b'}`,
    baseUrl: apiOrigin,
    timeoutMs: 2_000,
    maxRetries: 0,
    downloadDir: 'renders',
    maxPreviewBytes: 1024,
    stateFile: undefined,
  });
  server = createRemoteServer({
    auth: {
      canonicalResource: resource,
      issuer,
      jwks: createLocalJWKSet({ keys: [publicJwk] }),
      allowedOAuthClientIds: [oauthClientId],
      allowedHosts: ['127.0.0.1'],
      requestTimeoutMs: 10_000,
    },
    resolveAccount: ({ subject }) => configFor(subject),
    createClient: (config) => new MyArchitectAIClient(config, apiFetch),
    createMedia: (config) => new MediaService({
      timeoutMs: config.timeoutMs,
      maxBytes: config.maxPreviewBytes,
      fetchImpl: mediaFetch,
    }),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const localUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'remote-smoke', version: '0.0.0' },
  } };
  const post = (token) => fetch(localUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(initialize),
  });
  const challenge = await post();
  check('unauthenticated challenge', challenge.status, 401);
  const challengeHeader = challenge.headers.get('www-authenticate') ?? '';
  check('bearer challenge', /^Bearer\b/i.test(challengeHeader));
  const metadataMatch = challengeHeader.match(/resource_metadata="([^"]+)"/);
  check('resource metadata link', Boolean(metadataMatch));
  const metadataUrl = new URL(metadataMatch[1]);
  check('metadata on canonical origin', metadataUrl.origin, new URL(resource).origin);
  const metadataResponse = await fetch(new URL(metadataUrl.pathname, localUrl.origin));
  check('resource metadata status', metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  check('canonical resource', metadata.resource, resource);
  check('authorization server', metadata.authorization_servers?.includes(issuer));
  check('wrong audience refused', (await post(wrongAudience)).status, 401);
  check('unapproved OAuth client refused', (await post(wrongClient)).status, 401);
  check('malformed token refused', (await post('not-a-jwt')).status, 401);
  check('rejected tokens made no upstream calls', upstreamCalls.length, 0);

  const connect = async (token) => {
    const client = new Client({ name: 'remote-smoke', version: '0.0.0' });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(localUrl, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return client;
  };
  const userA = await connect(tokenA);
  const userB = await connect(tokenB);
  const listed = (await userA.listTools()).tools.map((entry) => entry.name).sort();
  check('exact remote tool surface', listed, expectedTools);
  check('save_image absent', listed.includes('save_image'), false);
  const balance = await tool(userA, 'balance');
  check('zero balance is free read', balance.isError === true, false);
  check('zero balance value', balance.structuredContent?.balance, 0);

  for (const [name, args] of fixtures) {
    const result = await tool(userA, name, args);
    check(`${name} success`, result.isError === true, false);
    check(`${name} structured response`, typeof result.structuredContent?.cost, 'number');
  }
  const previewData = await tool(userA, 'preview_image', { url: dataUri });
  check('inline PNG preview', previewData.content?.some((item) => item.type === 'image'));
  const previewPublic = await tool(userA, 'preview_image', { url: imageUrl });
  check('public PNG preview', previewPublic.content?.some((item) => item.type === 'image'));
  const validated = await tool(userA, 'validate_image_url', { url: imageUrl });
  check('public image validation', validated.structuredContent?.ok && validated.structuredContent?.isImage);
  const summaryA = await tool(userA, 'usage_summary');
  check('user A generation count', summaryA.structuredContent?.totalGenerations, fixtures.length);
  const recentA = await tool(userA, 'list_recent_generations', { limit: 20 });
  check('user A history count', recentA.structuredContent?.generations?.length, fixtures.length);

  const rejectedPath = await tool(userA, 'preview_image', { url: '/tmp/remote-smoke.png' });
  check('local path denied', rejectedPath.isError, true);
  const rejectedOpen = await tool(userA, 'preview_image', { url: imageUrl, open: true });
  check('browser open denied', rejectedOpen.isError, true);
  check('denied media requests did not fetch', mediaCalls, ['GET', 'HEAD']);
  const emptyB = await tool(userB, 'usage_summary');
  check('user B starts with isolated history', emptyB.structuredContent?.totalGenerations, 0);
  const recentB = await tool(userB, 'list_recent_generations');
  check('user B recent history isolated', recentB.structuredContent?.generations?.length, 0);
  const generatedB = await tool(userB, 'render_exterior', fixtures[0][1]);
  check('user B generation succeeds', generatedB.isError === true, false);
  const summaryAAfterB = await tool(userA, 'usage_summary');
  check('user A history unaffected by B', summaryAAfterB.structuredContent?.totalGenerations, fixtures.length);
  check('distinct upstream credentials', new Set(upstreamCalls.map(({ key }) => key)).size, 2);
  check('user B upstream credential', upstreamCalls.at(-1)?.key, 'synthetic-upstream-b');

  const beforeFailures = upstreamCalls.length;
  const insufficient = await tool(userA, 'render_interior', {
    image: imageUrl, outputFormat: 'png', prompt: 'synthetic-insufficient-balance',
  });
  check('insufficient balance isError', insufficient.isError, true);
  const streamedFailure = await tool(userA, 'edit_by_prompt', {
    image: imageUrl, prompt: 'synthetic-streamed-failure',
  });
  check('streamed failure isError', streamedFailure.isError, true);
  check('charged failures called exactly once', upstreamCalls.length - beforeFailures, 2);
  const afterFailures = await tool(userA, 'usage_summary');
  check('failed generations counted', afterFailures.structuredContent?.failedGenerations, 2);

  process.stdout.write(`${JSON.stringify({ status: 'pass', checks: checks.length, tools: listed.length, toolNames: listed })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'fail', check: activeCheck, errorType: error instanceof Error ? error.name : 'UnknownError' })}\n`);
  process.exitCode = 1;
} finally {
  for (const client of clients.reverse()) {
    try { await client.close(); } catch { /* best-effort cleanup after an assertion */ }
  }
  if (server?.listening) {
    try { await closeServer(server); } catch { process.exitCode = 1; }
  }
}
