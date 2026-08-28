export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export interface RateLimiter {
  check(key: string, perMinute: number): Promise<RateLimitResult>;
}

// Sliding-window trong bộ nhớ: đủ cho 1 instance. Nhiều instance -> RedisRateLimiter.
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async check(key: string, perMinute: number): Promise<RateLimitResult> {
    const t = this.now();
    const cutoff = t - 60_000;
    const hits = (this.windows.get(key) ?? []).filter((x) => x > cutoff);
    if (hits.length >= perMinute) {
      this.windows.set(key, hits);
      return { allowed: false, retryAfterMs: Math.max(1, hits[0]! + 60_000 - t) };
    }
    hits.push(t);
    this.windows.set(key, hits);
    return { allowed: true };
  }

  reset(key?: string): void {
    if (key) this.windows.delete(key);
    else this.windows.clear();
  }
}

// Tập con API ioredis mà limiter cần, để test bằng fake không cần Redis thật.
export interface RedisMultiLike {
  incr(key: string): RedisMultiLike;
  pexpire(key: string, ms: number): RedisMultiLike;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface RedisLike {
  multi(): RedisMultiLike;
}

export interface RedisRateLimiterOptions {
  prefix?: string;
  // Redis lỗi: true = cho qua (ưu tiên khả dụng), false = chặn (mặc định, ưu tiên an toàn)
  failOpen?: boolean;
  now?: () => number;
  onError?: (err: Error) => void;
}

// Fixed-window theo phút, dùng chung giữa nhiều instance qua Redis (INCR + PEXPIRE nguyên tử trong MULTI).
export class RedisRateLimiter implements RateLimiter {
  private readonly prefix: string;
  private readonly failOpen: boolean;
  private readonly now: () => number;
  private readonly onError: (err: Error) => void;

  constructor(
    private readonly redis: RedisLike,
    opts: RedisRateLimiterOptions = {},
  ) {
    this.prefix = opts.prefix ?? 'tcxmcp:rl';
    this.failOpen = opts.failOpen ?? false;
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? ((e) => process.stderr.write(`[rate-limit] redis lỗi: ${e.message}\n`));
  }

  async check(key: string, perMinute: number): Promise<RateLimitResult> {
    const t = this.now();
    const windowStart = Math.floor(t / 60_000) * 60_000;
    const redisKey = `${this.prefix}:${key}:${windowStart}`;
    try {
      const res = await this.redis.multi().incr(redisKey).pexpire(redisKey, 60_000).exec();
      const first = res?.[0];
      if (!first) throw new Error('MULTI trả về rỗng');
      const [err, value] = first;
      if (err) throw err;
      const count = Number(value);
      if (count > perMinute) return { allowed: false, retryAfterMs: Math.max(1, windowStart + 60_000 - t) };
      return { allowed: true };
    } catch (err) {
      this.onError(err as Error);
      return this.failOpen ? { allowed: true } : { allowed: false, retryAfterMs: 5_000 };
    }
  }
}
