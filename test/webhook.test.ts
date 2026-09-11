import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockBankProvider } from '../src/bank/mock-bank.provider.js';
import type { IncomingPaymentRecord } from '../src/bank/types.js';
import { AppError } from '../src/errors.js';
import { forwardIncomingPayment, handleIncomingPaymentWebhook, verifyWebhookSignature } from '../src/webhooks/incoming-payment.js';
import { CollectingAudit } from './helpers.js';

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = 1_700_000_000;
const SECRET = 'whsec';
const BODY = Buffer.from('{"event_id":"e1"}');
const sign = (ts: number | string, body: Buffer = BODY) => createHmac('sha256', SECRET).update(`${ts}.`).update(body).digest('hex');
const OPTS = { secret: SECRET, toleranceSec: 300, now: () => NOW_MS };

afterEach(() => vi.useRealTimers());

describe('verifyWebhookSignature', () => {
  it.each([
    ['missing timestamp', { signature: sign(NOW_SEC) }, /Timestamp/],
    ['non-numeric timestamp', { timestamp: 'abc', signature: sign('abc') }, /Timestamp/],
    ['timestamp older than tolerance', { timestamp: String(NOW_SEC - 301), signature: sign(NOW_SEC - 301) }, /replay/],
    ['timestamp in the future beyond tolerance', { timestamp: String(NOW_SEC + 301), signature: sign(NOW_SEC + 301) }, /replay/],
    ['signature wrong length', { timestamp: String(NOW_SEC), signature: 'abc' }, /Signature/],
    ['signature mismatch', { timestamp: String(NOW_SEC), signature: 'f'.repeat(64) }, /không khớp/],
  ])('%s -> WEBHOOK_REJECTED', (_name, headers, re) => {
    let err: AppError | undefined;
    try {
      verifyWebhookSignature(BODY, headers, OPTS);
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe('WEBHOOK_REJECTED');
    expect(err?.message).toMatch(re);
  });

  it.each([
    ['"sha256=" prefixed signature', `sha256=${sign(NOW_SEC)}`],
    ['uppercase hex signature', sign(NOW_SEC).toUpperCase()],
    ['timestamp at tolerance edge (-300s)', null],
  ])('%s is accepted', (_name, sig) => {
    const ts = sig === null ? NOW_SEC - 300 : NOW_SEC;
    expect(() => verifyWebhookSignature(BODY, { timestamp: String(ts), signature: sig ?? sign(ts) }, OPTS)).not.toThrow();
  });
});

const record: IncomingPaymentRecord = {
  event_id: 'evt-fwd',
  wallet_id: 'wal_1',
  account_number: '900000000001',
  amount: 10,
  occurred_at: '2026-08-28T10:00:00.000Z',
  received_at: '2026-08-28T10:00:01.000Z',
  applied: true,
  transaction_id: 'txn_1',
};

function fetchSequence(statuses: Array<number | Error>) {
  const calls: number[] = [];
  const fetchImpl = (async () => {
    const next = statuses[calls.length] ?? 200;
    calls.push(1);
    if (next instanceof Error) throw next;
    return new Response('', { status: next });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('forwardIncomingPayment', () => {
  it('first attempt 200 -> true, one success audit entry', async () => {
    const audit = new CollectingAudit();
    const { fetchImpl, calls } = fetchSequence([200]);
    expect(await forwardIncomingPayment(record, { url: 'https://203.0.113.20/hook', secret: 's', audit, fetchImpl })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(audit.entries.map((e) => e.outcome)).toEqual(['success']);
  });

  it('500 then 200 -> retries after 500ms backoff and succeeds', async () => {
    vi.useFakeTimers();
    const audit = new CollectingAudit();
    const { fetchImpl, calls } = fetchSequence([500, 200]);
    const pending = forwardIncomingPayment(record, { url: 'https://203.0.113.20/hook', secret: 's', audit, fetchImpl });
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(true);
    expect(calls).toHaveLength(2);
    expect(audit.entries.map((e) => [e.outcome, e.code])).toEqual([['error', 'HTTP_500'], ['success', undefined]]);
  });

  it('all 3 attempts fail -> false after 3 calls', async () => {
    vi.useFakeTimers();
    const audit = new CollectingAudit();
    const { fetchImpl, calls } = fetchSequence([503, 503, 503]);
    const pending = forwardIncomingPayment(record, { url: 'https://203.0.113.20/hook', secret: 's', audit, fetchImpl });
    await vi.runAllTimersAsync();
    expect(await pending).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it('fetch throwing is counted as an error attempt and retried', async () => {
    vi.useFakeTimers();
    const audit = new CollectingAudit();
    const { fetchImpl, calls } = fetchSequence([new TypeError('fetch failed'), 200]);
    const pending = forwardIncomingPayment(record, { url: 'https://203.0.113.20/hook', secret: 's', audit, fetchImpl });
    await vi.runAllTimersAsync();
    expect(await pending).toBe(true);
    expect(calls).toHaveLength(2);
    expect(audit.entries[0]).toMatchObject({ outcome: 'error', code: 'TypeError' });
  });

  // Vá audit vòng 9 (2026-09-11): trước đây forwardIncomingPayment không có
  // SSRF guard nào — 1 URL trỏ về địa chỉ nội bộ (env cấu hình sai/DNS rebind)
  // sẽ được POST payload báo có tới đó mà không ai chặn.
  it('forward URL resolving to a private IP -> rejected, fetch never called, error audited', async () => {
    const audit = new CollectingAudit();
    const { fetchImpl, calls } = fetchSequence([200]);
    await expect(
      forwardIncomingPayment(record, { url: 'https://127.0.0.1/hook', secret: 's', audit, fetchImpl }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringMatching(/SSRF/) });
    expect(calls).toHaveLength(0);
    expect(audit.entries).toEqual([expect.objectContaining({ outcome: 'error', code: 'SSRF_BLOCKED' })]);
  });

  it('non-https forward URL -> rejected even before DNS check', async () => {
    const audit = new CollectingAudit();
    const { fetchImpl, calls } = fetchSequence([200]);
    await expect(
      forwardIncomingPayment(record, { url: 'http://203.0.113.20/hook', secret: 's', audit, fetchImpl }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringMatching(/https/) });
    expect(calls).toHaveLength(0);
  });

  it('allowInsecure -> skips the SSRF guard', async () => {
    const audit = new CollectingAudit();
    const { fetchImpl, calls } = fetchSequence([200]);
    expect(
      await forwardIncomingPayment(record, { url: 'https://127.0.0.1/hook', secret: 's', audit, fetchImpl, allowInsecure: true }),
    ).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('handleIncomingPaymentWebhook', () => {
  const deps = (bank: MockBankProvider, audit = new CollectingAudit()) => ({ bank, audit, verify: OPTS });

  it('valid signature but non-JSON body -> 400 VALIDATION_ERROR', async () => {
    const raw = Buffer.from('not json');
    const res = await handleIncomingPaymentWebhook(raw, { timestamp: String(NOW_SEC), signature: sign(NOW_SEC, raw) }, deps(new MockBankProvider()));
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('provider throws a non-AppError -> 500 PROVIDER_ERROR without leaking the message', async () => {
    const bank = new MockBankProvider();
    bank.applyIncomingPayment = async () => {
      throw new Error('db down');
    };
    const raw = Buffer.from(JSON.stringify({ event_id: 'e', account_number: '123456', amount: 1 }));
    const audit = new CollectingAudit();
    const res = await handleIncomingPaymentWebhook(raw, { timestamp: String(NOW_SEC), signature: sign(NOW_SEC, raw) }, deps(bank, audit));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('db down');
    expect((res.body.error as { code: string }).code).toBe('PROVIDER_ERROR');
    expect(audit.entries.at(-1)).toMatchObject({ event: 'webhook', outcome: 'error', code: 'PROVIDER_ERROR' });
  });
});
