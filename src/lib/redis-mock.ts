/**
 * In-memory mock of the subset of @upstash/redis API used by AgentPay.
 * Used for local development and testing when Upstash credentials are unavailable.
 */

type HashData = Record<string, string | number>;

interface ZSetEntry {
  score: number;
  member: string;
}

interface StringEntry {
  value: string;
  expiresAt?: number;
}

class MockPipeline {
  private ops: Array<() => void> = [];

  constructor(private store: MockRedis) {}

  zadd(key: string, entry: { score: number; member: string }) {
    this.ops.push(() => this.store._zadd(key, entry));
    return this;
  }

  hincrby(key: string, field: string, increment: number) {
    this.ops.push(() => this.store._hincrby(key, field, increment));
    return this;
  }

  hset(key: string, data: Record<string, unknown>) {
    this.ops.push(() => this.store._hset(key, data));
    return this;
  }

  set(key: string, value: string, opts?: { ex?: number }) {
    this.ops.push(() => this.store._set(key, value, opts));
    return this;
  }

  async exec(): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const op of this.ops) {
      results.push(op());
    }
    return results;
  }
}

class MockRedis {
  private hashes: Map<string, HashData> = new Map();
  private zsets: Map<string, ZSetEntry[]> = new Map();
  private strings: Map<string, StringEntry> = new Map();

  _hset(key: string, data: Record<string, unknown>): void {
    const existing = this.hashes.get(key) || {};
    for (const [k, v] of Object.entries(data)) {
      existing[k] = v as string | number;
    }
    this.hashes.set(key, existing);
  }

  _hincrby(key: string, field: string, increment: number): number {
    const existing = this.hashes.get(key) || {};
    const current = Number(existing[field] || 0);
    existing[field] = current + increment;
    this.hashes.set(key, existing);
    return current + increment;
  }

  _zadd(key: string, entry: { score: number; member: string }): void {
    const existing = this.zsets.get(key) || [];
    existing.push(entry);
    this.zsets.set(key, existing);
  }

  async hset(key: string, data: Record<string, unknown>): Promise<number> {
    this._hset(key, data);
    return Object.keys(data).length;
  }

  async hgetall(key: string): Promise<Record<string, unknown> | null> {
    const data = this.hashes.get(key);
    if (!data) return null;
    return { ...data };
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return this._hincrby(key, field, increment);
  }

  async scan(
    cursor: number,
    opts: { match: string; count?: number }
  ): Promise<[number, string[]]> {
    const pattern = opts.match.replace(/\*/g, ".*");
    const regex = new RegExp(`^${pattern}$`);
    const keys = Array.from(this.hashes.keys()).filter((k) => regex.test(k));
    // Return all matching keys at once with cursor 0 (done)
    return [0, keys];
  }

  async zadd(
    key: string,
    entry: { score: number; member: string }
  ): Promise<number> {
    this._zadd(key, entry);
    return 1;
  }

  async zrange<T = unknown>(
    key: string,
    _max: string | number,
    _min: string | number,
    opts?: { byScore?: boolean; rev?: boolean; offset?: number; count?: number }
  ): Promise<T[]> {
    const entries = this.zsets.get(key) || [];
    let sorted = [...entries].sort((a, b) =>
      opts?.rev ? b.score - a.score : a.score - b.score
    );

    const offset = opts?.offset || 0;
    const count = opts?.count || sorted.length;
    sorted = sorted.slice(offset, offset + count);

    return sorted.map((e) => {
      try {
        return JSON.parse(e.member);
      } catch {
        return e.member;
      }
    }) as T[];
  }

  _set(key: string, value: string, opts?: { ex?: number }): void {
    const expiresAt = opts?.ex ? Date.now() + opts.ex * 1000 : undefined;
    this.strings.set(key, { value, expiresAt });
  }

  async set(
    key: string,
    value: string,
    opts?: { ex?: number; nx?: boolean }
  ): Promise<"OK" | null> {
    const existing = this.strings.get(key);
    const now = Date.now();
    // If nx=true and key already exists (and not expired), return null
    if (opts?.nx) {
      if (existing && (!existing.expiresAt || existing.expiresAt > now)) {
        return null;
      }
    }
    this._set(key, value, opts);
    return "OK";
  }

  async del(key: string): Promise<number> {
    const hadHash = this.hashes.delete(key);
    const hadZSet = this.zsets.delete(key);
    const hadString = this.strings.delete(key);
    return hadHash || hadZSet || hadString ? 1 : 0;
  }

  /**
   * Simulates Redis EVAL for the spend-cap Lua script.
   * Atomically checks spendCap vs spent+amount and increments if within cap.
   * Returns 1 if reservation succeeded, 0 if over cap.
   */
  async eval(_script: string, keys: string[], args: string[]): Promise<number> {
    const authKey = keys[0];
    const amount = Number(args[0]);
    const existing = this.hashes.get(authKey) || {};
    const spent = Number(existing["spent"] || 0);
    const cap = Number(existing["spendCap"] || 0);
    if (spent + amount > cap) return 0;
    existing["spent"] = spent + amount;
    this.hashes.set(authKey, existing);
    return 1;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.strings.delete(key);
      return null;
    }
    return entry.value;
  }

  pipeline(): MockPipeline {
    return new MockPipeline(this);
  }
}

export const redisMock = new MockRedis();
