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
  expiresAt?: number; // unix ms
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

  async set(
    key: string,
    value: string,
    opts?: { nx?: boolean; ex?: number }
  ): Promise<"OK" | null> {
    if (opts?.nx) {
      const existing = this.strings.get(key);
      const now = Date.now();
      if (existing && (!existing.expiresAt || existing.expiresAt > now)) {
        return null; // key exists and not expired — NX condition fails
      }
    }
    const entry: StringEntry = { value };
    if (opts?.ex) {
      entry.expiresAt = Date.now() + opts.ex * 1000;
    }
    this.strings.set(key, entry);
    return "OK";
  }

  // Simulate Lua eval for the two spend-cap scripts used by paywall.
  // Not a general Lua evaluator — dispatches by script signature.
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    // Spend cap RESERVE: HINCRBY spent by amount if within cap, else return 0
    if (script.includes("spendCap") && script.includes("HINCRBY")) {
      const key = keys[0];
      const amount = Number(args[0]);
      const data = this.hashes.get(key) || {};
      const spent = Number(data["spent"] || 0);
      const cap = Number(data["spendCap"] || 0);
      if (spent + amount > cap) return 0;
      this._hincrby(key, "spent", amount);
      return 1;
    }
    // Spend cap RELEASE: clamp spent to max(0, spent - amount)
    if (script.includes("math.max")) {
      const key = keys[0];
      const amount = Number(args[0]);
      const data = this.hashes.get(key) || {};
      const current = Number(data["spent"] || 0);
      this._hset(key, { spent: Math.max(0, current - amount) });
      return 1;
    }
    throw new Error(`MockRedis.eval: unsupported script`);
  }

  pipeline(): MockPipeline {
    return new MockPipeline(this);
  }
}

export const redisMock = new MockRedis();
