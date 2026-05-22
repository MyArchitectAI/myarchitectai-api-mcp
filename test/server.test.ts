import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MyArchitectAIClient } from '../src/client.js';
import type { FetchLike } from '../src/client.js';
import type { Config } from '../src/config.js';
import { MediaService } from '../src/media.js';
import { SessionStore } from '../src/session.js';
import { registerTools } from '../src/tools.js';

type TextBlock = { type: 'text'; text: string };

const testConfig: Config = {
  apiKey: 'k',
  baseUrl: 'https://api.test/v1',
  timeoutMs: 1000,
  maxRetries: 0,
  downloadDir: 'renders',
  maxPreviewBytes: 5_000_000,
  stateFile: undefined,
};

function buildServer(fetchImpl: FetchLike): McpServer {
  const client = new MyArchitectAIClient(testConfig, fetchImpl);
  const session = new SessionStore();
  const media = new MediaService({
    timeoutMs: testConfig.timeoutMs,
    maxBytes: testConfig.maxPreviewBytes,
    fetchImpl,
  });
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, { client, session, media, config: testConfig });
  return server;
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function firstText(content: unknown): string {
  const blocks = content as TextBlock[];
  return blocks[0]?.text ?? '';
}

describe('MCP server integration', () => {
  it('lists all generation and QoL tools', async () => {
    const client = await connect(buildServer(async () => new Response('{}')));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'list_recent_generations',
      'preview_image',
      'render_exterior',
      'render_interior',
      'save_image',
      'style_transfer',
      'text_to_image',
      'upscale_4k',
      'usage_summary',
      'validate_image_url',
    ]);
    await client.close();
  });

  it('returns structuredContent and a URL summary on success', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ output: ['https://img/out.png'], balance: 19.5, cost: 0.5 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const client = await connect(buildServer(fetchImpl));

    const result = await client.callTool({
      name: 'render_exterior',
      arguments: { image: 'https://x/y.png', outputFormat: 'png' },
    });

    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      output: ['https://img/out.png'],
      balance: 19.5,
      cost: 0.5,
    });
    assert.match(firstText(result.content), /https:\/\/img\/out\.png/);
    await client.close();
  });

  it('reports API errors as isError without throwing', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ error: 'invalid image', balance: 19, cost: 0 }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    const client = await connect(buildServer(fetchImpl));

    const result = await client.callTool({
      name: 'upscale_4k',
      arguments: { image: 'https://x/y.png' },
    });

    assert.equal(result.isError, true);
    assert.match(firstText(result.content), /invalid image/);
    await client.close();
  });

  it('rejects input that violates the schema (width out of range)', async () => {
    const client = await connect(buildServer(async () => new Response('{}')));

    let failed: boolean;
    try {
      const result = await client.callTool({
        name: 'text_to_image',
        arguments: { prompt: 'x', outputFormat: 'png', outputWidth: 99_999, outputHeight: 512 },
      });
      failed = result.isError === true;
    } catch {
      failed = true; // SDK may reject the call outright on invalid params.
    }
    assert.ok(failed, 'expected schema validation to reject invalid input');
    await client.close();
  });

  it('preview_image returns an inline image block', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(new Uint8Array(32).fill(1), { status: 200, headers: { 'content-type': 'image/png' } });
    const client = await connect(buildServer(fetchImpl));

    const result = await client.callTool({
      name: 'preview_image',
      arguments: { url: 'https://cdn.example.com/render.png' },
    });

    const blocks = result.content as Array<{ type: string; data?: string }>;
    assert.ok(blocks.some((b) => b.type === 'image' && typeof b.data === 'string'));
    await client.close();
  });

  it('validate_image_url reports a reachable image as ok', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(null, { status: 200, headers: { 'content-type': 'image/png', 'content-length': '1234' } });
    const client = await connect(buildServer(fetchImpl));

    const result = await client.callTool({
      name: 'validate_image_url',
      arguments: { url: 'https://cdn.example.com/render.png' },
    });

    const structured = result.structuredContent as { ok: boolean; isImage: boolean };
    assert.equal(structured.ok, true);
    assert.equal(structured.isImage, true);
    await client.close();
  });

  it('records generations and reflects them in usage_summary', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ output: ['u'], balance: 7, cost: 0.5 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const client = await connect(buildServer(fetchImpl));

    await client.callTool({
      name: 'text_to_image',
      arguments: { prompt: 'a house', outputFormat: 'png', outputWidth: 256, outputHeight: 256 },
    });
    const result = await client.callTool({ name: 'usage_summary', arguments: {} });

    const structured = result.structuredContent as { totalGenerations: number; lastKnownBalance: number };
    assert.equal(structured.totalGenerations, 1);
    assert.equal(structured.lastKnownBalance, 7);
    await client.close();
  });

  it('counts a failed generation and reflects its balance in usage_summary', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ error: 'bad image', balance: 42, cost: 0 }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    const client = await connect(buildServer(fetchImpl));

    const failed = await client.callTool({ name: 'upscale_4k', arguments: { image: 'https://x/y.png' } });
    assert.equal(failed.isError, true);

    const result = await client.callTool({ name: 'usage_summary', arguments: {} });
    const s = result.structuredContent as {
      totalGenerations: number;
      failedGenerations: number;
      lastKnownBalance: number;
    };
    assert.equal(s.totalGenerations, 0);
    assert.equal(s.failedGenerations, 1);
    assert.equal(s.lastKnownBalance, 42); // taken from the error body, with zero successes
    await client.close();
  });

  it('does not count transport failures (network) as failed generations', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const client = await connect(buildServer(fetchImpl));

    await client.callTool({
      name: 'render_exterior',
      arguments: { image: 'https://x/y.png', outputFormat: 'png' },
    });
    const result = await client.callTool({ name: 'usage_summary', arguments: {} });
    const s = result.structuredContent as { failedGenerations: number };
    assert.equal(s.failedGenerations, 0);
    await client.close();
  });
});
