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

type PersistedState = {
  version: 1;
  records: GenerationRecord[];
  failedGenerations: number;
  retainedCosts: Record<string, number>;
  lastKnownBalance: number | null;
};

export class SessionStore {
  #records: GenerationRecord[] = [];
  #seq = 0;
  #failedGenerations = 0;
  #retainedCosts = new Map<string, number>();
  #lastKnownBalance: number | null = null;
  #persistence: Promise<void> = Promise.resolve();
  readonly #stateFile: string | undefined;

  constructor(stateFile?: string) {
    this.#stateFile = stateFile;
  }

  /** Load persisted history if a state file is configured and present. */
  async init(): Promise<void> {
    if (this.#stateFile === undefined) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#stateFile, 'utf8'));
      if (Array.isArray(parsed)) {
        this.#records = parsed.filter(isRecord);
        this.#lastKnownBalance = this.#records.at(-1)?.balance ?? null;
      } else if (isPersistedState(parsed)) {
        this.#records = parsed.records;
        this.#failedGenerations = parsed.failedGenerations;
        this.#retainedCosts = new Map(Object.entries(parsed.retainedCosts));
        this.#lastKnownBalance = parsed.lastKnownBalance;
      }
      this.#seq = this.#records.reduce((max, record) => Math.max(max, record.id), 0);
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
    this.#lastKnownBalance = record.balance;
    await this.#persist();
    return record;
  }

  /**
   * Note a generation that failed at the API/validation level (not a transport
   * error). Increments the failure count and, when the API reported a balance
   * on the error, updates the last-known balance — so usage_summary stays
   * informative even for a session with no successful generations. Retained
   * policy charges are included in spend without inventing successful results.
   */
  async recordFailure(balance?: number, charge?: { tool: string; code: string | undefined; cost: number | undefined }): Promise<void> {
    this.#failedGenerations += 1;
    if (typeof balance === 'number') {
      this.#lastKnownBalance = balance;
    }
    // A billed policy rejection has no usable output. Track its retained charge
    // without adding it to successful generation counts or recent history.
    if (charge?.code === 'CONTENT_POLICY_VIOLATION' && typeof charge.cost === 'number' &&
      Number.isFinite(charge.cost) && charge.cost > 0) {
      this.#retainedCosts.set(charge.tool, (this.#retainedCosts.get(charge.tool) ?? 0) + charge.cost);
    }
    await this.#persist();
  }

  updateBalance(balance: number): void {
    this.#lastKnownBalance = balance;
  }

  /** Most recent generations first. */
  recent(limit = 10): GenerationRecord[] {
    return this.#records.slice(-limit).reverse();
  }

  summary(): UsageSummary {
    const byTool = new Map<string, { count: number; cost: number }>();
    let totalCost = 0;
    for (const record of this.#records) {
      totalCost += record.cost;
      const bucket = byTool.get(record.tool) ?? { count: 0, cost: 0 };
      bucket.count += 1;
      bucket.cost += record.cost;
      byTool.set(record.tool, bucket);
    }
    for (const [tool, cost] of this.#retainedCosts) {
      totalCost += cost;
      const bucket = byTool.get(tool) ?? { count: 0, cost: 0 };
      bucket.cost += cost;
      byTool.set(tool, bucket);
    }
    return {
      totalGenerations: this.#records.length,
      failedGenerations: this.#failedGenerations,
      totalCost,
      lastKnownBalance: this.#lastKnownBalance,
      byTool: Object.fromEntries(byTool),
      since: this.#records[0]?.createdAt ?? null,
    };
  }

  async #persist(): Promise<void> {
    if (this.#stateFile === undefined) return;
    const state: PersistedState = {
      version: 1,
      records: this.#records,
      failedGenerations: this.#failedGenerations,
      retainedCosts: Object.fromEntries(this.#retainedCosts),
      lastKnownBalance: this.#lastKnownBalance,
    };
    const snapshot = JSON.stringify(state, null, 2);
    // Keep snapshots in mutation order when tool calls finish concurrently.
    this.#persistence = this.#persistence.then(async () => {
      // The immutable path comes from local startup config, never tool/API input.
      if (this.#stateFile === undefined) return;
      try {
        await mkdir(path.dirname(this.#stateFile), { recursive: true });
        await writeFile(this.#stateFile, snapshot);
      } catch {
        // Best effort — never fail a generation because history couldn't be written.
      }
    });
    await this.#persistence;
  }
}

function isPersistedState(value: unknown): value is PersistedState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && Array.isArray(v.records) && v.records.every(isRecord) &&
    typeof v.failedGenerations === 'number' && Number.isInteger(v.failedGenerations) && v.failedGenerations >= 0 &&
    typeof v.retainedCosts === 'object' && v.retainedCosts !== null && !Array.isArray(v.retainedCosts) &&
    Object.values(v.retainedCosts).every((cost) => typeof cost === 'number' && Number.isFinite(cost) && cost > 0) &&
    (v.lastKnownBalance === null || typeof v.lastKnownBalance === 'number' && Number.isFinite(v.lastKnownBalance));
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
