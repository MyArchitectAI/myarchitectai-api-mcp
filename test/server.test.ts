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
      'animate',
      'auto_prompt',
      'balance',
      'change_textures',
      'edit_by_prompt',
      'list_recent_generations',
      'preview_image',
      'render_exterior',
      'render_interior',
      'save_image',
      'set_atmosphere',
      'style_transfer',
      'text_to_image',
      'upscale',
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

  it('usage_summary exposes a masked api key fingerprint', async () => {
    const client = await connect(buildServer(async () => new Response('{}')));

    const result = await client.callTool({ name: 'usage_summary', arguments: {} });

    const structured = result.structuredContent as { apiKeyFingerprint: string };
    assert.equal(structured.apiKeyFingerprint, '…k'); // testConfig.apiKey === 'k'
    assert.match(firstText(result.content), /API key: …k/);
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

  it('preview_image accepts an inline base64 data: URI (no network)', async () => {
    const dataUri =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const client = await connect(
      buildServer(async () => {
        throw new Error('network should not be used for a data: URI');
      }),
    );

    const result = await client.callTool({ name: 'preview_image', arguments: { url: dataUri } });

    const blocks = result.content as Array<{ type: string; data?: string }>;
    assert.ok(blocks.some((b) => b.type === 'image' && typeof b.data === 'string'));
    await client.close();
  });
});


describe('current API tools', () => {
  const cases = [
    { name: 'auto_prompt', path: '/auto-prompt', args: { image: 'https://x/source.png' }, output: 'oak kitchen, natural daylight' },
    { name: 'edit_by_prompt', path: '/edit-by-prompt', args: { image: 'https://x/source.png', prompt: 'replace the lamp', referenceImage: 'https://x/lamp.png' }, output: 'https://x/edited.png' },
    { name: 'change_textures', path: '/change-textures', args: { image: 'https://x/source.png', mask: 'https://x/mask.png', prompt: 'oak' }, output: ['https://x/texture.png'] },
    { name: 'set_atmosphere', path: '/set-atmosphere', args: { image: 'https://x/source.png', sceneType: 'exterior', season: 'winter', weather: 'snow' }, output: ['https://x/winter.png'] },
    { name: 'animate', path: '/animate', args: { startFrameUrl: 'https://x/source.png', endFrameUrl: 'https://x/end.png', prompt: 'slow pan' }, output: 'https://x/animation.mp4' },
    { name: 'upscale', path: '/upscale', args: { image: 'https://x/source.png', targetResolution: '8k', outputFormat: 'webp' }, output: 'https://x/8k.webp' },
  ];
  for (const fixture of cases) {
    it(`${fixture.name} forwards its complete body and preserves response and history types`, async () => {
      let calls = 0;
      const client = await connect(buildServer(async (url, init) => {
        calls++;
        assert.equal(url, `https://api.test/v1${fixture.path}`);
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)), fixture.args);
        return new Response(JSON.stringify({ output: fixture.output, balance: 4.97, cost: 0.03, requestId: 701 }));
      }));
      try {
        const result = await client.callTool({ name: fixture.name, arguments: fixture.args });
        assert.notEqual(result.isError, true);
        const output = fixture.name === 'auto_prompt' || Array.isArray(fixture.output) ? fixture.output : [fixture.output];
        assert.deepEqual(result.structuredContent, { output, balance: 4.97, cost: 0.03, requestId: 701 });
        if (fixture.name === 'animate') assert.match(firstText(result.content), /video/);
        const recent = await client.callTool({ name: 'list_recent_generations', arguments: {} });
        const record = (recent.structuredContent as { generations: Array<{ requestId: number; outputType: string }> }).generations[0];
        assert.equal(record?.requestId, 701);
        let outputType = 'image';
        if (fixture.name === 'auto_prompt') outputType = 'text';
        if (fixture.name === 'animate') outputType = 'video';
        assert.equal(record?.outputType, outputType);
        assert.equal(calls, 1);
      } finally {
        await client.close();
      }
    });
  }

  it('balance performs an authenticated POST without a generation body or usage charge', async () => {
    const client = await connect(buildServer(async (url, init) => {
      assert.equal(url, 'https://api.test/v1/balance');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.body, undefined);
      assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'k');
      return new Response(JSON.stringify({ balance: 23.45 }));
    }));
    try {
      const result = await client.callTool({ name: 'balance', arguments: {} });
      assert.deepEqual(result.structuredContent, { balance: 23.45 });
      const summary = await client.callTool({ name: 'usage_summary', arguments: {} });
      const usage = summary.structuredContent as { totalGenerations: number; totalCost: number; lastKnownBalance: number };
      assert.equal(usage.totalGenerations, 0);
      assert.equal(usage.totalCost, 0);
      assert.equal(usage.lastKnownBalance, 23.45);
    } finally {
      await client.close();
    }
  });

  const invalid = [
    { name: 'change_textures', args: { image: 'https://x/i.png', mask: 'https://x/m.png' } },
    { name: 'change_textures', args: { image: 'https://x/i.png', mask: 'https://x/m.png', prompt: 'oak', referenceImage: 'https://x/r.png' } },
    { name: 'change_textures', args: { image: 'https://x/i.png', prompt: 'oak' } },
    { name: 'set_atmosphere', args: { image: 'https://x/i.png', sceneType: 'interior' } },
    { name: 'set_atmosphere', args: { image: 'https://x/i.png', sceneType: 'interior', lighting: 'warm_lamps', weather: 'snow' } },
    { name: 'set_atmosphere', args: { image: 'https://x/i.png', sceneType: 'exterior' } },
    { name: 'set_atmosphere', args: { image: 'https://x/i.png', sceneType: 'exterior', lighting: 'warm_lamps', weather: 'snow' } },
    { name: 'upscale', args: { image: 'https://x/i.png', targetResolution: '8k', outputFormat: 'png' } },
    { name: 'upscale_4k', args: { image: 'https://x/i.png', outputFormat: 'avif' } },
  ];
  for (const [index, fixture] of invalid.entries()) {
    it(`rejects invalid conditional input ${index + 1} before an API request`, async () => {
      let calls = 0;
      const client = await connect(buildServer(async () => { calls++; return new Response('{}'); }));
      try {
        const result = await client.callTool({ name: fixture.name, arguments: fixture.args });
        assert.equal(result.isError, true);
        assert.equal(calls, 0);
      } finally {
        await client.close();
      }
    });
  }
});
