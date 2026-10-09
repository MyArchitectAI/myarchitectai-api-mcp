import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MyArchitectAIClient } from '../src/client.js';
import type { Config } from '../src/config.js';
import { MediaService } from '../src/media.js';
import { SessionStore, type UsageSummary } from '../src/session.js';
import { API_TOOL_ENDPOINTS, registerTools } from '../src/tools.js';

const config: Config = {
  apiKey: 'synthetic-key', baseUrl: 'https://api.test/v1', timeoutMs: 1000,
  maxRetries: 2, downloadDir: 'renders', maxPreviewBytes: 5_000_000, stateFile: undefined,
};
const image = 'https://x/source.png';
const tools: Array<{ name: Exclude<keyof typeof API_TOOL_ENDPOINTS, 'balance'>; args: Record<string, unknown> }> = [
  { name: 'render_exterior', args: { image, outputFormat: 'png' } },
  { name: 'render_interior', args: { image, outputFormat: 'png' } },
  { name: 'style_transfer', args: { image, referenceImage: image, outputFormat: 'png' } },
  { name: 'text_to_image', args: { prompt: 'a house', outputFormat: 'png', outputWidth: 256, outputHeight: 256 } },
  { name: 'upscale_4k', args: { image } },
  { name: 'auto_prompt', args: { image } },
  { name: 'edit_by_prompt', args: { image, prompt: 'oak floor' } },
  { name: 'change_textures', args: { image, mask: image, prompt: 'oak' } },
  { name: 'set_atmosphere', args: { image, sceneType: 'exterior', weather: 'clear' } },
  { name: 'animate', args: { startFrameUrl: image, prompt: 'slow pan' } },
  { name: 'upscale', args: { image } },
];

async function connect(mode: 'stdio' | 'remote', respond: (path: string) => Response): Promise<Client> {
  const apiClient = mode === 'remote' ? new MyArchitectAIClient({
    baseUrl: config.baseUrl, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries,
    transport: async (path) => respond(path),
  }) : new MyArchitectAIClient(config, async (url) => respond(new URL(String(url)).pathname.slice(3)));
  const server = new McpServer({ name: 'synthetic-policy-test', version: '0.0.0' });
  if (mode === 'remote') {
    registerTools(server, { client: apiClient, mode });
  } else {
    registerTools(server, { client: apiClient, mode, config, session: new SessionStore(),
      media: new MediaService({ timeoutMs: config.timeoutMs, maxBytes: config.maxPreviewBytes }) });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'synthetic-policy-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  return client;
}

describe('content safety MCP tool results', () => {
  for (const mode of ['stdio', 'remote'] as const) {
    for (const code of ['CONTENT_POLICY_VIOLATION', 'SAFETY_CHECK_UNAVAILABLE'] as const) {
      for (const tool of tools) {
        it(`${mode} ${tool.name} exposes ${code} and billing without output history or retries`, async () => {
          let calls = 0;
          const expected = { error: code === 'CONTENT_POLICY_VIOLATION' ?
            'Request blocked by content policy' : 'Content safety check unavailable',
          code, balance: 4.75, cost: code === 'CONTENT_POLICY_VIOLATION' ? 0.25 : 0, requestId: 884 };
          const client = await connect(mode, (path) => {
            calls++;
            assert.equal(path, API_TOOL_ENDPOINTS[tool.name]);
            return Response.json({ ...expected, error: 'private provider failure',
              providerDetail: 'private account detail', output: ['https://x/rejected.png'] });
          });
          try {
            const result = await client.callTool({ name: tool.name, arguments: tool.args });
            assert.equal(result.isError, true);
            assert.deepEqual(result.structuredContent, expected);
            const text = JSON.stringify(result.content);
            assert.ok(text.includes(expected.error));
            assert.ok(text.includes(code));
            assert.ok(text.includes('balance 4.75'));
            assert.ok(text.includes(`cost ${expected.cost}`));
            assert.ok(text.includes('request ID 884'));
            assert.doesNotMatch(JSON.stringify(result), /private|rejected\.png/);
            assert.equal(calls, 1);
            if (mode === 'stdio') {
              const usage = await client.callTool({ name: 'usage_summary', arguments: {} });
              const summary = usage.structuredContent as unknown as UsageSummary;
              assert.ok(summary);
              assert.equal(summary.totalGenerations, 0);
              assert.equal(summary.failedGenerations, 1);
              assert.equal(summary.totalCost, expected.cost);
              assert.equal(summary.lastKnownBalance, expected.balance);
              assert.deepEqual(summary.byTool, expected.cost > 0 ? { [tool.name]: { count: 0, cost: expected.cost } } : {});
              const recent = await client.callTool({ name: 'list_recent_generations', arguments: {} });
              assert.deepEqual(recent.structuredContent, { generations: [] });
              assert.equal(calls, 1);
            }
          } finally {
            await client.close();
          }
        });
      }
    }
  }

  it('does not invent missing safety billing metadata', async () => {
    const client = await connect('remote', () => Response.json({ code: 'SAFETY_CHECK_UNAVAILABLE' }));
    try {
      const result = await client.callTool({ name: 'auto_prompt', arguments: { image } });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { code: 'SAFETY_CHECK_UNAVAILABLE', error: 'Content safety check unavailable' });
    } finally {
      await client.close();
    }
  });

  for (const code of ['PRIVATE_CODE', '__proto__', 'constructor', 'toString']) {
    it(`keeps unknown hosted error code ${code} and private details masked`, async () => {
      const client = await connect('remote', () => Response.json({
        error: 'private upstream detail', code, balance: 4, cost: 0.5, requestId: 884,
      }));
      try {
        const result = await client.callTool({ name: 'auto_prompt', arguments: { image } });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.doesNotMatch(JSON.stringify(result), /private|884|balance|cost/);
        assert.equal(JSON.stringify(result).includes(code), false);
        assert.match(JSON.stringify(result.content), /Auto prompt failed \(HTTP 200\)/);
      } finally {
        await client.close();
      }
    });
  }
});
