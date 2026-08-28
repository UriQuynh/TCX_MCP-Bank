import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter, RedisRateLimiter, type RedisLike } from '../src/auth/rate-limit.js';

describe('MemoryRateLimiter.reset', () => {
  it('reset(key) clears only that key; reset() clears all', async () => {
    const rl = new MemoryRateLimiter(() => 0);
    await rl.check('a', 1);
    await rl.check('b', 1);
    rl.reset('a');
    expect((await rl.check('a', 1)).allowed).toBe(true);
    expect((await rl.check('b', 1)).allowed).toBe(false);
    rl.reset();
    expect((await rl.check('b', 1)).allowed).toBe(true);
  });
});

function fakeRedis(exec: () => Promise<Array<[Error | null, unknown]> | null>, seen: string[] = []): RedisLike {
  return {
    multi() {
      const chain = {
        incr(k: string) {
          seen.push(k);
          return chain;
        },
        pexpire() {
          return chain;
        },
        exec,
      };
      return chain;
    },
  };
}

describe('RedisRateLimiter', () => {
  it.each([
    ['exec returns null', async () => null],
    ['exec returns error tuple', async () => [[new Error('READONLY'), null]] as Array<[Error | null, unknown]>],
  ])('%s -> fail-closed (denied with retryAfterMs)', async (_name, exec) => {
    const rl = new RedisRateLimiter(fakeRedis(exec), { onError: () => undefined });
    const r = await rl.check('k', 10);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it.each([
    ['default prefix at t=0', undefined, 0, 'tcxmcp:rl:k:0'],
    ['custom prefix, window floored to minute', 'p', 125_000, 'p:k:120000'],
  ])('redis key uses prefix + window start (%s)', async (_name, prefix, now, expectedKey) => {
    const seen: string[] = [];
    const rl = new RedisRateLimiter(fakeRedis(async () => [[null, 1]], seen), { ...(prefix ? { prefix } : {}), now: () => now });
    await rl.check('k', 10);
    expect(seen).toEqual([expectedKey]);
  });
});
