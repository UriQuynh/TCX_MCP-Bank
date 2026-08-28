import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRateLimiter } from '../src/auth/rate-limit.js';
import { MockBankProvider } from '../src/bank/mock-bank.provider.js';
import { toolsForScopes } from '../src/tools/definitions.js';
import { CollectingAudit, connectClient, makePrincipal, parseResult, textOf } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

const ALL = ['wallet:create', 'wallet:read', 'transaction:read', 'transfer:create', 'qr:create', 'wallet:manage', 'deposit:create', 'account:lookup'] as const;

describe('createBankMcpServer tool metadata', () => {
  it.each([
    ['bank_transfer is destructive + idempotent, not read-only', 'bank_transfer', { readOnlyHint: false, destructiveHint: true, idempotentHint: true }],
    ['bank_get_wallet is read-only', 'bank_get_wallet', { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
    ['bank_close_wallet is destructive', 'bank_close_wallet', { readOnlyHint: false, destructiveHint: true }],
  ])('%s', async (_name, tool, expected) => {
    const { client } = await connectClient(makePrincipal([...ALL]));
    const def = (await client.listTools()).tools.find((t) => t.name === tool);
    expect(def?.annotations).toMatchObject(expected);
  });

  it('instructions list granted scopes with descriptions', async () => {
    const { client } = await connectClient(makePrincipal(['wallet:read']));
    expect(client.getInstructions()).toContain('- wallet:read: Xem thông tin ví');
  });

  it('instructions show placeholder when key has no scopes', async () => {
    const { client } = await connectClient(makePrincipal([]));
    expect(client.getInstructions()).toContain('(không có scope nào)');
  });

  it('toolsForScopes: bank_whoami always present, gated tools only with scope', () => {
    expect(toolsForScopes([]).map((t) => t.name)).toEqual(['bank_whoami']);
    expect(toolsForScopes(['wallet:read']).map((t) => t.name)).toContain('bank_get_wallet');
    expect(toolsForScopes(['wallet:read']).map((t) => t.name)).not.toContain('bank_transfer');
  });
});

describe('createBankMcpServer execution wrapper', () => {
  it('provider throws a plain Error -> generic PROVIDER_ERROR, message not leaked', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const bank = new MockBankProvider();
    bank.getWallet = async () => {
      throw new Error('db down');
    };
    const { client } = await connectClient(makePrincipal(['wallet:read']), { bank });
    const raw = await client.callTool({ name: 'bank_get_wallet', arguments: { wallet_id: 'w1' } });
    const r = parseResult(raw);
    expect(r.error).toEqual({ code: 'PROVIDER_ERROR', message: 'Lỗi nội bộ khi xử lý yêu cầu' });
    expect(textOf(raw)).not.toContain('db down');
  });

  it('successful call -> audit entry carries tool, key, session id and remote ip', async () => {
    const audit = new CollectingAudit();
    const { client } = await connectClient(makePrincipal(['wallet:read']), { audit, sessionRef: { id: 'sess-1' }, remoteIp: '1.2.3.4' });
    await client.callTool({ name: 'bank_whoami', arguments: {} });
    expect(audit.entries[0]).toMatchObject({ event: 'tool', tool: 'bank_whoami', keyId: 'abcdefabcdef', sessionId: 'sess-1', remoteIp: '1.2.3.4', outcome: 'success' });
    expect(typeof audit.entries[0]?.durationMs).toBe('number');
  });

  it.each([
    ['rate limited', { rate: 0 }, { outcome: 'denied', code: 'RATE_LIMITED' }],
    ['scope revoked mid-session', { dropScopes: true }, { outcome: 'denied', code: 'PERMISSION_DENIED' }],
    ['app error from provider', {}, { outcome: 'error', code: 'WALLET_NOT_FOUND', reason: 'Không tìm thấy ví' }],
  ])('%s -> audit %o', async (_name, setup: { rate?: number; dropScopes?: boolean }, expected) => {
    const audit = new CollectingAudit();
    const principal = makePrincipal(['wallet:read'], setup.rate ?? 1000);
    const { client } = await connectClient(principal, { audit, rateLimiter: new MemoryRateLimiter() });
    if (setup.dropScopes) principal.scopes.length = 0;
    await client.callTool({ name: 'bank_get_wallet', arguments: { wallet_id: 'wal_missing' } });
    expect(audit.entries.at(-1)).toMatchObject({ tool: 'bank_get_wallet', ...expected });
  });

  it('bank_create_wallet with more than 10 metadata keys -> VALIDATION_ERROR', async () => {
    const { client } = await connectClient(makePrincipal(['wallet:create']));
    const metadata = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']));
    const r = parseResult(await client.callTool({ name: 'bank_create_wallet', arguments: { owner_ref: 'u', owner_name: 'Name', metadata } }));
    expect(r.error?.code).toBe('VALIDATION_ERROR');
  });

  const validTransfer = { from_wallet_id: 'wal_1', to_bank_code: 'VCB', to_account_number: '0011002233', amount: 1000, description: 'ok', idempotency_key: 'order-1-payout' };
  it.each([
    ['owner_ref with spaces/punctuation', 'bank_create_wallet', { owner_ref: 'bad owner!', owner_name: 'Name' }],
    ['amount zero', 'bank_transfer', { ...validTransfer, amount: 0 }],
    ['amount negative', 'bank_transfer', { ...validTransfer, amount: -1 }],
    ['description with newline', 'bank_transfer', { ...validTransfer, description: 'a\nb' }],
    ['idempotency_key shorter than 8', 'bank_transfer', { ...validTransfer, idempotency_key: 'short' }],
    ['bank_code lowercase', 'bank_transfer', { ...validTransfer, to_bank_code: 'vcb' }],
    ['limit above 100', 'bank_list_wallets', { limit: 101 }],
    ['since not ISO-8601', 'bank_list_transactions', { wallet_id: 'wal_1', since: 'yesterday' }],
    ['expires_in_seconds below 60', 'bank_create_payment_qr', { wallet_id: 'wal_1', expires_in_seconds: 59 }],
  ])('schema rejects %s', async (_name, tool, args) => {
    const { client } = await connectClient(makePrincipal([...ALL]));
    const raw = await client.callTool({ name: tool, arguments: args });
    expect(raw.isError).toBe(true);
    expect(textOf(raw)).toMatch(/validation error/i);
  });
});
