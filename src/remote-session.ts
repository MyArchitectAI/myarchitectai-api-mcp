import { SessionStore, type SessionHistory } from './session.js';

/** The HTTP boundary must derive both fields from a verified bearer token. */
export type RemoteIdentity = Readonly<{ issuer: string; subject: string }>;

export type RemoteSessionLease = Readonly<{
  session: SessionHistory;
  release: () => void | Promise<void>;
}>;

export type RemoteSessionProvider = {
  acquire(identity: RemoteIdentity): RemoteSessionLease | Promise<RemoteSessionLease>;
};

type LocalRemoteSessionLease = Readonly<{ session: SessionStore; release: () => void }>;

export class RemoteSessionUnavailableError extends Error {
  constructor() {
    super('Remote generation history is unavailable.');
    this.name = 'RemoteSessionUnavailableError';
  }
}

type Entry = {
  session: SessionStore;
  activeLeases: number;
  lastUsedAt: number;
};

type RegistryOptions = {
  maxUsers?: number;
  maxRecordsPerUser?: number;
  idleTtlMs?: number;
  /** Injectable clock for deterministic expiry tests. */
  now?: () => number;
};

export class RemoteSessionCapacityError extends Error {
  constructor() {
    super('Remote session capacity reached.');
    this.name = 'RemoteSessionCapacityError';
  }
}

/** Process-local bounded history shared by stateless requests from one verified user. */
export class RemoteSessionRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #maxUsers: number;
  readonly #maxRecordsPerUser: number;
  readonly #idleTtlMs: number;
  readonly #now: () => number;

  constructor(opts: RegistryOptions = {}) {
    this.#maxUsers = positiveInteger(opts.maxUsers ?? 500, 'maxUsers');
    this.#maxRecordsPerUser = positiveInteger(opts.maxRecordsPerUser ?? 100, 'maxRecordsPerUser');
    this.#idleTtlMs = positiveInteger(opts.idleTtlMs ?? 30 * 60_000, 'idleTtlMs');
    this.#now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Acquires a per-user store; release exactly once after the request completes. */
  acquire(identity: RemoteIdentity): LocalRemoteSessionLease {
    if (!identity.issuer || !identity.subject) {
      throw new TypeError('Verified issuer and subject are required.');
    }
    const key = JSON.stringify([identity.issuer, identity.subject]);
    const now = this.#now();
    this.#evictExpired(now);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      if (this.#entries.size >= this.#maxUsers) {
        throw new RemoteSessionCapacityError();
      }
      entry = {
        session: new SessionStore(undefined, { maxRecords: this.#maxRecordsPerUser }),
        activeLeases: 0,
        lastUsedAt: now,
      };
      this.#entries.set(key, entry);
    }
    entry.activeLeases += 1;
    entry.lastUsedAt = now;
    let released = false;
    return {
      session: entry.session,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        entry.activeLeases -= 1;
        entry.lastUsedAt = this.#now();
      },
    };
  }

  #evictExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.activeLeases === 0 && now - entry.lastUsedAt >= this.#idleTtlMs) {
        this.#entries.delete(key);
      }
    }
  }
}

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
};
