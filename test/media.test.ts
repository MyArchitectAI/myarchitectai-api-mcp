import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import type { FetchLike } from '../src/client.js';
import { RequestError } from '../src/errors.js';
import { assertSafeUrl, describeSource, MediaService, resolveLocalPath } from '../src/media.js';

function imageResponse(bytes: number, mimeType = 'image/png', headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes).fill(120), {
    status: 200,
    headers: { 'content-type': mimeType, ...headers },
  });
}

function options(fetchImpl: FetchLike): { timeoutMs: number; maxBytes: number; fetchImpl: FetchLike } {
  return { timeoutMs: 1000, maxBytes: 1000, fetchImpl };
}

// 1x1 transparent PNG.
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A fetch stub that fails loudly — data:/local inputs must never touch the network. */
const noFetch: FetchLike = async () => {
  throw new Error('network should not be used for data:/local inputs');
};

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

  it('fetchForPreview() decodes a base64 data: URI without using the network', async () => {
    const media = new MediaService(options(noFetch));
    const result = await media.fetchForPreview(PNG_DATA_URI);
    assert.equal(result.tooLarge, false);
    if (!result.tooLarge) {
      assert.equal(result.mimeType, 'image/png');
      assert.ok(result.base64.length > 0);
    }
  });

  it('fetchForPreview() reads a local image file without using the network', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-media-'));
    try {
      const file = path.join(dir, 'pic.png');
      await writeFile(file, Buffer.from(new Uint8Array(48).fill(7)));
      const media = new MediaService(options(noFetch));
      const result = await media.fetchForPreview(file);
      assert.equal(result.tooLarge, false);
      if (!result.tooLarge) {
        assert.equal(result.mimeType, 'image/png');
        assert.ok(result.base64.length > 0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fetchForPreview() rejects a local non-image file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-media-'));
    try {
      const file = path.join(dir, 'notes.txt');
      await writeFile(file, 'hello');
      const media = new MediaService(options(noFetch));
      await assert.rejects(() => media.fetchForPreview(file), RequestError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('save() writes a base64 data: URI to disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-media-'));
    try {
      const media = new MediaService(options(noFetch));
      const saved = await media.save(PNG_DATA_URI, { dir });
      assert.equal(saved.mimeType, 'image/png');
      assert.ok(saved.path.endsWith('.png'));
      const onDisk = await readFile(saved.path);
      assert.ok(onDisk.byteLength > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('save() copies a local image file to the target dir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-media-'));
    try {
      const src = path.join(dir, 'src.png');
      await writeFile(src, Buffer.from(new Uint8Array(20).fill(9)));
      const media = new MediaService(options(noFetch));
      const saved = await media.save(src, { dir: path.join(dir, 'out') });
      assert.equal(saved.bytes, 20);
      assert.equal(saved.mimeType, 'image/png');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a data: URI with malformed percent-encoding', async () => {
    const media = new MediaService(options(noFetch));
    await assert.rejects(() => media.fetchForPreview('data:image/svg+xml,%E0%A4%A'), RequestError);
  });

  it('save() refuses to write a non-image data: URI', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-media-'));
    try {
      const media = new MediaService(options(noFetch));
      // "hello" as text/plain — must not be written to disk by save_image.
      await assert.rejects(() => media.save('data:text/plain;base64,aGVsbG8=', { dir }), RequestError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported URL scheme (e.g. ftp://)', async () => {
    const media = new MediaService(options(noFetch));
    await assert.rejects(() => media.fetchForPreview('ftp://example.com/x.png'), RequestError);
    await assert.rejects(() => media.save('ftp://example.com/x.png', { dir: '/tmp' }), RequestError);
  });

  it('fetchForPreview() rejects a non-image data: URI before reporting it too large', async () => {
    const media = new MediaService(options(noFetch));
    // ~1050 bytes (over the 1000-byte limit) but not an image: must error as
    // not-an-image, not silently report tooLarge (MIME is checked before size).
    const bigZip = `data:application/zip;base64,${'A'.repeat(1400)}`;
    await assert.rejects(() => media.fetchForPreview(bigZip), RequestError);
  });

  it('fetchForPreview() rejects a corrupt base64 data: URI instead of decoding garbage', async () => {
    const media = new MediaService(options(noFetch));
    await assert.rejects(() => media.fetchForPreview('data:image/png;base64,not valid base64!!'), RequestError);
  });

  it('fetchForPreview() rejects a truncated base64 data: URI (length not a multiple of 4)', async () => {
    const media = new MediaService(options(noFetch));
    await assert.rejects(() => media.fetchForPreview('data:image/png;base64,iVBORw0KGg'), RequestError);
  });

  it('fetchForPreview() rejects an empty base64 data: URI', async () => {
    const media = new MediaService(options(noFetch));
    await assert.rejects(() => media.fetchForPreview('data:image/png;base64,'), RequestError);
  });

  it('save() refuses to write a non-image HTTP response', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-media-'));
    try {
      const media = new MediaService(
        options(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })),
      );
      await assert.rejects(() => media.save('https://cdn.example.com/page.html', { dir }), RequestError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('save() accepts an HTTP image served without a Content-Type (e.g. S3)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mai-media-'));
    try {
      // 200 OK, real bytes, but no content-type header at all — must not be refused.
      const media = new MediaService(options(async () => new Response(new Uint8Array(32).fill(1), { status: 200 })));
      const saved = await media.save('https://bucket.s3.amazonaws.com/render.png', { dir });
      assert.equal(saved.bytes, 32);
      assert.ok(saved.path.endsWith('.png'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('describeSource', () => {
  it('does not fabricate ;base64 for a plain (non-base64) data URI', () => {
    const label = describeSource('data:text/plain,hello');
    assert.ok(label.includes('text/plain'), label);
    assert.ok(!label.includes('base64'), label);
  });

  it('reflects a base64 data URI without leaking the payload', () => {
    const label = describeSource('data:image/png;base64,iVBORw0KGgo=');
    assert.ok(label.includes('image/png;base64'), label);
    assert.ok(!label.includes('iVBORw0KGgo'), label);
  });

  it('returns http(s) URLs unchanged', () => {
    assert.equal(describeSource('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
  });
});

describe('resolveLocalPath', () => {
  it('expands a leading ~ to an absolute path under the home directory', () => {
    assert.equal(resolveLocalPath('~/Documents/render.png'), path.join(homedir(), 'Documents/render.png'));
  });

  it('rejects unsupported URL schemes', () => {
    assert.throws(() => resolveLocalPath('ftp://example.com/x.png'), RequestError);
  });
});
