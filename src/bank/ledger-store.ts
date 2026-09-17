import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  IncomingPaymentRecord,
  ListIncomingFilter,
  ListTransactionsOptions,
  ListWalletsFilter,
  Transaction,
  Wallet,
  WalletStatus,
} from './types.js';

export interface IdempotencyEntry {
  fingerprint: string;
  result: unknown;
}

// Kho sổ cái: mọi method đồng bộ; provider gói logic trong transaction(fn) để nguyên tử.
export interface LedgerStore {
  transaction<T>(fn: () => T): T;
  insertWallet(w: Wallet): void;
  getWallet(id: string): Wallet | null;
  findWalletByAccount(accountNumber: string): Wallet | null;
  listWallets(filter: ListWalletsFilter): Wallet[];
  updateWallet(id: string, patch: { balance?: number; status?: WalletStatus }): void;
  insertTransaction(t: Transaction): void;
  listTransactions(walletId: string, opts: ListTransactionsOptions): Transaction[];
  getIdempotency(scope: string, key: string): IdempotencyEntry | null;
  setIdempotency(scope: string, key: string, entry: IdempotencyEntry): void;
  getIncomingPayment(eventId: string): IncomingPaymentRecord | null;
  insertIncomingPayment(r: IncomingPaymentRecord): void;
  listIncomingPayments(filter: ListIncomingFilter): IncomingPaymentRecord[];
  markIncomingPaymentForwarded(eventId: string, forwardedAt: string): void;
  close(): void;
}

export class MemoryLedgerStore implements LedgerStore {
  private readonly wallets = new Map<string, Wallet>();
  private readonly txns = new Map<string, Transaction[]>();
  private readonly idem = new Map<string, IdempotencyEntry>();
  private readonly incoming = new Map<string, IncomingPaymentRecord>();

  transaction<T>(fn: () => T): T {
    return fn();
  }

  insertWallet(w: Wallet): void {
    this.wallets.set(w.id, { ...w });
    this.txns.set(w.id, []);
  }

  getWallet(id: string): Wallet | null {
    const w = this.wallets.get(id);
    return w ? { ...w } : null;
  }

  findWalletByAccount(accountNumber: string): Wallet | null {
    for (const w of this.wallets.values()) if (w.account_number === accountNumber) return { ...w };
    return null;
  }

  listWallets(filter: ListWalletsFilter): Wallet[] {
    return [...this.wallets.values()]
      .filter((w) => !filter.owner_ref || w.owner_ref === filter.owner_ref)
      .filter((w) => !filter.account_number || w.account_number === filter.account_number)
      .slice(0, filter.limit)
      .map((w) => ({ ...w }));
  }

  updateWallet(id: string, patch: { balance?: number; status?: WalletStatus }): void {
    const w = this.wallets.get(id);
    if (!w) return;
    if (patch.balance !== undefined) w.balance = patch.balance;
    if (patch.status !== undefined) w.status = patch.status;
  }

  insertTransaction(t: Transaction): void {
    this.txns.get(t.wallet_id)?.push({ ...t });
  }

  listTransactions(walletId: string, opts: ListTransactionsOptions): Transaction[] {
    const since = opts.since ? new Date(opts.since).getTime() : -Infinity;
    return (this.txns.get(walletId) ?? [])
      .filter((t) => new Date(t.created_at).getTime() >= since)
      .slice(-opts.limit)
      .reverse()
      .map((t) => ({ ...t }));
  }

  getIdempotency(scope: string, key: string): IdempotencyEntry | null {
    return this.idem.get(`${scope}:${key}`) ?? null;
  }

  setIdempotency(scope: string, key: string, entry: IdempotencyEntry): void {
    this.idem.set(`${scope}:${key}`, entry);
  }

  getIncomingPayment(eventId: string): IncomingPaymentRecord | null {
    const r = this.incoming.get(eventId);
    return r ? { ...r } : null;
  }

  insertIncomingPayment(r: IncomingPaymentRecord): void {
    this.incoming.set(r.event_id, { ...r });
  }

  listIncomingPayments(filter: ListIncomingFilter): IncomingPaymentRecord[] {
    const since = filter.since ? new Date(filter.since).getTime() : -Infinity;
    return [...this.incoming.values()]
      .filter((r) => !filter.wallet_id || r.wallet_id === filter.wallet_id)
      .filter((r) => new Date(r.received_at).getTime() >= since)
      .filter((r) => !filter.unforwardedOnly || r.forwarded_at === null)
      .sort((a, b) => (a.received_at < b.received_at ? 1 : -1))
      .slice(0, filter.limit)
      .map((r) => ({ ...r }));
  }

  markIncomingPaymentForwarded(eventId: string, forwardedAt: string): void {
    const r = this.incoming.get(eventId);
    if (r) r.forwarded_at = forwardedAt;
  }

  close(): void {
    /* no-op */
  }
}

const SCHEMA = `
create table if not exists wallets (
  id text primary key,
  owner_ref text not null,
  owner_name text not null,
  currency text not null default 'VND',
  bank_code text not null,
  account_number text not null unique,
  status text not null,
  balance integer not null default 0,
  metadata text,
  created_at text not null
);
create index if not exists idx_wallets_owner on wallets(owner_ref);
create table if not exists transactions (
  id text primary key,
  wallet_id text not null references wallets(id),
  type text not null,
  amount integer not null,
  fee integer not null default 0,
  balance_after integer not null,
  counterparty text,
  description text not null,
  reference text,
  created_at text not null
);
create index if not exists idx_txn_wallet_created on transactions(wallet_id, created_at);
create table if not exists idempotency (
  scope text not null,
  key text not null,
  fingerprint text not null,
  result text not null,
  created_at text not null,
  primary key (scope, key)
);
create table if not exists incoming_payments (
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
  transaction_id text,
  forwarded_at text
);
create index if not exists idx_incoming_wallet_received on incoming_payments(wallet_id, received_at);
`;

type Row = Record<string, unknown>;

// SQLite qua node:sqlite (built-in Node >= 22.13, không cần native build). WAL + BEGIN IMMEDIATE cho ghi nguyên tử.
export class SqliteLedgerStore implements LedgerStore {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    this.db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  // `create table if not exists` không thêm cột mới vào bảng đã tồn tại từ
  // trước khi cột đó được đưa vào SCHEMA — file ledger.sqlite deploy trước
  // F08 (RE-AUDIT 2026-09-17) sẽ thiếu `forwarded_at`. Kiểm bằng
  // `pragma table_info` rồi `alter table` nếu còn thiếu, idempotent mỗi lần
  // khởi động (không cần bảng version riêng cho đúng 1 cột).
  private migrate(): void {
    const cols = this.db.prepare('pragma table_info(incoming_payments)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'forwarded_at')) {
      this.db.exec('alter table incoming_payments add column forwarded_at text');
    }
    // Partial index tách khỏi SCHEMA: chỉ tạo được SAU khi cột forwarded_at
    // chắc chắn tồn tại (fresh install lẫn upgrade từ DB cũ ở nhánh trên).
    this.db.exec('create index if not exists idx_incoming_unforwarded on incoming_payments(received_at) where forwarded_at is null');
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('begin immediate');
    this.depth++;
    try {
      const r = fn();
      this.db.exec('commit');
      return r;
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    } finally {
      this.depth--;
    }
  }

  insertWallet(w: Wallet): void {
    this.db
      .prepare(
        `insert into wallets (id, owner_ref, owner_name, currency, bank_code, account_number, status, balance, metadata, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(w.id, w.owner_ref, w.owner_name, w.currency, w.bank_code, w.account_number, w.status, w.balance, w.metadata ? JSON.stringify(w.metadata) : null, w.created_at);
  }

  getWallet(id: string): Wallet | null {
    const row = this.db.prepare('select * from wallets where id = ?').get(id) as Row | undefined;
    return row ? this.rowToWallet(row) : null;
  }

  findWalletByAccount(accountNumber: string): Wallet | null {
    const row = this.db.prepare('select * from wallets where account_number = ?').get(accountNumber) as Row | undefined;
    return row ? this.rowToWallet(row) : null;
  }

  listWallets(filter: ListWalletsFilter): Wallet[] {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (filter.owner_ref) {
      conds.push('owner_ref = ?');
      args.push(filter.owner_ref);
    }
    if (filter.account_number) {
      conds.push('account_number = ?');
      args.push(filter.account_number);
    }
    const where = conds.length ? `where ${conds.join(' and ')}` : '';
    const rows = this.db.prepare(`select * from wallets ${where} order by created_at limit ?`).all(...(args as never[]), filter.limit) as Row[];
    return rows.map((r) => this.rowToWallet(r));
  }

  updateWallet(id: string, patch: { balance?: number; status?: WalletStatus }): void {
    if (patch.balance !== undefined) this.db.prepare('update wallets set balance = ? where id = ?').run(patch.balance, id);
    if (patch.status !== undefined) this.db.prepare('update wallets set status = ? where id = ?').run(patch.status, id);
  }

  insertTransaction(t: Transaction): void {
    this.db
      .prepare(
        `insert into transactions (id, wallet_id, type, amount, fee, balance_after, counterparty, description, reference, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.wallet_id, t.type, t.amount, t.fee, t.balance_after, t.counterparty ? JSON.stringify(t.counterparty) : null, t.description, t.reference ?? null, t.created_at);
  }

  listTransactions(walletId: string, opts: ListTransactionsOptions): Transaction[] {
    const rows = (
      opts.since
        ? this.db.prepare('select * from transactions where wallet_id = ? and created_at >= ? order by created_at desc, rowid desc limit ?').all(walletId, opts.since, opts.limit)
        : this.db.prepare('select * from transactions where wallet_id = ? order by created_at desc, rowid desc limit ?').all(walletId, opts.limit)
    ) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      wallet_id: String(r.wallet_id),
      type: r.type === 'credit' ? 'credit' : 'debit',
      amount: Number(r.amount),
      fee: Number(r.fee),
      balance_after: Number(r.balance_after),
      description: String(r.description),
      created_at: String(r.created_at),
      ...(r.reference ? { reference: String(r.reference) } : {}),
      ...(r.counterparty ? { counterparty: JSON.parse(String(r.counterparty)) as Transaction['counterparty'] } : {}),
    }));
  }

  getIdempotency(scope: string, key: string): IdempotencyEntry | null {
    const row = this.db.prepare('select fingerprint, result from idempotency where scope = ? and key = ?').get(scope, key) as Row | undefined;
    return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) } : null;
  }

  setIdempotency(scope: string, key: string, entry: IdempotencyEntry): void {
    this.db
      .prepare('insert into idempotency (scope, key, fingerprint, result, created_at) values (?, ?, ?, ?, ?)')
      .run(scope, key, entry.fingerprint, JSON.stringify(entry.result), new Date().toISOString());
  }

  getIncomingPayment(eventId: string): IncomingPaymentRecord | null {
    const row = this.db.prepare('select * from incoming_payments where event_id = ?').get(eventId) as Row | undefined;
    return row ? this.rowToIncoming(row) : null;
  }

  insertIncomingPayment(r: IncomingPaymentRecord): void {
    this.db
      .prepare(
        `insert into incoming_payments (event_id, wallet_id, bank_code, account_number, amount, description, reference, payer_name, payer_account, occurred_at, received_at, applied, transaction_id, forwarded_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.event_id,
        r.wallet_id,
        r.bank_code ?? null,
        r.account_number,
        r.amount,
        r.description ?? null,
        r.reference ?? null,
        r.payer_name ?? null,
        r.payer_account ?? null,
        r.occurred_at,
        r.received_at,
        r.applied ? 1 : 0,
        r.transaction_id,
        r.forwarded_at ?? null,
      );
  }

  listIncomingPayments(filter: ListIncomingFilter): IncomingPaymentRecord[] {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (filter.wallet_id) {
      conds.push('wallet_id = ?');
      args.push(filter.wallet_id);
    }
    if (filter.since) {
      conds.push('received_at >= ?');
      args.push(filter.since);
    }
    if (filter.unforwardedOnly) {
      conds.push('forwarded_at is null');
    }
    const where = conds.length ? `where ${conds.join(' and ')}` : '';
    const rows = this.db.prepare(`select * from incoming_payments ${where} order by received_at desc limit ?`).all(...(args as never[]), filter.limit) as Row[];
    return rows.map((r) => this.rowToIncoming(r));
  }

  markIncomingPaymentForwarded(eventId: string, forwardedAt: string): void {
    this.db.prepare('update incoming_payments set forwarded_at = ? where event_id = ?').run(forwardedAt, eventId);
  }

  close(): void {
    this.db.close();
  }

  private rowToWallet(r: Row): Wallet {
    return {
      id: String(r.id),
      owner_ref: String(r.owner_ref),
      owner_name: String(r.owner_name),
      currency: 'VND',
      bank_code: String(r.bank_code),
      account_number: String(r.account_number),
      status: r.status as WalletStatus,
      balance: Number(r.balance),
      created_at: String(r.created_at),
      ...(r.metadata ? { metadata: JSON.parse(String(r.metadata)) as Record<string, string> } : {}),
    };
  }

  private rowToIncoming(r: Row): IncomingPaymentRecord {
    return {
      event_id: String(r.event_id),
      wallet_id: r.wallet_id == null ? null : String(r.wallet_id),
      account_number: String(r.account_number),
      amount: Number(r.amount),
      occurred_at: String(r.occurred_at),
      received_at: String(r.received_at),
      applied: Number(r.applied) === 1,
      transaction_id: r.transaction_id == null ? null : String(r.transaction_id),
      forwarded_at: r.forwarded_at == null ? null : String(r.forwarded_at),
      ...(r.bank_code ? { bank_code: String(r.bank_code) } : {}),
      ...(r.description ? { description: String(r.description) } : {}),
      ...(r.reference ? { reference: String(r.reference) } : {}),
      ...(r.payer_name ? { payer_name: String(r.payer_name) } : {}),
      ...(r.payer_account ? { payer_account: String(r.payer_account) } : {}),
    };
  }
}
