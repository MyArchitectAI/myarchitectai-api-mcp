import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MyArchitectAIClient } from '../src/client.js';
import type { Config } from '../src/config.js';
import { MediaService } from '../src/media.js';
import { UpstashRemoteSessionProvider } from '../src/remote-history.js';
import { registerTools } from '../src/tools.js';

it('returns a paid generation when history fails later and reports unavailable reads honestly', async () => {
  let storageAvailable = true;
  const events: string[] = [];
  const provider = new UpstashRemoteSessionProvider({
    restUrl: 'https://redis.example/', restToken: 'test-token', keySecret: 'x'.repeat(32),
    namespace: 'mya:tests',
    fetch: (async () => {
      if (!storageAvailable) throw new Error('private storage detail');
      return Response.json({ result: null });
    }) as typeof fetch,
    onError: (event) => events.push(event.operation),
  });
  const lease = await provider.acquire({ issuer: 'https://issuer.example', subject: 'alice' });
  const config: Config = {
    apiKey: 'test-key', baseUrl: 'https://api.example/v1', timeoutMs: 1000, maxRetries: 0,
    downloadDir: 'renders', maxPreviewBytes: 5_000_000, stateFile: undefined,
  };
  const apiFetch = async () => Response.json({ output: ['https://cdn.example/result'], cost: 0.5, balance: 9.5 });
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerTools(server, { client: new MyArchitectAIClient(config, apiFetch), session: lease.session,
    media: new MediaService({ timeoutMs: 1000, maxBytes: 5_000_000, fetchImpl: apiFetch }), config, mode: 'remote' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  storageAvailable = false;
  const generation = await client.callTool({ name: 'render_exterior', arguments: { image: 'https://cdn.example/input', outputFormat: 'png' } });
  assert.notEqual(generation.isError, true, JSON.stringify(generation));
  assert.deepEqual(generation.structuredContent, { output: ['https://cdn.example/result'], cost: 0.5, balance: 9.5 });
  const summary = await client.callTool({ name: 'usage_summary', arguments: {} });
  assert.equal(summary.isError, true);
  assert.deepEqual(events, ['record', 'summary']);
  await client.close();
  await lease.release();
});
