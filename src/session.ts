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
}

export interface UsageSummary {
  totalGenerations: number;
  totalCost: number;
  lastKnownBalance: number | null;
  byTool: Record<string, { count: number; cost: number }>;
  since: string | null;
}

export class SessionStore {
  #records: GenerationRecord[] = [];
  #seq = 0;
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
        this.#seq = this.#records.reduce((max, record) => Math.max(max, record.id), 0);
      }
    } catch {
      // No (or unreadable) prior state — start fresh.
    }
  }

  async record(entry: { tool: string; output: string[]; cost: number; balance: number }): Promise<GenerationRecord> {
    const record: GenerationRecord = {
      id: ++this.#seq,
      tool: entry.tool,
      createdAt: new Date().toISOString(),
      output: entry.output,
      cost: entry.cost,
      balance: entry.balance,
    };
    this.#records.push(record);
    await this.#persist();
    return record;
  }

  /** Most recent generations first. */
  recent(limit = 10): GenerationRecord[] {
    return this.#records.slice(-limit).reverse();
  }

  summary(): UsageSummary {
    const byTool: Record<string, { count: number; cost: number }> = {};
    let totalCost = 0;
    for (const record of this.#records) {
      totalCost += record.cost;
      const bucket = (byTool[record.tool] ??= { count: 0, cost: 0 });
      bucket.count += 1;
      bucket.cost += record.cost;
    }
    return {
      totalGenerations: this.#records.length,
      totalCost,
      lastKnownBalance: this.#records.at(-1)?.balance ?? null,
      byTool,
      since: this.#records[0]?.createdAt ?? null,
    };
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
