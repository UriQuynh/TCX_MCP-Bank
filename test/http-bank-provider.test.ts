import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBankProvider, isPrivateIp, type HttpBankProviderOptions } from '../src/bank/http-bank.provider.js';
import { MemoryLedgerStore } from '../src/bank/ledger-store.js';
import { AppError } from '../src/errors.js';

// fetchImpl là seam do ta sở hữu (không mock undici/global fetch) -> fake trả Response thật.
type Reply = { status?: number; body?: unknown } | Response;
function fakeFetch(handler: (url: URL, init: RequestInit) => Reply = () => ({ body: {} })) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const r = handler(url, init ?? {});
    if (r instanceof Response) return r;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const PUBLIC_BASE = 'https://203.0.113.10/api/';
function make(over: Partial<HttpBankProviderOptions> = {}, handler?: (url: URL, init: RequestInit) => Reply) {
  const f = fakeFetch(handler);
  const p = new HttpBankProvider({ baseUrl: PUBLIC_BASE, apiKey: 'key', timeoutMs: 1000, incomingStore: new MemoryLedgerStore(), fetchImpl: f.fetchImpl, ...over });
  return { p, ...f };
}
const headersOf = (init: RequestInit) => init.headers as Record<string, string>;
const WALLET = { id: 'w1', owner_ref: 'u', owner_name: 'N', bank_code: 'VCB', account_number: '0011002233', status: 'active', balance: 5, created_at: '2026-08-28T00:00:00.000Z' };

afterEach(() => vi.useRealTimers());

describe('HttpBankProvider construction & SSRF guard', () => {
  it('http:// base without allowInsecure -> throws; with allowInsecure -> ok', () => {
    expect(() => make({ baseUrl: 'http://bank.example/' })).toThrow(/https/);
    expect(() => make({ baseUrl: 'http://bank.example/', allowInsecure: true })).not.toThrow();
  });

  it('base URL on a private IP -> PROVIDER_ERROR (SSRF) and fetch never called', async () => {
    const { p, calls } = make({ baseUrl: 'https://127.0.0.1/' });
    await expect(p.getBalance('w1')).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringMatching(/SSRF/) });
    expect(calls).toHaveLength(0);
  });

  it('allowInsecure skips the private-IP check', async () => {
    const { p, calls } = make({ baseUrl: 'http://127.0.0.1/', allowInsecure: true }, () => ({ body: { balance: 1 } }));
    await p.getBalance('w1');
    expect(calls).toHaveLength(1);
  });
});

describe('HttpBankProvider request signing & headers', () => {
  it('with apiSecret -> X-Timestamp + HMAC X-Signature over "ts.METHOD.path.body"', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { p, calls } = make({ apiSecret: 's' }, () => ({ body: WALLET }));
    await p.getWallet('w1');
    const h = headersOf(calls[0]!.init);
    expect(calls[0]!.url.pathname).toBe('/api/wallets/w1');
    expect(h['X-Timestamp']).toBe('1700000000');
    expect(h['X-Signature']).toBe('e82e160efddc69dc0aa3f7e6e0972b06c672a63e93404513d55e3703262eb37a');
  });

  it('without apiSecret -> no signature; Bearer + Accept headers set; no redirects followed', async () => {
    const { p, calls } = make({}, () => ({ body: WALLET }));
    await p.getWallet('w1');
    const { init } = calls[0]!;
    const h = headersOf(init);
    expect(h['X-Signature']).toBeUndefined();
    expect(h.Authorization).toBe('Bearer key');
    expect(h.Accept).toBe('application/json');
    expect(init.redirect).toBe('error');
  });

  it.each([
    ['transfer', (p: HttpBankProvider) => p.transfer({ from_wallet_id: 'w1', to_bank_code: 'VCB', to_account_number: '0011002233', amount: 1000, description: 'x', idempotency_key: 'idem-transfer-1' }), '/api/transfers', 'idem-transfer-1'],
    ['deposit', (p: HttpBankProvider) => p.deposit({ wallet_id: 'w1', amount: 500, description: 'x', idempotency_key: 'idem-deposit-1' }), '/api/wallets/w1/deposits', 'idem-deposit-1'],
  ])('%s sends Idempotency-Key header and omits it from the body', async (_name, call, path, key) => {
    const { p, calls } = make({}, () => ({ body: { transaction_id: 't', status: 'completed', amount: 1, fee: 0, balance_after: 1, created_at: 'x' } }));
    await call(p);
    const { url, init } = calls[0]!;
    expect(url.pathname).toBe(path);
    expect(init.method).toBe('POST');
    expect(headersOf(init)['Idempotency-Key']).toBe(key);
    expect(JSON.parse(String(init.body))).not.toHaveProperty('idempotency_key');
  });
});

describe('HttpBankProvider error mapping', () => {
  it.each([
    ['404', 404, {}, 'WALLET_NOT_FOUND'],
    ['409', 409, {}, 'DUPLICATE_REQUEST'],
    ['402', 402, {}, 'INSUFFICIENT_FUNDS'],
    ['422 with code INSUFFICIENT_BALANCE', 422, { code: 'INSUFFICIENT_BALANCE' }, 'INSUFFICIENT_FUNDS'],
    ['400 with message', 400, { message: 'bad amount' }, 'VALIDATION_ERROR'],
    ['503', 503, {}, 'PROVIDER_ERROR'],
  ])('HTTP %s -> %s', async (_name, status, body, code) => {
    const { p } = make({}, () => ({ status, body }));
    await expect(p.getBalance('w1')).rejects.toMatchObject({ code });
  });

  it('400 surfaces the provider message', async () => {
    const { p } = make({}, () => ({ status: 400, body: { message: 'bad amount' } }));
    await expect(p.getBalance('w1')).rejects.toMatchObject({ message: 'bad amount' });
  });

  it('getWallet on 404 -> null (not an error)', async () => {
    const { p } = make({}, () => ({ status: 404, body: {} }));
    expect(await p.getWallet('w1')).toBeNull();
  });

  it('fetch rejects -> PROVIDER_ERROR naming the error type', async () => {
    const { p } = make({}, () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    await expect(p.getBalance('w1')).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringMatching(/TimeoutError/) });
  });

  it('healthCheck: non-2xx -> ok:false with detail', async () => {
    const { p } = make({}, () => ({ status: 500, body: {} }));
    expect(await p.healthCheck()).toMatchObject({ ok: false, detail: expect.stringMatching(/500/) });
  });
});

describe('HttpBankProvider response mapping', () => {
  it.each([
    ['bare array', [WALLET]],
    ['{wallets: [...]}', { wallets: [WALLET] }],
    ['{data: [...]}', { data: [WALLET] }],
  ])('listWallets accepts %s', async (_name, body) => {
    const { p } = make({}, () => ({ body }));
    expect((await p.listWallets({ limit: 5 })).map((w) => w.id)).toEqual(['w1']);
  });

  it('listWallets without an array -> PROVIDER_ERROR', async () => {
    const { p } = make({}, () => ({ body: { nope: true } }));
    await expect(p.listWallets({ limit: 5 })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it.each([
    ['missing id -> PROVIDER_ERROR', { ...WALLET, id: undefined }, null],
    ['string balance coerced to int', { ...WALLET, balance: '1000' }, { balance: 1000 }],
    ['non-numeric balance -> PROVIDER_ERROR', { ...WALLET, balance: 'x' }, null],
    ['unknown status falls back to active', { ...WALLET, status: 'weird' }, { status: 'active' }],
  ])('mapWallet: %s', async (_name, body, expected) => {
    const { p } = make({}, () => ({ body }));
    if (expected) expect(await p.getWallet('w1')).toMatchObject(expected);
    else await expect(p.getWallet('w1')).rejects.toBeInstanceOf(AppError);
  });

  it('lookupAccount: 404 -> ACCOUNT_NOT_FOUND; 200 without account_name -> PROVIDER_ERROR', async () => {
    const notFound = make({}, () => ({ status: 404, body: {} })).p;
    await expect(notFound.lookupAccount({ bank_code: 'VCB', account_number: '0011002233' })).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    const empty = make({}, () => ({ body: {} })).p;
    await expect(empty.lookupAccount({ bank_code: 'VCB', account_number: '0011002233' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('setWalletStatus posts status + reason and maps the returned wallet', async () => {
    const { p, calls } = make({}, () => ({ body: { ...WALLET, status: 'frozen' } }));
    const w = await p.setWalletStatus('w1', 'frozen', 'suspicious');
    expect(calls[0]!.url.pathname).toBe('/api/wallets/w1/status');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ status: 'frozen', reason: 'suspicious' });
    expect(w.status).toBe('frozen');
  });
});

describe('HttpBankProvider.applyIncomingPayment', () => {
  const payment = { event_id: 'evt-http-1', account_number: '0011002233', amount: 10, reference: 'FT1', occurred_at: '2026-08-28T00:00:00.000Z' };

  it('resolves wallet_id via GET /wallets?account_number= and records as applied', async () => {
    const { p, calls } = make({}, () => ({ body: [{ ...WALLET, id: 'wal_9' }] }));
    const r = await p.applyIncomingPayment(payment);
    expect(calls[0]!.url.searchParams.get('account_number')).toBe('0011002233');
    expect(r.duplicate).toBe(false);
    expect(r.record).toMatchObject({ wallet_id: 'wal_9', applied: true, transaction_id: 'FT1' });
  });

  it('wallet lookup failing -> still recorded with wallet_id null', async () => {
    const { p } = make({}, () => ({ status: 500, body: {} }));
    const r = await p.applyIncomingPayment(payment);
    expect(r.record.wallet_id).toBeNull();
    expect(r.record.applied).toBe(true);
  });

  it('same event_id twice -> duplicate:true returning the stored record', async () => {
    const { p, calls } = make({}, () => ({ body: [] }));
    const first = await p.applyIncomingPayment(payment);
    const second = await p.applyIncomingPayment(payment);
    expect(second.duplicate).toBe(true);
    expect(second.record.received_at).toBe(first.record.received_at);
    expect(calls).toHaveLength(1);
  });
});

describe('isPrivateIp', () => {
  it.each([
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['::1', true],
    ['fd12::1', true],
    ['fe80::1', true],
    ['::ffff:10.0.0.1', true],
    ['2606:4700::1111', false],
    ['not-an-ip', true],
  ])('%s -> %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});
