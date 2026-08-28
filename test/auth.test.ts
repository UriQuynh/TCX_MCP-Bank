import { describe, expect, it } from 'vitest';
import { generateApiKey, hashSecret, parseApiKey, verifySecret } from '../src/auth/api-key.js';
import { authenticate } from '../src/auth/authenticate.js';
import { MemoryRateLimiter, RedisRateLimiter } from '../src/auth/rate-limit.js';
import { redactParams } from '../src/audit/audit-log.js';
import { AuthError } from '../src/errors.js';
import { makeKey, makeStore } from './helpers.js';

const OPTS = { defaultRateLimitPerMinute: 60 };

describe('api-key format', () => {
  it('generate -> parse -> verify', () => {
    const g = generateApiKey();
    expect(g.plaintext).toMatch(/^tcxb_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
    const p = parseApiKey(g.plaintext)!;
    expect(p.id).toBe(g.id);
    expect(verifySecret(p.secret, hashSecret(g.secret))).toBe(true);
    expect(verifySecret('x'.repeat(43), hashSecret(g.secret))).toBe(false);
  });

  it('rejects malformed keys', () => {
    expect(parseApiKey('')).toBeNull();
    expect(parseApiKey('tcxb_short')).toBeNull();
    expect(parseApiKey('Bearer tcxb_abcdefabcdef_' + 'a'.repeat(43))).toBeNull();
  });
});

describe('authenticate', () => {
  const good = makeKey('svc', ['wallet:read', 'not-a-scope']);
  const disabled = makeKey('off', ['wallet:read'], { enabled: false });
  const expired = makeKey('old', ['wallet:read'], { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const store = makeStore(good.record, disabled.record, expired.record);

  const reasonOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof AuthError ? e.reason : 'not-auth-error';
    }
    return 'no-throw';
  };

  it('accepts valid key and filters unknown scopes', () => {
    const p = authenticate(store, good.plaintext, OPTS);
    expect(p.keyId).toBe(good.record.id);
    expect(p.scopes).toEqual(['wallet:read']);
    expect(p.rateLimitPerMinute).toBe(60);
  });

  it('denies missing / malformed / unknown / bad secret / disabled / expired', () => {
    expect(reasonOf(() => authenticate(store, undefined, OPTS))).toBe('missing');
    expect(reasonOf(() => authenticate(store, 'nope', OPTS))).toBe('malformed');
    const unknown = generateApiKey().plaintext;
    expect(reasonOf(() => authenticate(store, unknown, OPTS))).toBe('unknown_key');
    const tampered = good.plaintext.slice(0, -1) + (good.plaintext.endsWith('a') ? 'b' : 'a');
    expect(reasonOf(() => authenticate(store, tampered, OPTS))).toBe('bad_secret');
    expect(reasonOf(() => authenticate(store, disabled.plaintext, OPTS))).toBe('disabled');
    expect(reasonOf(() => authenticate(store, expired.plaintext, OPTS))).toBe('expired');
  });

  it('client-facing message never leaks the reason', () => {
    try {
      authenticate(store, expired.plaintext, OPTS);
    } catch (e) {
      expect((e as Error).message).not.toMatch(/expired|hết hạn/i);
    }
  });
});

describe('rate limiter', () => {
  it('blocks after N hits per minute and recovers', async () => {
    let t = 0;
    const rl = new MemoryRateLimiter(() => t);
    for (let i = 0; i < 3; i++) expect((await rl.check('k', 3)).allowed).toBe(true);
    const blocked = await rl.check('k', 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    t = 60_001;
    expect((await rl.check('k', 3)).allowed).toBe(true);
  });

  it('redis limiter: fixed window shared via INCR, fail-closed on error', async () => {
    const counters = new Map<string, number>();
    let failing = false;
    const fake = {
      multi() {
        let key = '';
        return {
          incr(k: string) { key = k; return this; },
          pexpire() { return this; },
          async exec() {
            if (failing) throw new Error('ECONNREFUSED');
            const n = (counters.get(key) ?? 0) + 1;
            counters.set(key, n);
            return [[null, n], [null, 1]] as Array<[Error | null, unknown]>;
          },
        };
      },
    };
    let t = 0;
    const rl = new RedisRateLimiter(fake, { now: () => t, onError: () => undefined });
    expect((await rl.check('k', 2)).allowed).toBe(true);
    expect((await rl.check('k', 2)).allowed).toBe(true);
    expect((await rl.check('k', 2)).allowed).toBe(false);
    t = 60_000;
    expect((await rl.check('k', 2)).allowed).toBe(true);
    failing = true;
    expect((await rl.check('k', 2)).allowed).toBe(false);
    const open = new RedisRateLimiter(fake, { now: () => t, failOpen: true, onError: () => undefined });
    expect((await open.check('k', 2)).allowed).toBe(true);
  });
});

describe('audit redaction', () => {
  it('redacts secrets and masks account numbers', () => {
    const out = redactParams({ api_key: 'x', nested: { token: 'y' }, to_account_number: '1234567890', amount: 5 }) as any;
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.nested.token).toBe('[REDACTED]');
    expect(out.to_account_number).toBe('******7890');
    expect(out.amount).toBe(5);
  });
});
