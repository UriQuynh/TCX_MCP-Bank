import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../src/auth/rate-limit.js';
import { connectClient, makePrincipal, parseResult, textOf } from './helpers.js';

describe('scope-gated tool exposure', () => {
  it('lists only tools the key has scopes for; others are not callable', async () => {
    const { client } = await connectClient(makePrincipal(['wallet:read']));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['bank_get_balance', 'bank_get_wallet', 'bank_list_wallets', 'bank_whoami']);
    const denied = await client.callTool({ name: 'bank_create_wallet', arguments: { owner_ref: 'u1', owner_name: 'Nguyen Van A' } });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/not found/i);
    const denied2 = await client.callTool({ name: 'bank_transfer', arguments: {} });
    expect(denied2.isError).toBe(true);
    expect(textOf(denied2)).toMatch(/not found/i);
  });

  it('key with no scopes sees only bank_whoami', async () => {
    const { client } = await connectClient(makePrincipal([]));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['bank_whoami']);
    const r = parseResult(await client.callTool({ name: 'bank_whoami', arguments: {} }));
    expect(r.ok).toBe(true);
    expect(r.data.scopes).toEqual([]);
  });

  it('re-checks scopes at call time (defense in depth)', async () => {
    const principal = makePrincipal(['wallet:create']);
    const { client } = await connectClient(principal);
    principal.scopes.length = 0;
    const r = parseResult(await client.callTool({ name: 'bank_create_wallet', arguments: { owner_ref: 'u1', owner_name: 'Nguyen Van A' } }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PERMISSION_DENIED');
    expect(r.error?.details?.missing_scopes).toEqual(['wallet:create']);
  });

  it('enforces per-key rate limit', async () => {
    const { client } = await connectClient(makePrincipal(['wallet:read'], 2), { rateLimiter: new MemoryRateLimiter() });
    expect(parseResult(await client.callTool({ name: 'bank_whoami', arguments: {} })).ok).toBe(true);
    expect(parseResult(await client.callTool({ name: 'bank_whoami', arguments: {} })).ok).toBe(true);
    const r = parseResult(await client.callTool({ name: 'bank_whoami', arguments: {} }));
    expect(r.error?.code).toBe('RATE_LIMITED');
  });
});

describe('wallet lifecycle on mock bank', () => {
  const FULL = ['wallet:create', 'wallet:read', 'transaction:read', 'transfer:create', 'qr:create'] as const;

  it('create -> balance -> transfer (insufficient) -> credit -> transfer -> idempotent replay -> history -> qr', async () => {
    const { client, bank } = await connectClient(makePrincipal([...FULL]), { maxTransfer: 10_000_000 });

    const created = parseResult(
      await client.callTool({ name: 'bank_create_wallet', arguments: { owner_ref: 'user:42', owner_name: 'Tram Chu Xe', metadata: { app: 'tcx' } } }),
    );
    expect(created.ok).toBe(true);
    const wallet = created.data;
    expect(wallet.account_number).toMatch(/^\d{12}$/);
    expect(wallet.balance).toBe(0);

    const bal = parseResult(await client.callTool({ name: 'bank_get_balance', arguments: { wallet_id: wallet.id } }));
    expect(bal.data.balance).toBe(0);

    const transferArgs = {
      from_wallet_id: wallet.id,
      to_bank_code: 'VCB',
      to_account_number: '0011002233',
      amount: 150_000,
      description: 'Thanh toan don TCX-1',
      idempotency_key: 'order-1-payout',
    };
    const insufficient = parseResult(await client.callTool({ name: 'bank_transfer', arguments: transferArgs }));
    expect(insufficient.error?.code).toBe('INSUFFICIENT_FUNDS');

    await bank.credit(wallet.id, 500_000);
    const t1 = parseResult(await client.callTool({ name: 'bank_transfer', arguments: transferArgs }));
    expect(t1.ok).toBe(true);
    expect(t1.data.balance_after).toBe(350_000);

    const replay = parseResult(await client.callTool({ name: 'bank_transfer', arguments: transferArgs }));
    expect(replay.data.transaction_id).toBe(t1.data.transaction_id);
    expect(replay.data.replayed).toBe(true);
    expect((await bank.getBalance(wallet.id)).balance).toBe(350_000);

    const conflict = parseResult(await client.callTool({ name: 'bank_transfer', arguments: { ...transferArgs, amount: 1 } }));
    expect(conflict.error?.code).toBe('DUPLICATE_REQUEST');

    const tooBig = parseResult(await client.callTool({ name: 'bank_transfer', arguments: { ...transferArgs, amount: 50_000_000, idempotency_key: 'big-1-xx' } }));
    expect(tooBig.error?.code).toBe('VALIDATION_ERROR');

    const hist = parseResult(await client.callTool({ name: 'bank_list_transactions', arguments: { wallet_id: wallet.id, limit: 10 } }));
    expect(hist.data.map((t: any) => t.type)).toEqual(['debit', 'credit']);

    const qr = parseResult(await client.callTool({ name: 'bank_create_payment_qr', arguments: { wallet_id: wallet.id, amount: 20_000, description: 'Nap vi' } }));
    expect(qr.ok).toBe(true);
    expect(qr.data.qr_content).toContain(wallet.account_number);

    const missing = parseResult(await client.callTool({ name: 'bank_get_wallet', arguments: { wallet_id: 'wal_nope' } }));
    expect(missing.error?.code).toBe('WALLET_NOT_FOUND');
  });

  it('rejects invalid input at the schema boundary', async () => {
    const { client } = await connectClient(makePrincipal(['transfer:create']));
    const r = await client.callTool({
      name: 'bank_transfer',
      arguments: { from_wallet_id: 'w', to_bank_code: 'vcb', to_account_number: 'abc', amount: 10.5, description: '', idempotency_key: 'x' },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/validation error/i);
  });
});

describe('deposit / freeze / close / lookup / incoming', () => {
  const SCOPES_ALL = ['wallet:create', 'wallet:read', 'transaction:read', 'transfer:create', 'deposit:create', 'wallet:manage', 'account:lookup'] as const;

  it('full management flow on ledger provider', async () => {
    const { client, bank } = await connectClient(makePrincipal([...SCOPES_ALL]));
    const w = parseResult(await client.callTool({ name: 'bank_create_wallet', arguments: { owner_ref: 'user:7', owner_name: 'Nguyen Van B' } })).data;

    const dep = parseResult(await client.callTool({ name: 'bank_deposit', arguments: { wallet_id: w.id, amount: 300_000, description: 'Nap vi', idempotency_key: 'dep-000001', source: 'escrow-order-9' } }));
    expect(dep.ok).toBe(true);
    expect(dep.data.balance_after).toBe(300_000);
    const depReplay = parseResult(await client.callTool({ name: 'bank_deposit', arguments: { wallet_id: w.id, amount: 300_000, description: 'Nap vi', idempotency_key: 'dep-000001' } }));
    expect(depReplay.data.replayed).toBe(true);
    expect((await bank.getBalance(w.id)).balance).toBe(300_000);

    const frozen = parseResult(await client.callTool({ name: 'bank_freeze_wallet', arguments: { wallet_id: w.id, action: 'freeze', reason: 'nghi ngo gian lan' } }));
    expect(frozen.data.status).toBe('frozen');
    const blocked = parseResult(await client.callTool({ name: 'bank_transfer', arguments: { from_wallet_id: w.id, to_bank_code: 'VCB', to_account_number: '0011002233', amount: 1000, description: 'x', idempotency_key: 'tr-frozen-1' } }));
    expect(blocked.error?.code).toBe('WALLET_INACTIVE');
    const depFrozen = parseResult(await client.callTool({ name: 'bank_deposit', arguments: { wallet_id: w.id, amount: 1000, description: 'van nhan', idempotency_key: 'dep-000002' } }));
    expect(depFrozen.ok).toBe(true);

    const closeFail = parseResult(await client.callTool({ name: 'bank_close_wallet', arguments: { wallet_id: w.id, reason: 'khach yeu cau' } }));
    expect(closeFail.error?.code).toBe('INVALID_STATE');

    const unfrozen = parseResult(await client.callTool({ name: 'bank_freeze_wallet', arguments: { wallet_id: w.id, action: 'unfreeze' } }));
    expect(unfrozen.data.status).toBe('active');

    const found = parseResult(await client.callTool({ name: 'bank_lookup_account', arguments: { bank_code: 'TCXMOCK', account_number: w.account_number } }));
    expect(found.data.account_name).toBe('Nguyen Van B');
    const notFound = parseResult(await client.callTool({ name: 'bank_lookup_account', arguments: { bank_code: 'VCB', account_number: '0011002233' } }));
    expect(notFound.error?.code).toBe('ACCOUNT_NOT_FOUND');

    const applied = await bank.applyIncomingPayment({ event_id: 'evt-1', account_number: w.account_number, amount: 50_000, occurred_at: new Date().toISOString(), payer_name: 'Khach A' });
    expect(applied.record.applied).toBe(true);
    expect((await bank.getBalance(w.id)).balance).toBe(351_000);
    const dup = await bank.applyIncomingPayment({ event_id: 'evt-1', account_number: w.account_number, amount: 50_000, occurred_at: new Date().toISOString() });
    expect(dup.duplicate).toBe(true);
    expect((await bank.getBalance(w.id)).balance).toBe(351_000);
    const unknownAcct = await bank.applyIncomingPayment({ event_id: 'evt-2', account_number: '999999999999', amount: 1, occurred_at: new Date().toISOString() });
    expect(unknownAcct.record.applied).toBe(false);
    expect(unknownAcct.record.wallet_id).toBeNull();

    const incoming = parseResult(await client.callTool({ name: 'bank_list_incoming_payments', arguments: { wallet_id: w.id, limit: 10 } }));
    expect(incoming.data.map((r: any) => r.event_id)).toEqual(['evt-1']);

    await client.callTool({ name: 'bank_transfer', arguments: { from_wallet_id: w.id, to_bank_code: 'VCB', to_account_number: '0011002233', amount: 351_000, description: 'rut het', idempotency_key: 'tr-drain-1' } });
    const closed = parseResult(await client.callTool({ name: 'bank_close_wallet', arguments: { wallet_id: w.id, reason: 'khach yeu cau' } }));
    expect(closed.data.status).toBe('closed');
    const reopen = parseResult(await client.callTool({ name: 'bank_freeze_wallet', arguments: { wallet_id: w.id, action: 'unfreeze' } }));
    expect(reopen.error?.code).toBe('INVALID_STATE');
  });

  it('management tools hidden without scopes', async () => {
    const { client } = await connectClient(makePrincipal(['wallet:read']));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['bank_deposit', 'bank_freeze_wallet', 'bank_close_wallet', 'bank_lookup_account', 'bank_list_incoming_payments']) expect(names).not.toContain(n);
  });
});
