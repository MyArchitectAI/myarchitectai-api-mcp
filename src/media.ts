/**
 * Generic image utilities for the QoL tools: fetching arbitrary image URLs
 * (for inline preview), downloading them to disk, HEAD-checking them, and
 * opening them in a browser when a display is available.
 *
 * These never send the MyArchitectAI API key — the URLs they touch are public
 * (generation outputs) or user-supplied inputs. A light SSRF guard blocks
 * loopback/private addresses (which the remote API couldn't fetch anyway).
 */

import { spawn } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { FetchLike } from './client.js';
import { MyArchitectAIError, NetworkError, RequestError, TimeoutError, UpstreamError } from './errors.js';

export interface UrlCheck {
  ok: boolean;
  status: number;
  contentType: string | null;
  contentLength: number | null;
  isImage: boolean;
  reason?: string | undefined;
}

export type PreviewFetch =
  | { tooLarge: false; mimeType: string; bytes: number; base64: string }
  | { tooLarge: true; bytes: number; mimeType: string | null };

export interface SavedImage {
  path: string;
  bytes: number;
  mimeType: string;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

export class MediaService {
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;

  constructor(opts: { timeoutMs: number; maxBytes: number; fetchImpl?: FetchLike }) {
    this.#fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = opts.timeoutMs;
    this.#maxBytes = opts.maxBytes;
  }

  /** HEAD-check a URL for reachability and image content-type. */
  async check(rawUrl: string): Promise<UrlCheck> {
    let response: Response;
    try {
      response = await this.#request(rawUrl, 'HEAD');
    } catch (err) {
      if (err instanceof MyArchitectAIError && (err.kind === 'network' || err.kind === 'timeout')) {
        return { ok: false, status: 0, contentType: null, contentLength: null, isImage: false, reason: err.message };
      }
      throw err;
    }
    const contentType = response.headers.get('content-type');
    const length = response.headers.get('content-length');
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      contentLength: length !== null && Number.isFinite(Number(length)) ? Number(length) : null,
      isImage: isImageMime(contentType),
    };
  }

  /** Fetch an image for inline preview, falling back to "too large" if it exceeds the embed limit. */
  async fetchForPreview(rawUrl: string): Promise<PreviewFetch> {
    const response = await this.#request(rawUrl, 'GET');
    if (!response.ok) {
      throw new UpstreamError(`Image fetch failed: HTTP ${response.status} for ${rawUrl}`, {
        status: response.status,
        retryable: false,
      });
    }
    const contentType = response.headers.get('content-type');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.#maxBytes) {
      return { tooLarge: true, bytes: declared, mimeType: contentType };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.#maxBytes) {
      return { tooLarge: true, bytes: bytes.byteLength, mimeType: contentType };
    }
    if (!isImageMime(contentType)) {
      throw new RequestError(`URL did not return an image (content-type: ${contentType ?? 'unknown'}): ${rawUrl}`);
    }
    return {
      tooLarge: false,
      mimeType: contentType ?? 'application/octet-stream',
      bytes: bytes.byteLength,
      base64: Buffer.from(bytes).toString('base64'),
    };
  }

  /** Download an image URL to disk under `dir`, returning the saved path. */
  async save(rawUrl: string, opts: { dir: string; filename?: string }): Promise<SavedImage> {
    const response = await this.#request(rawUrl, 'GET');
    if (!response.ok) {
      throw new UpstreamError(`Image download failed: HTTP ${response.status} for ${rawUrl}`, {
        status: response.status,
        retryable: false,
      });
    }
    const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
    const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));

    const dirAbs = path.resolve(opts.dir);
    await mkdir(dirAbs, { recursive: true });
    const name = ensureExtension(sanitizeFilename(opts.filename ?? filenameFromUrl(rawUrl)), mimeType);
    const dest = await uniquePath(path.join(dirAbs, name));
    await writeFile(dest, buffer);
    return { path: dest, bytes: buffer.byteLength, mimeType };
  }

  async #request(rawUrl: string, method: 'GET' | 'HEAD'): Promise<Response> {
    const url = assertSafeUrl(rawUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(url.toString(), {
        method,
        redirect: 'follow',
        headers: { accept: 'image/*,*/*' },
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new TimeoutError(`Request to ${rawUrl} timed out after ${this.#timeoutMs} ms.`);
      }
      throw new NetworkError(`Network error fetching ${rawUrl}: ${err instanceof Error ? err.message : String(err)}`, err);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** True on macOS/Windows, or on Linux when an X11/Wayland display is present. */
export function detectDisplay(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);
}

/** Best-effort: open a URL/path in the default browser. Returns false if no display or on error. */
export function openInBrowser(target: string): boolean {
  if (!detectDisplay()) return false;
  const [command, args] =
    process.platform === 'darwin'
      ? (['open', [target]] as const)
      : process.platform === 'win32'
        ? (['cmd', ['/c', 'start', '', target]] as const)
        : (['xdg-open', [target]] as const);
  try {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Validate a URL is http(s) and not a loopback/private address. */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RequestError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RequestError(`Only http(s) URLs are allowed: ${raw}`);
  }
  if (isPrivateHost(url.hostname)) {
    throw new RequestError(`Refusing to fetch a local/private address: ${url.hostname}`);
  }
  return url;
}

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h)) {
    const parts = h.split('.').map((p) => Number(p));
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (h === '::1' || h === '::') return true;
  return h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd');
}

function isImageMime(contentType: string | null): boolean {
  return contentType !== null && contentType.toLowerCase().startsWith('image/');
}

function extensionFromMime(contentType: string): string | undefined {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_EXT[base];
}

function filenameFromUrl(rawUrl: string): string {
  try {
    const last = new URL(rawUrl).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'image';
  } catch {
    return 'image';
  }
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, '_')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200);
  return cleaned || 'image';
}

function ensureExtension(name: string, mimeType: string): string {
  if (path.extname(name)) return name;
  const ext = extensionFromMime(mimeType);
  return ext ? `${name}.${ext}` : name;
}

async function uniquePath(target: string): Promise<string> {
  if (!(await pathExists(target))) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
