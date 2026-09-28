/**
 * In-memory (optionally persisted) record of generations performed this
 * session. Powers the QoL tools usage_summary and list_recent_generations,
 * and surfaces the last-known balance without spending a credit.
 *
 * Persistence is opt-in via MYARCHITECTAI_STATE_FILE; otherwise history lives
 * for the lifetime of the server process (one MCP session).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface GenerationRecord {
  id: number;
  tool: string;
  createdAt: string;
  output: string[];
  cost: number;
  balance: number;
  requestId?: number;
  outputType?: 'image' | 'video' | 'text';
}

export interface UsageSummary {
  totalGenerations: number;
  failedGenerations: number;
  totalCost: number;
  lastKnownBalance: number | null;
  byTool: Record<string, { count: number; cost: number }>;
  since: string | null;
}

export class SessionStore {
  #records: GenerationRecord[] = [];
  #seq = 0;
  #failedGenerations = 0;
  #lastKnownBalance: number | null = null;
  #totalGenerations = 0;
  #totalCost = 0;
  #byTool: Record<string, { count: number; cost: number }> = {};
  #since: string | null = null;
  readonly #stateFile: string | undefined;
  readonly #maxRecords: number | undefined;

  constructor(stateFile?: string, opts: { maxRecords?: number } = {}) {
    if (opts.maxRecords !== undefined && (!Number.isSafeInteger(opts.maxRecords) || opts.maxRecords < 1)) {
      throw new RangeError('maxRecords must be a positive integer.');
    }
    this.#stateFile = stateFile;
    this.#maxRecords = opts.maxRecords;
  }

  /** Load persisted history if a state file is configured and present. */
  async init(): Promise<void> {
    if (this.#stateFile === undefined) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#stateFile, 'utf8'));
      if (Array.isArray(parsed)) {
        const records = parsed.filter(isRecord);
        this.#seq = records.reduce((max, record) => Math.max(max, record.id), 0);
        this.#records = this.#maxRecords === undefined ? records : records.slice(-this.#maxRecords);
        this.#lastKnownBalance = this.#records.at(-1)?.balance ?? null;
        for (const record of records) {
          this.#accumulate(record);
        }
      }
    } catch {
      // No (or unreadable) prior state — start fresh.
    }
  }

  async record(entry: Omit<GenerationRecord, 'id' | 'createdAt'>): Promise<GenerationRecord> {
    const record: GenerationRecord = {
      id: ++this.#seq,
      tool: entry.tool,
      createdAt: new Date().toISOString(),
      output: entry.output,
      cost: entry.cost,
      balance: entry.balance,
      ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
      ...(entry.outputType !== undefined ? { outputType: entry.outputType } : {}),
    };
    this.#records.push(record);
    this.#accumulate(record);
    if (this.#maxRecords !== undefined && this.#records.length > this.#maxRecords) {
      this.#records.splice(0, this.#records.length - this.#maxRecords);
    }
    this.#lastKnownBalance = record.balance;
    await this.#persist();
    return record;
  }

  /**
   * Note a generation that failed at the API/validation level (not a transport
   * error). Increments the failure count and, when the API reported a balance
   * on the error, updates the last-known balance — so usage_summary stays
   * informative even for a session with no successful generations.
   */
  recordFailure(balance?: number): void {
    this.#failedGenerations += 1;
    if (typeof balance === 'number') {
      this.#lastKnownBalance = balance;
    }
  }

  updateBalance(balance: number): void {
    this.#lastKnownBalance = balance;
  }

  /** Most recent generations first. */
  recent(limit = 10): GenerationRecord[] {
    return this.#records.slice(-limit).reverse();
  }

  summary(): UsageSummary {
    return {
      totalGenerations: this.#totalGenerations,
      failedGenerations: this.#failedGenerations,
      totalCost: this.#totalCost,
      lastKnownBalance: this.#lastKnownBalance,
      byTool: structuredClone(this.#byTool),
      since: this.#since,
    };
  }

  #accumulate(record: GenerationRecord): void {
    this.#totalGenerations += 1;
    this.#totalCost += record.cost;
    this.#since ??= record.createdAt;
    const bucket = (this.#byTool[record.tool] ??= { count: 0, cost: 0 });
    bucket.count += 1;
    bucket.cost += record.cost;
  }

  async #persist(): Promise<void> {
    if (this.#stateFile === undefined) return;
    try {
      await mkdir(path.dirname(this.#stateFile), { recursive: true });
      await writeFile(this.#stateFile, JSON.stringify(this.#records, null, 2));
    } catch {
      // Best effort — never fail a generation because history couldn't be written.
    }
  }
}

function isRecord(value: unknown): value is GenerationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'number' &&
    typeof v.tool === 'string' &&
    typeof v.createdAt === 'string' &&
    Array.isArray(v.output) &&
    v.output.every((item) => typeof item === 'string') &&
    typeof v.cost === 'number' &&
    typeof v.balance === 'number'
  );
}
