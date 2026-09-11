import { createHmac } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
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
  LookupAccountRequest,
  LookupAccountResult,
  WalletStatus,
  ListTransactionsOptions,
  ListWalletsFilter,
  PaymentQrRequest,
  PaymentQrResult,
  Transaction,
  TransferRequest,
  TransferResult,
  Wallet,
} from './types.js';

export interface HttpBankProviderOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret?: string;
  timeoutMs: number;
  allowInsecure?: boolean;
  fetchImpl?: typeof fetch;
  bankCode?: string;
  // Lưu bản ghi webhook "báo có" (ngân hàng đã ghi có, ta chỉ ghi nhận + tra cứu lại)
  incomingStore: Pick<LedgerStore, 'transaction' | 'getIncomingPayment' | 'insertIncomingPayment' | 'listIncomingPayments'>;
}

// Adapter REST tổng quát. Contract endpoint/response mặc định mô tả trong README ("HTTP provider");
// khi nối ngân hàng/VA provider thật, chỉ cần sửa các hàm map* bên dưới cho khớp contract của họ.
export class HttpBankProvider implements BankProvider {
  readonly name = 'http';
  readonly bankCode: string;
  private readonly base: URL;

  constructor(private readonly opts: HttpBankProviderOptions) {
    this.bankCode = opts.bankCode ?? 'BANK';
    this.base = new URL(opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`);
    if (this.base.protocol !== 'https:' && !opts.allowInsecure) {
      throw new Error('BANK_API_BASE_URL phải là https:// (đặt BANK_API_ALLOW_INSECURE=true chỉ cho sandbox)');
    }
  }

  async createWallet(input: CreateWalletInput): Promise<Wallet> {
    return this.mapWallet(await this.request('POST', 'wallets', input));
  }

  async getWallet(id: string): Promise<Wallet | null> {
    try {
      return this.mapWallet(await this.request('GET', `wallets/${encodeURIComponent(id)}`));
    } catch (err) {
      if (err instanceof AppError && err.code === 'WALLET_NOT_FOUND') return null;
      throw err;
    }
  }

  async listWallets(filter: ListWalletsFilter): Promise<Wallet[]> {
    const q = new URLSearchParams({ limit: String(filter.limit) });
    if (filter.owner_ref) q.set('owner_ref', filter.owner_ref);
    if (filter.account_number) q.set('account_number', filter.account_number);
    const body = await this.request('GET', `wallets?${q}`);
    return this.asArray(body, 'wallets').map((w) => this.mapWallet(w));
  }

  async getBalance(id: string): Promise<BalanceResult> {
    const b = (await this.request('GET', `wallets/${encodeURIComponent(id)}/balance`)) as Record<string, unknown>;
    return {
      wallet_id: String(b.wallet_id ?? id),
      balance: this.int(b.balance, 'balance'),
      currency: 'VND',
      as_of: String(b.as_of ?? new Date().toISOString()),
    };
  }

  async listTransactions(id: string, opts: ListTransactionsOptions): Promise<Transaction[]> {
    const q = new URLSearchParams({ limit: String(opts.limit) });
    if (opts.since) q.set('since', opts.since);
    const body = await this.request('GET', `wallets/${encodeURIComponent(id)}/transactions?${q}`);
    return this.asArray(body, 'transactions').map((t) => this.mapTransaction(t));
  }

  async transfer(req: TransferRequest): Promise<TransferResult> {
    const { idempotency_key, ...payload } = req;
    const r = (await this.request('POST', 'transfers', payload, { 'Idempotency-Key': idempotency_key })) as Record<
      string,
      unknown
    >;
    return {
      transaction_id: String(r.transaction_id ?? r.id ?? ''),
      status: (['completed', 'pending', 'failed'] as const).find((s) => s === r.status) ?? 'pending',
      amount: this.int(r.amount ?? req.amount, 'amount'),
      fee: this.int(r.fee ?? 0, 'fee'),
      balance_after: this.int(r.balance_after ?? 0, 'balance_after'),
      created_at: String(r.created_at ?? new Date().toISOString()),
      ...(r.replayed === true ? { replayed: true } : {}),
    };
  }

  async createPaymentQr(req: PaymentQrRequest): Promise<PaymentQrResult> {
    const { wallet_id, ...payload } = req;
    const r = (await this.request('POST', `wallets/${encodeURIComponent(wallet_id)}/payment-qr`, payload)) as Record<
      string,
      unknown
    >;
    return {
      wallet_id,
      bank_code: String(r.bank_code ?? ''),
      account_number: String(r.account_number ?? ''),
      account_name: String(r.account_name ?? ''),
      amount: r.amount == null ? null : this.int(r.amount, 'amount'),
      description: r.description == null ? null : String(r.description),
      qr_content: String(r.qr_content ?? ''),
      qr_image_url: r.qr_image_url == null ? null : String(r.qr_image_url),
      expires_at: r.expires_at == null ? null : String(r.expires_at),
    };
  }

  async deposit(req: DepositRequest): Promise<DepositResult> {
    const { wallet_id, idempotency_key, ...payload } = req;
    const r = (await this.request('POST', `wallets/${encodeURIComponent(wallet_id)}/deposits`, payload, {
      'Idempotency-Key': idempotency_key,
    })) as Record<string, unknown>;
    return {
      transaction_id: String(r.transaction_id ?? r.id ?? ''),
      wallet_id,
      amount: this.int(r.amount ?? req.amount, 'amount'),
      balance_after: this.int(r.balance_after ?? 0, 'balance_after'),
      created_at: String(r.created_at ?? new Date().toISOString()),
      ...(r.replayed === true ? { replayed: true } : {}),
    };
  }

  async setWalletStatus(id: string, status: WalletStatus, reason?: string): Promise<Wallet> {
    return this.mapWallet(await this.request('POST', `wallets/${encodeURIComponent(id)}/status`, { status, ...(reason ? { reason } : {}) }));
  }

  async lookupAccount(req: LookupAccountRequest): Promise<LookupAccountResult> {
    const q = new URLSearchParams({ bank_code: req.bank_code, account_number: req.account_number });
    try {
      const r = (await this.request('GET', `accounts/lookup?${q}`)) as Record<string, unknown>;
      if (typeof r?.account_name !== 'string' || !r.account_name) throw new AppError('PROVIDER_ERROR', 'Response lookup thiếu account_name');
      return { bank_code: String(r.bank_code ?? req.bank_code), account_number: String(r.account_number ?? req.account_number), account_name: r.account_name };
    } catch (err) {
      if (err instanceof AppError && err.code === 'WALLET_NOT_FOUND') {
        throw new AppError('ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản thụ hưởng', { bank_code: req.bank_code, account_number: req.account_number });
      }
      throw err;
    }
  }

  // Điểm sửa khi nối ngân hàng thật: map payload webhook của họ về incomingPaymentSchema.
  parseIncomingPayment(body: unknown): IncomingPayment {
    const parsed = incomingPaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Payload webhook không hợp lệ', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const { occurred_at, ...rest } = parsed.data;
    return { ...rest, occurred_at: occurred_at ?? new Date().toISOString() };
  }

  async applyIncomingPayment(p: IncomingPayment): Promise<ApplyIncomingResult> {
    const existing = this.opts.incomingStore.getIncomingPayment(p.event_id);
    if (existing) return { record: existing, duplicate: true };
    // Ngân hàng đã ghi có; chỉ resolve wallet_id để đối soát.
    let walletId: string | null = null;
    try {
      walletId = (await this.listWallets({ account_number: p.account_number, limit: 1 }))[0]?.id ?? null;
    } catch {
      walletId = null;
    }
    const record: IncomingPaymentRecord = { ...p, wallet_id: walletId, applied: true, transaction_id: p.reference ?? null, received_at: new Date().toISOString() };
    return this.opts.incomingStore.transaction(() => {
      const again = this.opts.incomingStore.getIncomingPayment(p.event_id);
      if (again) return { record: again, duplicate: true };
      this.opts.incomingStore.insertIncomingPayment(record);
      return { record, duplicate: false };
    });
  }

  async listIncomingPayments(filter: ListIncomingFilter): Promise<IncomingPaymentRecord[]> {
    return this.opts.incomingStore.listIncomingPayments(filter);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.request('GET', 'health');
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  // ---- internals ----

  // Re-check MỖI request, không cache kết quả (vá audit vòng 9, 2026-09-11):
  // bản trước chỉ kiểm 1 lần rồi tin mãi mãi (`safeChecked`), để lọt cửa sổ
  // DNS-rebinding — nếu ai kiểm soát được DNS của domain cấu hình trong
  // `BANK_API_BASE_URL` (dù là domain admin tự đặt, không phải input tấn
  // công trực tiếp) đổi bản ghi SAU lần check đầu, mọi request sau đó không
  // còn bị kiểm lại. `dns.lookup` rẻ và tần suất gọi ở luồng này thấp (thao
  // tác ví/chuyển khoản, không phải hot path), nên bỏ cache không đổi rõ rệt
  // chi phí. Vẫn còn 1 khoảng TOCTOU nhỏ giữa lookup và `fetch()` tự resolve
  // lại — chấp nhận được vì `fetch()` không cho chọn IP đích thủ công; muốn
  // đóng triệt để cần pin IP đã verify vào request thật, chưa làm vì
  // `BANK_PROVIDER=http` chưa dùng ở prod.
  private async assertSafeTarget(): Promise<void> {
    const host = this.base.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
    for (const ip of addrs) {
      if (isPrivateIp(ip)) {
        throw new AppError('PROVIDER_ERROR', `BANK_API_BASE_URL phân giải về địa chỉ nội bộ (${ip}) - bị chặn (SSRF)`);
      }
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    if (!this.opts.allowInsecure) await this.assertSafeTarget();
    const url = new URL(path, this.base);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.opts.apiKey}`,
      'X-Timestamp': ts,
      ...extraHeaders,
    };
    if (payload) headers['Content-Type'] = 'application/json';
    if (this.opts.apiSecret) {
      headers['X-Signature'] = createHmac('sha256', this.opts.apiSecret)
        .update(`${ts}.${method}.${url.pathname}${url.search}.${payload}`)
        .digest('hex');
    }

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: payload || undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw new AppError('PROVIDER_ERROR', `Không gọi được API ngân hàng: ${(err as Error).name}`);
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok) return json;

    const code = typeof (json as Record<string, unknown> | null)?.code === 'string' ? String((json as Record<string, unknown>).code) : '';
    const msg = typeof (json as Record<string, unknown> | null)?.message === 'string' ? String((json as Record<string, unknown>).message) : `HTTP ${res.status}`;
    if (res.status === 404) throw new AppError('WALLET_NOT_FOUND', msg);
    if (res.status === 409) throw new AppError('DUPLICATE_REQUEST', msg);
    if (/INSUFFICIENT/i.test(code) || res.status === 402) throw new AppError('INSUFFICIENT_FUNDS', msg);
    if (res.status === 400 || res.status === 422) throw new AppError('VALIDATION_ERROR', msg);
    throw new AppError('PROVIDER_ERROR', `API ngân hàng trả lỗi ${res.status}`);
  }

  private asArray(body: unknown, key: string): Record<string, unknown>[] {
    if (Array.isArray(body)) return body as Record<string, unknown>[];
    const inner = (body as Record<string, unknown> | null)?.[key] ?? (body as Record<string, unknown> | null)?.data;
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
    throw new AppError('PROVIDER_ERROR', `Response thiếu mảng "${key}"`);
  }

  private int(v: unknown, field: string): number {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new AppError('PROVIDER_ERROR', `Response thiếu/sai trường ${field}`);
    return Math.trunc(n);
  }

  private mapWallet(raw: unknown): Wallet {
    const w = raw as Record<string, unknown>;
    if (!w || typeof w.id !== 'string') throw new AppError('PROVIDER_ERROR', 'Response ví thiếu id');
    const status = (['active', 'frozen', 'closed'] as const).find((s) => s === w.status) ?? 'active';
    return {
      id: w.id,
      owner_ref: String(w.owner_ref ?? ''),
      owner_name: String(w.owner_name ?? w.account_name ?? ''),
      currency: 'VND',
      bank_code: String(w.bank_code ?? ''),
      account_number: String(w.account_number ?? ''),
      status,
      balance: this.int(w.balance ?? 0, 'balance'),
      created_at: String(w.created_at ?? new Date().toISOString()),
      ...(w.metadata && typeof w.metadata === 'object' ? { metadata: w.metadata as Record<string, string> } : {}),
    };
  }

  private mapTransaction(raw: Record<string, unknown>): Transaction {
    return {
      id: String(raw.id ?? ''),
      wallet_id: String(raw.wallet_id ?? ''),
      type: raw.type === 'credit' ? 'credit' : 'debit',
      amount: this.int(raw.amount, 'amount'),
      fee: this.int(raw.fee ?? 0, 'fee'),
      balance_after: this.int(raw.balance_after ?? 0, 'balance_after'),
      description: String(raw.description ?? ''),
      created_at: String(raw.created_at ?? ''),
      ...(raw.reference ? { reference: String(raw.reference) } : {}),
      ...(raw.counterparty && typeof raw.counterparty === 'object'
        ? { counterparty: raw.counterparty as Transaction['counterparty'] }
        : {}),
    };
  }
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return m ? isPrivateIp(m[1]!) : false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
