import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import type { FetchLike } from '../src/client.js';
import { RequestError } from '../src/errors.js';
import { assertSafeUrl, MediaService } from '../src/media.js';

function imageResponse(bytes: number, mimeType = 'image/png', headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes).fill(120), {
    status: 200,
    headers: { 'content-type': mimeType, ...headers },
  });
}

function options(fetchImpl: FetchLike): { timeoutMs: number; maxBytes: number; fetchImpl: FetchLike } {
  return { timeoutMs: 1000, maxBytes: 1000, fetchImpl };
}

describe('assertSafeUrl', () => {
  it('accepts public http(s) URLs', () => {
    assert.equal(assertSafeUrl('https://cdn.example.com/a.png').hostname, 'cdn.example.com');
  });

  it('rejects non-http(s) schemes and local/private hosts', () => {
    assert.throws(() => assertSafeUrl('ftp://example.com/a.png'), RequestError);
    assert.throws(() => assertSafeUrl('http://localhost/a.png'), RequestError);
    assert.throws(() => assertSafeUrl('http://127.0.0.1/a.png'), RequestError);
    assert.throws(() => assertSafeUrl('http://192.168.1.5/a.png'), RequestError);
    assert.throws(() => assertSafeUrl('http://10.0.0.1/a.png'), RequestError);
    assert.throws(() => assertSafeUrl('not-a-url'), RequestError);
  });
});

describe('MediaService', () => {
  it('check() reports reachability and image content type', async () => {
    const media = new MediaService(
      options(async () => new Response(null, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '500' },
      })),
    );
    const result = await media.check('https://cdn.example.com/a.png');
    assert.equal(result.ok, true);
    assert.equal(result.isImage, true);
    assert.equal(result.contentLength, 500);
  });

  it('fetchForPreview() returns base64 for small images', async () => {
    const media = new MediaService(options(async () => imageResponse(100, 'image/png')));
    const result = await media.fetchForPreview('https://cdn.example.com/a.png');
    assert.equal(result.tooLarge, false);
    if (!result.tooLarge) {
      assert.equal(result.mimeType, 'image/png');
      assert.ok(result.base64.length > 0);
    }
  });

  it('fetchForPreview() flags oversized images by content-length without downloading', async () => {
    const media = new MediaService(
      options(async () => imageResponse(10, 'image/png', { 'content-length': '999999' })),
    );
    const result = await media.fetchForPreview('https://cdn.example.com/a.png');
    assert.equal(result.tooLarge, true);
  });

  it('fetchForPreview() rejects non-image content', async () => {
    const media = new MediaService(
      options(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    await assert.rejects(() => media.fetchForPreview('https://cdn.example.com/a.html'), RequestError);
  });

  it('save() writes the downloaded image to disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-media-'));
    try {
      const media = new MediaService(options(async () => imageResponse(64, 'image/png')));
      const saved = await media.save('https://cdn.example.com/render.png', { dir });
      assert.equal(saved.bytes, 64);
      assert.equal(saved.mimeType, 'image/png');
      const onDisk = await readFile(saved.path);
      assert.equal(onDisk.byteLength, 64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
