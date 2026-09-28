import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { RequestError } from './errors.js';
import { classifyImageInput, MediaService, type PreviewFetch, type SavedImage, type UrlCheck } from './media.js';

type Address = Readonly<{ address: string; family: 4 | 6 }>;
type Reply = Readonly<{
  status: number;
  contentType: string | null;
  contentLength: number | null;
  bytes: Buffer;
  tooLarge: boolean;
}>;

type RemoteMediaOptions = {
  timeoutMs: number;
  maxBytes: number;
  /** Synthetic tests may supply an address resolver; production uses OS DNS. */
  resolve?: (hostname: string) => Promise<Address[]>;
  /** Synthetic tests may observe the selected pinned address without opening a socket. */
  requestPinned?: (url: URL, address: Address, method: 'GET' | 'HEAD', maxBytes: number, timeoutMs: number) => Promise<Reply>;
};

/** Remote previews cannot read host files or follow a URL into private networking. */
export class RemoteMediaService extends MediaService {
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #resolve: (hostname: string) => Promise<Address[]>;
  readonly #requestPinned: NonNullable<RemoteMediaOptions['requestPinned']>;

  constructor(opts: RemoteMediaOptions) {
    super({ timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
    this.#timeoutMs = opts.timeoutMs;
    this.#maxBytes = opts.maxBytes;
    this.#resolve = opts.resolve ?? resolveAddresses;
    this.#requestPinned = opts.requestPinned ?? requestPinned;
  }

  override async check(rawUrl: string): Promise<UrlCheck> {
    const reply = await this.#request(rawUrl, 'HEAD');
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      contentType: reply.contentType,
      contentLength: reply.contentLength,
      isImage: isImageMime(reply.contentType),
    };
  }

  override async fetchForPreview(rawInput: string): Promise<PreviewFetch> {
    const kind = classifyImageInput(rawInput);
    if (kind === 'path') {
      throw new RequestError('Local files are unavailable in remote mode.');
    }
    if (kind === 'data') {
      if (rawInput.length > Math.ceil(this.#maxBytes * 4 / 3) + 1024) {
        throw new RequestError('Inline image exceeds the remote preview limit.');
      }
      return super.fetchForPreview(rawInput);
    }
    const reply = await this.#request(rawInput, 'GET');
    if (reply.status < 200 || reply.status >= 300) {
      throw new RequestError('Remote image request failed.');
    }
    if (!isImageMime(reply.contentType)) {
      throw new RequestError('Remote URL did not return an image.');
    }
    if (reply.tooLarge) {
      return { tooLarge: true, bytes: reply.contentLength ?? reply.bytes.byteLength, mimeType: reply.contentType };
    }
    return {
      tooLarge: false,
      bytes: reply.bytes.byteLength,
      mimeType: reply.contentType ?? 'application/octet-stream',
      base64: reply.bytes.toString('base64'),
    };
  }

  override async save(_rawInput: string, _opts: { dir: string; filename?: string }): Promise<SavedImage> {
    void _rawInput;
    void _opts;
    throw new RequestError('Saving files is unavailable in remote mode.');
  }

  async #request(rawUrl: string, method: 'GET' | 'HEAD'): Promise<Reply> {
    const url = remoteUrl(rawUrl);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: Address[];
    if (isIP(host) !== 0) {
      addresses = [{ address: host, family: isIP(host) as 4 | 6 }];
    } else {
      addresses = await withDeadline(this.#resolve(host), this.#timeoutMs);
    }
    const selected = addresses.at(0);
    if (selected === undefined || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new RequestError('Remote URL host is unavailable.');
    }
    try {
      return await this.#requestPinned(url, selected, method, this.#maxBytes, this.#timeoutMs);
    } catch {
      throw new RequestError('Remote image request failed.');
    }
  }
}

const remoteUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RequestError('A public HTTPS image URL is required.');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || url.username || url.password ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new RequestError('A public HTTPS image URL is required.');
  }
  return url;
};

/** Allow global unicast only; deny special-use, private and tunnel address space. */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a = -1, b = -1, c = -1] = parts;
    if (a < 1 || a >= 224 || a === 10 || a === 127) { return false; }
    if (a === 100 && b >= 64 && b <= 127) { return false; }
    if (a === 169 && b === 254) { return false; }
    if (a === 172 && b >= 16 && b <= 31) { return false; }
    if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) { return false; }
    if (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) { return false; }
    if (a === 203 && b === 0 && c === 113) { return false; }
    return true;
  }
  if (family === 6) {
    const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
    const first = Number.parseInt(normalized.split(':')[0] ?? '', 16);
    if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) { return false; }
    if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::' ||
        normalized.startsWith('2001:0:') || normalized.startsWith('2001::') || normalized.startsWith('2002:')) {
      return false;
    }
    return true;
  }
  return false;
};

const isImageMime = (value: string | null): boolean => value !== null && value.toLowerCase().startsWith('image/');

const resolveAddresses = async (hostname: string): Promise<Address[]> => {
  try {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  } catch {
    throw new RequestError('Remote URL host is unavailable.');
  }
};

const withDeadline = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new RequestError('Remote URL host is unavailable.'));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const requestPinned = (url: URL, selected: Address, method: 'GET' | 'HEAD', maxBytes: number, timeoutMs: number): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let settled = false;
    const finish = (reply: Reply | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (reply instanceof Error) {
        reject(reply);
      } else {
        resolve(reply);
      }
    };
    const req = request(url, {
      method,
      agent: false,
      family: selected.family,
      signal: controller.signal,
      headers: { accept: 'image/*' },
      lookup: (_hostname, options, callback) => {
        if (options.all === true) {
          callback(null, [selected]);
        } else {
          callback(null, selected.address, selected.family);
        }
      },
    }, (response) => {
      if (normalizeAddress(response.socket.remoteAddress ?? '') !== normalizeAddress(selected.address)) {
        response.destroy();
        finish(new RequestError('Remote image request failed.'));
        return;
      }
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.destroy();
        finish(new RequestError('Remote image redirects are unavailable.'));
        return;
      }
      const contentType = header(response.headers['content-type']);
      const lengthHeader = header(response.headers['content-length']);
      const rawLength = lengthHeader === null ? NaN : Number(lengthHeader);
      const contentLength = Number.isFinite(rawLength) && rawLength >= 0 ? rawLength : null;
      const chunks: Buffer[] = [];
      let size = 0;
      if (method === 'GET' && contentLength !== null && contentLength > maxBytes) {
        response.destroy();
        finish({ status, contentType, contentLength, bytes: Buffer.alloc(0), tooLarge: true });
        return;
      }
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          response.destroy();
          finish({ status, contentType, contentLength, bytes: Buffer.alloc(0), tooLarge: true });
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        finish({ status, contentType, contentLength, bytes: Buffer.concat(chunks), tooLarge: false });
      });
      response.on('error', (error: Error) => {
        finish(error);
      });
    });
    req.on('error', (error: Error) => {
      finish(error);
    });
    req.end();
  });

const header = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? value[0] ?? null : value ?? null;

const normalizeAddress = (address: string): string => {
  if (isIP(address) !== 6) {
    return address;
  }
  return new URL(`https://[${address}]/`).hostname.replace(/^\[|\]$/g, '');
};
