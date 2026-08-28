import { describe, expect, it } from 'vitest';
import { MockBankProvider } from '../src/bank/mock-bank.provider.js';
import { AppError } from '../src/errors.js';

const T0 = new Date('2026-08-28T10:00:00.000Z');

function catchSync(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected throw');
}

async function walletWith(bank: MockBankProvider, owner = 'u1', name = 'Owner') {
  return bank.createWallet({ owner_ref: owner, owner_name: name });
}

describe('LedgerBankProvider.listWallets', () => {
  it.each([
    ['owner_ref filter', { owner_ref: 'a', limit: 10 }, 2],
    ['limit', { limit: 1 }, 1],
  ])('%s', async (_name, filter, expectedCount) => {
    const bank = new MockBankProvider(() => T0);
    await walletWith(bank, 'a');
    await walletWith(bank, 'a');
    await walletWith(bank, 'b');
    expect(await bank.listWallets(filter)).toHaveLength(expectedCount);
  });

  it('account_number filter returns exactly that wallet', async () => {
    const bank = new MockBankProvider(() => T0);
    const w = await walletWith(bank, 'a');
    await walletWith(bank, 'a');
    expect((await bank.listWallets({ account_number: w.account_number, limit: 10 })).map((x) => x.id)).toEqual([w.id]);
  });
});

describe('LedgerBankProvider.listTransactions', () => {
  it('since excludes older entries, newest first, limit keeps the newest', async () => {
    let t = new Date('2026-08-28T10:00:00.000Z');
    const bank = new MockBankProvider(() => t);
    const w = await walletWith(bank);
    const d1 = await bank.deposit({ wallet_id: w.id, amount: 1, description: 'd1', idempotency_key: 'dep-list-1' });
    t = new Date('2026-08-28T11:00:00.000Z');
    const d2 = await bank.deposit({ wallet_id: w.id, amount: 2, description: 'd2', idempotency_key: 'dep-list-2' });
    t = new Date('2026-08-28T12:00:00.000Z');
    const d3 = await bank.deposit({ wallet_id: w.id, amount: 3, description: 'd3', idempotency_key: 'dep-list-3' });

    const since = await bank.listTransactions(w.id, { limit: 10, since: '2026-08-28T11:00:00.000Z' });
    expect(since.map((x) => x.id)).toEqual([d3.transaction_id, d2.transaction_id]);
    const limited = await bank.listTransactions(w.id, { limit: 1 });
    expect(limited.map((x) => x.id)).toEqual([d3.transaction_id]);
    expect(d1.transaction_id).not.toBe(d2.transaction_id);
  });
});

describe('LedgerBankProvider.setWalletStatus', () => {
  it('same status -> no-op, returns wallet unchanged', async () => {
    const bank = new MockBankProvider(() => T0);
    const w = await walletWith(bank);
    expect((await bank.setWalletStatus(w.id, 'active')).status).toBe('active');
  });

  it.each([
    ['frozen -> closed with zero balance is allowed', ['frozen', 'closed'], null],
    ['closed -> active is rejected', ['closed', 'active'], 'INVALID_STATE'],
    ['closed -> frozen is rejected', ['closed', 'frozen'], 'INVALID_STATE'],
  ])('%s', async (_name, [first, second], expectedCode) => {
    const bank = new MockBankProvider(() => T0);
    const w = await walletWith(bank);
    await bank.setWalletStatus(w.id, first as 'frozen' | 'closed');
    const attempt = bank.setWalletStatus(w.id, second as 'active' | 'frozen' | 'closed');
    if (expectedCode) await expect(attempt).rejects.toMatchObject({ code: expectedCode });
    else expect((await attempt).status).toBe(second);
  });
});

describe('LedgerBankProvider.deposit', () => {
  it('same idempotency_key with different amount -> DUPLICATE_REQUEST, balance untouched', async () => {
    const bank = new MockBankProvider(() => T0);
    const w = await walletWith(bank);
    await bank.deposit({ wallet_id: w.id, amount: 100, description: 'x', idempotency_key: 'dep-conflict-1' });
    await expect(bank.deposit({ wallet_id: w.id, amount: 200, description: 'x', idempotency_key: 'dep-conflict-1' })).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
    expect((await bank.getBalance(w.id)).balance).toBe(100);
  });

  it('closed wallet -> WALLET_INACTIVE', async () => {
    const bank = new MockBankProvider(() => T0);
    const w = await walletWith(bank);
    await bank.setWalletStatus(w.id, 'closed');
    await expect(bank.deposit({ wallet_id: w.id, amount: 1, description: 'x', idempotency_key: 'dep-closed-1' })).rejects.toMatchObject({ code: 'WALLET_INACTIVE' });
  });
});

describe('LedgerBankProvider.lookupAccount', () => {
  it('closed wallet -> ACCOUNT_NOT_FOUND', async () => {
    const bank = new MockBankProvider(() => T0);
    const w = await walletWith(bank);
    await bank.setWalletStatus(w.id, 'closed');
    await expect(bank.lookupAccount({ bank_code: 'TCXMOCK', account_number: w.account_number })).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });
});

describe('LedgerBankProvider.applyIncomingPayment', () => {
  it('bank_code mismatch -> recorded with wallet_id but not applied', async () => {
    const bank = new MockBankProvider(() => T0);
    const w = await walletWith(bank);
    const { record } = await bank.applyIncomingPayment({ event_id: 'evt-bc', bank_code: 'VCB', account_number: w.account_number, amount: 10, occurred_at: T0.toISOString() });
    expect(record).toMatchObject({ wallet_id: w.id, applied: false, transaction_id: null });
    expect((await bank.getBalance(w.id)).balance).toBe(0);
  });

  it('closed wallet -> recorded, not applied', async () => {
    const bank = new MockBankProvider(() => T0);
    const w = await walletWith(bank);
    await bank.setWalletStatus(w.id, 'closed');
    const { record } = await bank.applyIncomingPayment({ event_id: 'evt-closed', account_number: w.account_number, amount: 10, occurred_at: T0.toISOString() });
    expect(record.applied).toBe(false);
    expect((await bank.listIncomingPayments({ limit: 5 })).map((r) => r.event_id)).toEqual(['evt-closed']);
  });
});

describe('LedgerBankProvider.createPaymentQr', () => {
  it('closed wallet -> WALLET_INACTIVE', async () => {
    const bank = new MockBankProvider(() => T0);
    const w = await walletWith(bank);
    await bank.setWalletStatus(w.id, 'closed');
    await expect(bank.createPaymentQr({ wallet_id: w.id })).rejects.toMatchObject({ code: 'WALLET_INACTIVE' });
  });

  it('expires_in_seconds -> expires_at computed from injected clock', async () => {
    const bank = new MockBankProvider(() => T0);
    const w = await walletWith(bank);
    const qr = await bank.createPaymentQr({ wallet_id: w.id, expires_in_seconds: 600 });
    expect(qr.expires_at).toBe('2026-08-28T10:10:00.000Z');
  });
});

describe('LedgerBankProvider.parseIncomingPayment', () => {
  it('missing occurred_at -> filled from injected clock', () => {
    const bank = new MockBankProvider(() => T0);
    expect(bank.parseIncomingPayment({ event_id: 'e', account_number: '123456', amount: 1 }).occurred_at).toBe('2026-08-28T10:00:00.000Z');
  });

  it('invalid payload -> VALIDATION_ERROR listing offending fields', () => {
    const bank = new MockBankProvider(() => T0);
    const err = catchSync(() => bank.parseIncomingPayment({ amount: -1 }));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect((err.details?.issues as string[]).join('\n')).toMatch(/account_number/);
  });
});

describe('LedgerBankProvider misc guards', () => {
  it.each([[0], [-5], [1.5]])('credit(amount=%s) -> VALIDATION_ERROR', async (amount) => {
    const bank = new MockBankProvider(() => T0);
    const w = await walletWith(bank);
    await expect(bank.credit(w.id, amount)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('transfer from unknown wallet -> WALLET_NOT_FOUND', async () => {
    const bank = new MockBankProvider(() => T0);
    await expect(bank.transfer({ from_wallet_id: 'wal_nope', to_bank_code: 'VCB', to_account_number: '123456', amount: 1, description: 'x', idempotency_key: 'tr-nope-1' })).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });
});
