import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LedgerBankProvider } from '../src/bank/ledger-bank.provider.js';
import { SqliteLedgerStore } from '../src/bank/ledger-store.js';

const dir = mkdtempSync(join(process.env.SCRATCHPAD_DIR ?? tmpdir(), 'tcx-ledger-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('SqliteLedgerStore persistence', () => {
  it('wallets, transactions, idempotency and incoming events survive reopen', async () => {
    const file = join(dir, 'ledger.sqlite');
    const s1 = new SqliteLedgerStore(file);
    const p1 = new LedgerBankProvider(s1, { name: 'local', bankCode: 'TCXLOCAL' });
    const w = await p1.createWallet({ owner_ref: 'user:1', owner_name: 'Persist Me', metadata: { k: 'v' } });
    await p1.deposit({ wallet_id: w.id, amount: 100_000, description: 'nap', idempotency_key: 'dep-persist-1' });
    const t = await p1.transfer({ from_wallet_id: w.id, to_bank_code: 'VCB', to_account_number: '123456789', amount: 40_000, description: 'ck', idempotency_key: 'tr-persist-1' });
    await p1.applyIncomingPayment({ event_id: 'evt-persist', account_number: w.account_number, amount: 5_000, occurred_at: new Date().toISOString() });
    s1.close();

    const s2 = new SqliteLedgerStore(file);
    const p2 = new LedgerBankProvider(s2, { name: 'local', bankCode: 'TCXLOCAL' });
    const again = await p2.getWallet(w.id);
    expect(again?.balance).toBe(65_000);
    expect(again?.metadata).toEqual({ k: 'v' });
    const txns = await p2.listTransactions(w.id, { limit: 10 });
    expect(txns.map((x) => x.type)).toEqual(['credit', 'debit', 'credit']);
    const replay = await p2.transfer({ from_wallet_id: w.id, to_bank_code: 'VCB', to_account_number: '123456789', amount: 40_000, description: 'ck', idempotency_key: 'tr-persist-1' });
    expect(replay.transaction_id).toBe(t.transaction_id);
    expect(replay.replayed).toBe(true);
    expect((await p2.getBalance(w.id)).balance).toBe(65_000);
    const dup = await p2.applyIncomingPayment({ event_id: 'evt-persist', account_number: w.account_number, amount: 5_000, occurred_at: new Date().toISOString() });
    expect(dup.duplicate).toBe(true);
    expect((await p2.listIncomingPayments({ limit: 5 })).map((r) => r.event_id)).toEqual(['evt-persist']);
    expect((await p2.lookupAccount({ bank_code: 'TCXLOCAL', account_number: w.account_number })).account_name).toBe('Persist Me');
    s2.close();
  });

  it('rolls back the whole transfer on failure (no partial writes)', async () => {
    const s = new SqliteLedgerStore(join(dir, 'rollback.sqlite'));
    const p = new LedgerBankProvider(s);
    const w = await p.createWallet({ owner_ref: 'u', owner_name: 'R' });
    await p.deposit({ wallet_id: w.id, amount: 10, description: 'x', idempotency_key: 'd-rollback-1' });
    await expect(p.transfer({ from_wallet_id: w.id, to_bank_code: 'VCB', to_account_number: '123456', amount: 11, description: 'x', idempotency_key: 'tr-rollback-1' })).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect((await p.getBalance(w.id)).balance).toBe(10);
    expect((await p.listTransactions(w.id, { limit: 10 })).length).toBe(1);
    expect(s.getIdempotency('transfer', 'tr-rollback-1')).toBeNull();
    s.close();
  });
});
