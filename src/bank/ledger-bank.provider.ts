import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { incomingPaymentSchema } from './incoming-payment.schema.js';
import type { LedgerStore } from './ledger-store.js';
import type {
  ApplyIncomingResult,
  BalanceResult,
  BankProvider,
  CreateWalletInput,
  DepositRequest,
  DepositResult,
  IncomingPayment,
  IncomingPaymentRecord,
  ListIncomingFilter,
  ListTransactionsOptions,
  ListWalletsFilter,
  LookupAccountRequest,
  LookupAccountResult,
  PaymentQrRequest,
  PaymentQrResult,
  Transaction,
  TransferRequest,
  TransferResult,
  Wallet,
  WalletStatus,
} from './types.js';

export interface LedgerBankProviderOptions {
  name?: string;
  bankCode?: string;
  now?: () => Date;
}

const ALLOWED_TRANSITIONS: Record<WalletStatus, WalletStatus[]> = {
  active: ['frozen', 'closed'],
  frozen: ['active', 'closed'],
  closed: [],
};

// Sổ cái nội bộ: ví/giao dịch do chính server quản lý (memory hoặc SQLite). Dùng cho dev/test
// hoặc khi TCX tự giữ sổ phụ trước khi nối ngân hàng thật.
export class LedgerBankProvider implements BankProvider {
  readonly name: string;
  readonly bankCode: string;
  private readonly now: () => Date;

  constructor(
    protected readonly store: LedgerStore,
    opts: LedgerBankProviderOptions = {},
  ) {
    this.name = opts.name ?? 'ledger';
    this.bankCode = opts.bankCode ?? 'TCXMOCK';
    this.now = opts.now ?? (() => new Date());
  }

  async createWallet(input: CreateWalletInput): Promise<Wallet> {
    return this.store.transaction(() => {
      let account = this.genAccountNumber();
      while (this.store.findWalletByAccount(account)) account = this.genAccountNumber();
      const wallet: Wallet = {
        id: `wal_${randomBytes(8).toString('hex')}`,
        owner_ref: input.owner_ref,
        owner_name: input.owner_name,
        currency: 'VND',
        bank_code: this.bankCode,
        account_number: account,
        status: 'active',
        balance: 0,
        created_at: this.now().toISOString(),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      this.store.insertWallet(wallet);
      return wallet;
    });
  }

  async getWallet(id: string): Promise<Wallet | null> {
    return this.store.getWallet(id);
  }

  async listWallets(filter: ListWalletsFilter): Promise<Wallet[]> {
    return this.store.listWallets(filter);
  }

  async getBalance(id: string): Promise<BalanceResult> {
    const w = this.mustGet(id);
    return { wallet_id: w.id, balance: w.balance, currency: 'VND', as_of: this.now().toISOString() };
  }

  async listTransactions(id: string, opts: ListTransactionsOptions): Promise<Transaction[]> {
    this.mustGet(id);
    return this.store.listTransactions(id, opts);
  }

  async transfer(req: TransferRequest): Promise<TransferResult> {
    const fingerprint = fp([req.from_wallet_id, req.to_bank_code, req.to_account_number, req.amount, req.description]);
    return this.store.transaction(() => {
      const prior = this.store.getIdempotency('transfer', req.idempotency_key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw dupKey(req.idempotency_key);
        return { ...(prior.result as TransferResult), replayed: true };
      }
      const w = this.mustGet(req.from_wallet_id);
      if (w.status !== 'active') throw new AppError('WALLET_INACTIVE', `Ví đang ở trạng thái ${w.status}, không thể chuyển tiền`);
      const fee = 0;
      if (w.balance < req.amount + fee) {
        throw new AppError('INSUFFICIENT_FUNDS', 'Số dư không đủ', { balance: w.balance, required: req.amount + fee });
      }
      const balanceAfter = w.balance - req.amount - fee;
      const txn = this.post(w.id, {
        type: 'debit',
        amount: req.amount,
        fee,
        balance_after: balanceAfter,
        counterparty: {
          bank_code: req.to_bank_code,
          account_number: req.to_account_number,
          ...(req.to_account_name ? { name: req.to_account_name } : {}),
        },
        description: req.description,
        reference: req.idempotency_key,
      });
      const result: TransferResult = {
        transaction_id: txn.id,
        status: 'completed',
        amount: txn.amount,
        fee,
        balance_after: balanceAfter,
        created_at: txn.created_at,
      };
      this.store.setIdempotency('transfer', req.idempotency_key, { fingerprint, result });
      return result;
    });
  }

  async deposit(req: DepositRequest): Promise<DepositResult> {
    const fingerprint = fp([req.wallet_id, req.amount, req.description]);
    return this.store.transaction(() => {
      const prior = this.store.getIdempotency('deposit', req.idempotency_key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw dupKey(req.idempotency_key);
        return { ...(prior.result as DepositResult), replayed: true };
      }
      const w = this.mustGet(req.wallet_id);
      // Ví đóng băng vẫn nhận tiền vào (chỉ khoá chiều ra); ví đã đóng thì không.
      if (w.status === 'closed') throw new AppError('WALLET_INACTIVE', 'Ví đã đóng, không thể nạp tiền');
      const balanceAfter = w.balance + req.amount;
      const txn = this.post(w.id, {
        type: 'credit',
        amount: req.amount,
        fee: 0,
        balance_after: balanceAfter,
        description: req.description,
        reference: req.idempotency_key,
        ...(req.source ? { counterparty: { name: req.source } } : {}),
      });
      const result: DepositResult = {
        transaction_id: txn.id,
        wallet_id: w.id,
        amount: req.amount,
        balance_after: balanceAfter,
        created_at: txn.created_at,
      };
      this.store.setIdempotency('deposit', req.idempotency_key, { fingerprint, result });
      return result;
    });
  }

  async setWalletStatus(id: string, status: WalletStatus, reason?: string): Promise<Wallet> {
    return this.store.transaction(() => {
      const w = this.mustGet(id);
      if (w.status === status) return w;
      if (!ALLOWED_TRANSITIONS[w.status].includes(status)) {
        throw new AppError('INVALID_STATE', `Không thể chuyển ví từ ${w.status} sang ${status}`, { from: w.status, to: status });
      }
      if (status === 'closed' && w.balance !== 0) {
        throw new AppError('INVALID_STATE', 'Ví còn số dư, phải rút hết trước khi đóng', { balance: w.balance });
      }
      this.store.updateWallet(id, { status });
      void reason;
      return { ...w, status };
    });
  }

  async lookupAccount(req: LookupAccountRequest): Promise<LookupAccountResult> {
    // Sổ cái chỉ biết tài khoản của chính mình; ngân hàng khác cần provider thật.
    const w = req.bank_code === this.bankCode ? this.store.findWalletByAccount(req.account_number) : null;
    if (!w || w.status === 'closed') {
      throw new AppError('ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản thụ hưởng', {
        bank_code: req.bank_code,
        account_number: req.account_number,
      });
    }
    return { bank_code: w.bank_code, account_number: w.account_number, account_name: w.owner_name, wallet_id: w.id };
  }

  parseIncomingPayment(body: unknown): IncomingPayment {
    const parsed = incomingPaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Payload webhook không hợp lệ', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const { occurred_at, ...rest } = parsed.data;
    return { ...rest, occurred_at: occurred_at ?? this.now().toISOString() };
  }

  async applyIncomingPayment(p: IncomingPayment): Promise<ApplyIncomingResult> {
    return this.store.transaction(() => {
      const existing = this.store.getIncomingPayment(p.event_id);
      if (existing) return { record: existing, duplicate: true };
      const w = this.store.findWalletByAccount(p.account_number);
      const canApply = !!w && w.status !== 'closed' && (!p.bank_code || p.bank_code === this.bankCode);
      let txnId: string | null = null;
      if (w && canApply) {
        const txn = this.post(w.id, {
          type: 'credit',
          amount: p.amount,
          fee: 0,
          balance_after: w.balance + p.amount,
          description: p.description ?? 'Tiền vào',
          reference: p.event_id,
          counterparty: {
            ...(p.payer_account ? { account_number: p.payer_account } : {}),
            ...(p.payer_name ? { name: p.payer_name } : {}),
          },
        });
        txnId = txn.id;
      }
      const record: IncomingPaymentRecord = {
        ...p,
        wallet_id: w?.id ?? null,
        applied: canApply,
        transaction_id: txnId,
        received_at: this.now().toISOString(),
        forwarded_at: null,
        last_attempt_at: null,
      };
      this.store.insertIncomingPayment(record);
      return { record, duplicate: false };
    });
  }

  async listIncomingPayments(filter: ListIncomingFilter): Promise<IncomingPaymentRecord[]> {
    return this.store.listIncomingPayments(filter);
  }

  async markIncomingPaymentForwarded(eventId: string, forwardedAt: string): Promise<void> {
    this.store.markIncomingPaymentForwarded(eventId, forwardedAt);
  }

  async recordForwardAttempt(eventId: string, attemptedAt: string): Promise<void> {
    this.store.recordForwardAttempt(eventId, attemptedAt);
  }

  async createPaymentQr(req: PaymentQrRequest): Promise<PaymentQrResult> {
    const w = this.mustGet(req.wallet_id);
    if (w.status === 'closed') throw new AppError('WALLET_INACTIVE', 'Ví đã đóng');
    const expires_at = req.expires_in_seconds ? new Date(this.now().getTime() + req.expires_in_seconds * 1000).toISOString() : null;
    return {
      wallet_id: w.id,
      bank_code: w.bank_code,
      account_number: w.account_number,
      account_name: w.owner_name,
      amount: req.amount ?? null,
      description: req.description ?? null,
      qr_content: ['MOCKQR', w.bank_code, w.account_number, req.amount ?? '', req.description ?? ''].join('|'),
      qr_image_url: null,
      expires_at,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: `provider=${this.name}` };
  }

  // Tiện ích dev/test: ghi có nhanh, tự sinh idempotency_key.
  async credit(walletId: string, amount: number, description = 'Nạp tiền giả lập'): Promise<DepositResult> {
    if (!Number.isInteger(amount) || amount <= 0) throw new AppError('VALIDATION_ERROR', 'amount phải là số nguyên dương');
    return this.deposit({ wallet_id: walletId, amount, description, idempotency_key: `credit-${randomBytes(8).toString('hex')}` });
  }

  private post(walletId: string, t: Omit<Transaction, 'id' | 'wallet_id' | 'created_at'>): Transaction {
    const txn: Transaction = { id: `txn_${randomBytes(8).toString('hex')}`, wallet_id: walletId, created_at: this.now().toISOString(), ...t };
    this.store.updateWallet(walletId, { balance: t.balance_after });
    this.store.insertTransaction(txn);
    return txn;
  }

  private mustGet(id: string): Wallet {
    const w = this.store.getWallet(id);
    if (!w) throw new AppError('WALLET_NOT_FOUND', 'Không tìm thấy ví', { wallet_id: id });
    return w;
  }

  private genAccountNumber(): string {
    let s = '';
    while (s.length < 11) s += randomBytes(4).readUInt32BE(0).toString().padStart(10, '0');
    return `9${s.slice(0, 11)}`;
  }
}

function fp(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function dupKey(key: string): AppError {
  return new AppError('DUPLICATE_REQUEST', 'idempotency_key đã dùng cho một giao dịch khác', { idempotency_key: key });
}
