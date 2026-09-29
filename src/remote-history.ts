import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { type RemoteIdentity, type RemoteSessionLease, type RemoteSessionProvider, RemoteSessionUnavailableError } from './remote-session.js';
import type { GenerationRecord, SessionHistory, UsageSummary } from './session.js';

const finite = z.number().finite();
const count = z.number().int().nonnegative().safe();
const emptyArray = z.object({}).strict().transform((): string[] => []);
const MAX_RECORD_BYTES = 256_000;
const MAX_STATE_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const recordSchema = z.object({
  id: count.positive(), tool: z.string().min(1).max(64), createdAt: z.string().datetime(),
  output: z.union([z.array(z.string().max(131_072)).max(8), emptyArray]), cost: finite, balance: finite,
  requestId: z.number().int().safe().optional(), outputType: z.enum(['image', 'video', 'text']).optional(),
});
const stateSchema = z.object({
  version: z.literal(1), seq: count,
  records: z.union([z.array(recordSchema).max(100), z.object({}).strict().transform((): GenerationRecord[] => [])]),
  failedGenerations: count, totalGenerations: count, totalCost: finite,
  lastKnownBalance: finite.nullable(),
  byTool: z.record(z.string().min(1).max(64), z.object({ count, cost: finite })),
  since: z.string().datetime().nullable(),
});
type HistoryState = z.infer<typeof stateSchema>;

const emptyState = (): HistoryState => ({ version: 1, seq: 0, records: [], failedGenerations: 0,
  totalGenerations: 0, totalCost: 0, lastKnownBalance: null, byTool: {}, since: null });

/** Single-key read/modify/write. Upstash runs EVAL atomically, including expiry. */
const UPDATE_SCRIPT = `#!lua flags=allow-key-locking
local raw = redis.call('GET', KEYS[1])
local state = raw and cjson.decode(raw) or cjson.decode(ARGV[5])
if type(state) ~= 'table' or state.version ~= 1 or type(state.records) ~= 'table' or
   type(state.byTool) ~= 'table' or type(state.seq) ~= 'number' or
   type(state.totalGenerations) ~= 'number' or type(state.totalCost) ~= 'number' or
   type(state.failedGenerations) ~= 'number' then
  return redis.error_reply('invalid history state')
end
local op = ARGV[1]
local value = cjson.decode(ARGV[2])
local reply = 'OK'
if op == 'record' then
  state.seq = state.seq + 1
  state.totalGenerations = state.totalGenerations + 1
  state.totalCost = state.totalCost + value.cost
  value.id = state.seq
  state.lastKnownBalance = value.balance
  if state.since == cjson.null then state.since = value.createdAt end
  local bucket = state.byTool[value.tool] or { count = 0, cost = 0 }
  bucket.count = bucket.count + 1
  bucket.cost = bucket.cost + value.cost
  state.byTool[value.tool] = bucket
  table.insert(state.records, value)
  while #state.records > tonumber(ARGV[4]) do table.remove(state.records, 1) end
  reply = cjson.encode(value)
elseif op == 'failure' then
  state.failedGenerations = state.failedGenerations + 1
  if value.balance ~= cjson.null then state.lastKnownBalance = value.balance end
elseif op == 'balance' then
  state.lastKnownBalance = value.balance
else
  return redis.error_reply('invalid history operation')
end
if state.seq > 9007199254740991 or state.totalGenerations > 9007199254740991 or
   state.failedGenerations > 9007199254740991 or state.totalCost ~= state.totalCost or
   state.totalCost == math.huge or state.totalCost == -math.huge then
  return redis.error_reply('history numeric limit exceeded')
end
local encoded = cjson.encode(state)
while string.len(encoded) > tonumber(ARGV[6]) and #state.records > 1 do
  table.remove(state.records, 1)
  encoded = cjson.encode(state)
end
if string.len(encoded) > tonumber(ARGV[6]) then
  return redis.error_reply('history size limit exceeded')
end
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[3])
return reply`;

const READ_SCRIPT = `#!lua flags=allow-key-locking
local value = redis.call('GET', KEYS[1])
if value then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return value`;

export type RemoteHistoryErrorEvent = Readonly<{
  fingerprint: 'remote.history.storage';
  operation: 'acquire' | 'record' | 'failure' | 'balance' | 'recent' | 'summary' | 'ping';
}>;

export type UpstashRemoteHistoryOptions = {
  restUrl: string;
  restToken: string;
  keySecret: string;
  namespace: string;
  ttlSeconds?: number;
  maxRecordsPerUser?: number;
  fetch?: typeof fetch;
  onError?: (event: RemoteHistoryErrorEvent) => void;
};

export class UpstashRemoteSessionProvider implements RemoteSessionProvider {
  readonly #url: string;
  readonly #token: string;
  readonly #secret: string;
  readonly #namespace: string;
  readonly #ttl: number;
  readonly #maxRecords: number;
  readonly #fetch: typeof fetch;
  readonly #onError: UpstashRemoteHistoryOptions['onError'];

  constructor(options: UpstashRemoteHistoryOptions) {
    let url: URL;
    try { url = new URL(options.restUrl); } catch { throw new TypeError('Invalid history REST URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new TypeError('History REST URL must be an HTTPS origin.');
    }
    if (!options.restToken || !options.keySecret || options.keySecret.length < 32) {
      throw new TypeError('History REST token and a 32-character key secret are required.');
    }
    if (!/^[a-z0-9][a-z0-9:_-]{0,100}$/i.test(options.namespace)) {
      throw new TypeError('Invalid history namespace.');
    }
    this.#ttl = positiveInteger(options.ttlSeconds ?? 30 * 60, 'ttlSeconds', 90 * 24 * 3600);
    this.#maxRecords = positiveInteger(options.maxRecordsPerUser ?? 100, 'maxRecordsPerUser', 100);
    this.#url = url.href;
    this.#token = options.restToken;
    this.#secret = options.keySecret;
    this.#namespace = options.namespace;
    this.#fetch = options.fetch ?? fetch;
    this.#onError = options.onError;
  }

  async acquire(identity: RemoteIdentity): Promise<RemoteSessionLease> {
    if (!identity.issuer || !identity.subject) {
      throw new TypeError('Verified issuer and subject are required.');
    }
    const digest = createHmac('sha256', this.#secret)
      .update(JSON.stringify([identity.issuer, identity.subject])).digest('hex');
    const key = `${this.#namespace}:{${digest}}`;
    const session = new UpstashSessionHistory(this, key);
    await this.run('acquire', () => session.readState());
    return { session, release: () => {} };
  }

  /** Read-only liveness probe; does not access a user key or refresh its TTL. */
  async ping(signal?: AbortSignal): Promise<void> {
    await this.run('ping', async () => {
      if (await this.command(['PING'], signal) !== 'PONG') {
        throw new Error('History PING response invalid.');
      }
    });
  }

  async run<T>(operation: RemoteHistoryErrorEvent['operation'], action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      try { this.#onError?.({ fingerprint: 'remote.history.storage', operation }); } catch { /* callback isolation */ }
      throw new RemoteSessionUnavailableError();
    }
  }

  async command(args: readonly (string | number)[], signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    const timeout = setTimeout(onAbort, 5_000);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
    try {
    const response = await this.#fetch(this.#url, {
      method: 'POST', headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args), redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) throw new Error('History REST request failed.');
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) {
      throw new Error('History REST response invalid.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let part = await reader.read();
    while (!part.done) {
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('History REST response too large.');
      }
      chunks.push(part.value);
      part = await reader.read();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || !('result' in body) || 'error' in body) {
      throw new Error('History REST response invalid.');
    }
    return body.result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  get ttl(): number { return this.#ttl; }
  get maxRecords(): number { return this.#maxRecords; }
}

class UpstashSessionHistory implements SessionHistory {
  constructor(private readonly provider: UpstashRemoteSessionProvider, private readonly key: string) {}

  async readState(): Promise<HistoryState> {
    const result = await this.provider.command(['EVAL', READ_SCRIPT, 1, this.key, this.provider.ttl]);
    if (result === null) return emptyState();
    if (typeof result !== 'string') throw new Error('History value invalid.');
    const parsed: unknown = JSON.parse(result);
    const state = stateSchema.parse(parsed);
    if (state.records.length > this.provider.maxRecords || Object.keys(state.byTool).length > 32 ||
        state.seq < state.totalGenerations || state.totalGenerations < state.records.length) {
      throw new Error('History state invalid.');
    }
    return state;
  }

  async record(entry: Omit<GenerationRecord, 'id' | 'createdAt'>): Promise<GenerationRecord> {
    return this.provider.run('record', async () => {
      const value = recordSchema.omit({ id: true }).parse({ ...entry, createdAt: new Date().toISOString() });
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_RECORD_BYTES) {
        throw new Error('History record too large.');
      }
      const result = await this.update('record', value);
      if (typeof result !== 'string') throw new Error('History result invalid.');
      return normalizeRecord(recordSchema.parse(JSON.parse(result)));
    });
  }

  async recordFailure(balance?: number): Promise<void> {
    await this.provider.run('failure', async () => {
      await this.update('failure', { balance: balance === undefined ? null : finite.parse(balance) });
    });
  }

  async updateBalance(balance: number): Promise<void> {
    await this.provider.run('balance', async () => {
      await this.update('balance', { balance: finite.parse(balance) });
    });
  }

  async recent(limit = 10): Promise<GenerationRecord[]> {
    const bounded = Math.min(positiveInteger(limit, 'limit', 100), this.provider.maxRecords);
    const state = await this.provider.run('recent', () => this.readState());
    return state.records.slice(-bounded).reverse().map(normalizeRecord);
  }

  async summary(): Promise<UsageSummary> {
    const state = await this.provider.run('summary', () => this.readState());
    return { totalGenerations: state.totalGenerations, failedGenerations: state.failedGenerations,
      totalCost: state.totalCost, lastKnownBalance: state.lastKnownBalance,
      byTool: state.byTool, since: state.since };
  }

  private async update(operation: string, value: object): Promise<unknown> {
    const result = await this.provider.command(['EVAL', UPDATE_SCRIPT, 1, this.key, operation,
      JSON.stringify(value), this.provider.ttl, this.provider.maxRecords, JSON.stringify(emptyState()), MAX_STATE_BYTES]);
    if (operation !== 'record' && result !== 'OK') throw new Error('History result invalid.');
    return result;
  }
}

const positiveInteger = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
};

const normalizeRecord = (value: z.infer<typeof recordSchema>): GenerationRecord => ({
  id: value.id, tool: value.tool, createdAt: value.createdAt, output: value.output,
  cost: value.cost, balance: value.balance,
  ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
  ...(value.outputType === undefined ? {} : { outputType: value.outputType }),
});
