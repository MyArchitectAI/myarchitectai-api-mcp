import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('keeps large inline saves and previews working over the real stdio entry point', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-stdio-image-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      MYARCHITECTAI_API_KEY: 'synthetic-stdio-key',
      MYARCHITECTAI_BASE_URL: 'http://127.0.0.1:1/v1',
      MYARCHITECTAI_DOWNLOAD_DIR: directory,
      MYARCHITECTAI_MAX_PREVIEW_BYTES: '50000000',
    },
    maxBufferSize: 64 * 1024 * 1024,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'synthetic-stdio-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const bytes = Buffer.alloc(8 * 1024 * 1024, 1);
    const base64 = bytes.toString('base64');
    const url = `data:image/png;base64,${base64}`;
    const saved = await client.callTool({ name: 'save_image', arguments: { url, filename: 'large.png' } });
    assert.equal(saved.isError, undefined);
    assert.deepEqual(saved.structuredContent, { path: join(directory, 'large.png'), bytes: bytes.length, mimeType: 'image/png' });
    assert.deepEqual(await readFile(join(directory, 'large.png')), bytes);

    const preview = await client.callTool({ name: 'preview_image', arguments: { url } });
    assert.equal(preview.isError, undefined);
    assert.ok(Array.isArray(preview.content));
    assert.ok(preview.content.some((item: unknown) => (
      typeof item === 'object' && item !== null && 'type' in item && item.type === 'image'
      && 'data' in item && item.data === base64
    )));
    const subsequent = await client.callTool({ name: 'usage_summary', arguments: {} });
    assert.equal(subsequent.isError, undefined);
  } finally {
    await client.close();
    await transport.close();
    await rm(directory, { recursive: true });
  }
});
