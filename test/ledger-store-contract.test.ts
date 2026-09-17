import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MemoryLedgerStore, SqliteLedgerStore, type LedgerStore } from '../src/bank/ledger-store.js';
import type { IncomingPaymentRecord, Transaction, Wallet } from '../src/bank/types.js';

const wallet = (id: string, over: Partial<Wallet> = {}): Wallet => ({
  id,
  owner_ref: 'u1',
  owner_name: 'Owner',
  currency: 'VND',
  bank_code: 'TCXMOCK',
  account_number: `9000000000${id.slice(-2)}`,
  status: 'active',
  balance: 0,
  created_at: '2026-08-28T10:00:00.000Z',
  ...over,
});
const txn = (id: string, walletId: string, created_at: string, over: Partial<Transaction> = {}): Transaction => ({
  id,
  wallet_id: walletId,
  type: 'credit',
  amount: 1,
  fee: 0,
  balance_after: 1,
  description: 'd',
  created_at,
  ...over,
});
const incoming = (
  event_id: string,
  walletId: string | null,
  received_at: string,
  over: Partial<IncomingPaymentRecord> = {},
): IncomingPaymentRecord => ({
  event_id,
  wallet_id: walletId,
  account_number: '900000000001',
  amount: 5,
  occurred_at: received_at,
  received_at,
  applied: walletId !== null,
  transaction_id: null,
  forwarded_at: null,
  ...over,
});

// Contract test: cùng behavior trên cả 2 implementation (SQLite ':memory:' = DB nhúng, không cần socket/file).
describe.each<[string, () => LedgerStore]>([
  ['MemoryLedgerStore', () => new MemoryLedgerStore()],
  ['SqliteLedgerStore', () => new SqliteLedgerStore(':memory:')],
])('%s contract', (_name, make) => {
  it('listWallets filters by owner_ref, account_number and limit', () => {
    const s = make();
    s.insertWallet(wallet('w01', { owner_ref: 'a' }));
    s.insertWallet(wallet('w02', { owner_ref: 'a' }));
    s.insertWallet(wallet('w03', { owner_ref: 'b' }));
    expect(s.listWallets({ owner_ref: 'a', limit: 10 }).map((w) => w.id)).toEqual(['w01', 'w02']);
    expect(s.listWallets({ account_number: '900000000003', limit: 10 }).map((w) => w.id)).toEqual(['w03']);
    expect(s.listWallets({ limit: 2 })).toHaveLength(2);
    s.close();
  });

  it('listTransactions honours since, returns newest first, limit keeps newest', () => {
    const s = make();
    s.insertWallet(wallet('w01'));
    s.insertTransaction(txn('t1', 'w01', '2026-08-28T10:00:00.000Z'));
    s.insertTransaction(txn('t2', 'w01', '2026-08-28T11:00:00.000Z'));
    s.insertTransaction(txn('t3', 'w01', '2026-08-28T12:00:00.000Z'));
    expect(s.listTransactions('w01', { limit: 10, since: '2026-08-28T11:00:00.000Z' }).map((t) => t.id)).toEqual(['t3', 't2']);
    expect(s.listTransactions('w01', { limit: 2 }).map((t) => t.id)).toEqual(['t3', 't2']);
    s.close();
  });

  it('listIncomingPayments filters by wallet_id and since, newest first, limit', () => {
    const s = make();
    s.insertIncomingPayment(incoming('e1', 'w01', '2026-08-28T10:00:00.000Z'));
    s.insertIncomingPayment(incoming('e2', 'w02', '2026-08-28T11:00:00.000Z'));
    s.insertIncomingPayment(incoming('e3', 'w01', '2026-08-28T12:00:00.000Z'));
    expect(s.listIncomingPayments({ wallet_id: 'w01', limit: 10 }).map((r) => r.event_id)).toEqual(['e3', 'e1']);
    expect(s.listIncomingPayments({ since: '2026-08-28T11:00:00.000Z', limit: 10 }).map((r) => r.event_id)).toEqual(['e3', 'e2']);
    expect(s.listIncomingPayments({ limit: 1 }).map((r) => r.event_id)).toEqual(['e3']);
    s.close();
  });

  // F08 (RE-AUDIT 2026-09-17): outbox sweep dùng unforwardedOnly + markIncomingPaymentForwarded
  // để biết bản ghi nào còn nợ forward xuống backend sau khi process restart.
  it('markIncomingPaymentForwarded + unforwardedOnly filter', () => {
    const s = make();
    s.insertIncomingPayment(incoming('e1', 'w01', '2026-08-28T10:00:00.000Z'));
    s.insertIncomingPayment(incoming('e2', 'w01', '2026-08-28T11:00:00.000Z'));
    expect(s.listIncomingPayments({ limit: 10, unforwardedOnly: true }).map((r) => r.event_id).sort()).toEqual(['e1', 'e2']);

    s.markIncomingPaymentForwarded('e1', '2026-08-28T12:00:00.000Z');
    expect(s.listIncomingPayments({ limit: 10, unforwardedOnly: true }).map((r) => r.event_id)).toEqual(['e2']);
    expect(s.getIncomingPayment('e1')?.forwarded_at).toBe('2026-08-28T12:00:00.000Z');
    expect(s.getIncomingPayment('e2')?.forwarded_at).toBeNull();
    s.close();
  });

  it('idempotency: unknown -> null; set/get round-trips the result object', () => {
    const s = make();
    expect(s.getIdempotency('transfer', 'nope')).toBeNull();
    s.setIdempotency('transfer', 'k1', { fingerprint: 'fp', result: { transaction_id: 't', amount: 3, nested: { ok: true } } });
    expect(s.getIdempotency('transfer', 'k1')).toEqual({ fingerprint: 'fp', result: { transaction_id: 't', amount: 3, nested: { ok: true } } });
    s.close();
  });
});

describe('SqliteLedgerStore specifics', () => {
  it('nested transaction reuses the outer one: inner throw rolls back everything', () => {
    const s = new SqliteLedgerStore(':memory:');
    expect(() =>
      s.transaction(() => {
        s.insertWallet(wallet('w01'));
        s.transaction(() => {
          s.insertWallet(wallet('w02'));
          throw new Error('boom');
        });
      }),
    ).toThrow('boom');
    expect(s.getWallet('w01')).toBeNull();
    expect(s.getWallet('w02')).toBeNull();
    s.close();
  });

  it('duplicate account_number violates unique constraint', () => {
    const s = new SqliteLedgerStore(':memory:');
    s.insertWallet(wallet('w01', { account_number: '900000000099' }));
    expect(() => s.insertWallet(wallet('w02', { account_number: '900000000099' }))).toThrow(/UNIQUE/i);
    s.close();
  });

  it('counterparty JSON round-trips through transactions table', () => {
    const s = new SqliteLedgerStore(':memory:');
    s.insertWallet(wallet('w01'));
    s.insertTransaction(txn('t1', 'w01', '2026-08-28T10:00:00.000Z', { counterparty: { bank_code: 'VCB', account_number: '0011', name: 'X' }, reference: 'ref-1' }));
    expect(s.listTransactions('w01', { limit: 1 })[0]).toMatchObject({ counterparty: { bank_code: 'VCB', account_number: '0011', name: 'X' }, reference: 'ref-1' });
    s.close();
  });

  // F08 (RE-AUDIT 2026-09-17): file ledger.sqlite deploy TRƯỚC bản vá này
  // không có cột forwarded_at (SCHEMA cũ, `create table if not exists` là
  // no-op trên bảng đã tồn tại) — mở lại bằng SqliteLedgerStore bản mới phải
  // tự thêm cột (migrate()), không throw "no such column" khi insert/list.
  it('mở file DB cũ (thiếu cột forwarded_at) -> tự thêm cột, không throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tcx-mcp-bank-migrate-'));
    const file = join(dir, 'ledger.sqlite');

    const legacy = new DatabaseSync(file);
    legacy.exec(`
      create table incoming_payments (
        event_id text primary key,
        wallet_id text,
        bank_code text,
        account_number text not null,
        amount integer not null,
        description text,
        reference text,
        payer_name text,
        payer_account text,
        occurred_at text not null,
        received_at text not null,
        applied integer not null,
        transaction_id text
      );
    `);
    legacy.prepare(
      `insert into incoming_payments (event_id, account_number, amount, occurred_at, received_at, applied, transaction_id)
       values ('legacy-1', '900000000001', 5, '2026-08-28T10:00:00.000Z', '2026-08-28T10:00:00.000Z', 1, null)`,
    ).run();
    legacy.close();

    const s = new SqliteLedgerStore(file);
    expect(s.getIncomingPayment('legacy-1')).toMatchObject({ event_id: 'legacy-1', forwarded_at: null });
    expect(() => s.insertIncomingPayment(incoming('e1', 'w01', '2026-08-28T11:00:00.000Z'))).not.toThrow();
    expect(s.listIncomingPayments({ limit: 10, unforwardedOnly: true }).map((r) => r.event_id).sort()).toEqual(['e1', 'legacy-1']);
    s.markIncomingPaymentForwarded('legacy-1', '2026-08-28T12:00:00.000Z');
    expect(s.getIncomingPayment('legacy-1')?.forwarded_at).toBe('2026-08-28T12:00:00.000Z');
    s.close();
  });
});
