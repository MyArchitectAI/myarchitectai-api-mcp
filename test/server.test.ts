import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MyArchitectAIClient } from '../src/client.js';
import type { FetchLike } from '../src/client.js';
import { registerTools } from '../src/tools.js';

type TextBlock = { type: 'text'; text: string };

function buildServer(fetchImpl: FetchLike): McpServer {
  const apiClient = new MyArchitectAIClient(
    { apiKey: 'k', baseUrl: 'https://api.test/v1', timeoutMs: 1000, maxRetries: 0 },
    fetchImpl,
  );
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, apiClient);
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
  it('lists all five tools', async () => {
    const client = await connect(buildServer(async () => new Response('{}')));
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['render_exterior', 'render_interior', 'style_transfer', 'text_to_image', 'upscale_4k'],
    );
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

    let failed = false;
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
});
