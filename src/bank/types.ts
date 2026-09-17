export type WalletStatus = 'active' | 'frozen' | 'closed';

export interface Wallet {
  id: string;
  owner_ref: string;
  owner_name: string;
  currency: 'VND';
  bank_code: string;
  account_number: string;
  status: WalletStatus;
  balance: number;
  metadata?: Record<string, string>;
  created_at: string;
}

export interface Transaction {
  id: string;
  wallet_id: string;
  type: 'credit' | 'debit';
  amount: number;
  fee: number;
  balance_after: number;
  counterparty?: { bank_code?: string; account_number?: string; name?: string };
  description: string;
  reference?: string;
  created_at: string;
}

export interface CreateWalletInput {
  owner_ref: string;
  owner_name: string;
  metadata?: Record<string, string>;
}

export interface ListWalletsFilter {
  owner_ref?: string;
  account_number?: string;
  limit: number;
}

export interface ListTransactionsOptions {
  limit: number;
  since?: string;
}

export interface TransferRequest {
  from_wallet_id: string;
  to_bank_code: string;
  to_account_number: string;
  to_account_name?: string;
  amount: number;
  description: string;
  idempotency_key: string;
}

export interface TransferResult {
  transaction_id: string;
  status: 'completed' | 'pending' | 'failed';
  amount: number;
  fee: number;
  balance_after: number;
  created_at: string;
  replayed?: boolean;
}

export interface PaymentQrRequest {
  wallet_id: string;
  amount?: number;
  description?: string;
  expires_in_seconds?: number;
}

export interface PaymentQrResult {
  wallet_id: string;
  bank_code: string;
  account_number: string;
  account_name: string;
  amount: number | null;
  description: string | null;
  qr_content: string;
  qr_image_url: string | null;
  expires_at: string | null;
}

export interface BalanceResult {
  wallet_id: string;
  balance: number;
  currency: 'VND';
  as_of: string;
}

export interface DepositRequest {
  wallet_id: string;
  amount: number;
  description: string;
  idempotency_key: string;
  source?: string;
}

export interface DepositResult {
  transaction_id: string;
  wallet_id: string;
  amount: number;
  balance_after: number;
  created_at: string;
  replayed?: boolean;
}

export interface LookupAccountRequest {
  bank_code: string;
  account_number: string;
}

export interface LookupAccountResult {
  bank_code: string;
  account_number: string;
  account_name: string;
  wallet_id?: string;
}

export interface IncomingPayment {
  event_id: string;
  bank_code?: string;
  account_number: string;
  amount: number;
  description?: string;
  reference?: string;
  payer_name?: string;
  payer_account?: string;
  occurred_at: string;
}

export interface IncomingPaymentRecord extends IncomingPayment {
  wallet_id: string | null;
  applied: boolean;
  transaction_id: string | null;
  received_at: string;
  // Mốc forward xuống hệ thống khác (TCX_Backend) THÀNH CÔNG — null nghĩa là
  // chưa forward hoặc lần trước thất bại (F08, RE-AUDIT 2026-09-17). Tách
  // khỏi `applied`/`duplicate`: 1 bản ghi có thể applied=true mà vẫn chưa
  // forward xong nếu downstream đang lỗi/process từng restart giữa chừng.
  forwarded_at: string | null;
}

export interface ApplyIncomingResult {
  record: IncomingPaymentRecord;
  duplicate: boolean;
}

export interface ListIncomingFilter {
  wallet_id?: string;
  limit: number;
  since?: string;
  // Chỉ trả bản ghi CHƯA forward thành công (forwarded_at is null) — dùng cho
  // outbox sweep định kỳ (F08), không phải cho API liệt kê thông thường.
  unforwardedOnly?: boolean;
}

export interface BankProvider {
  readonly name: string;
  readonly bankCode: string;
  createWallet(input: CreateWalletInput): Promise<Wallet>;
  getWallet(id: string): Promise<Wallet | null>;
  listWallets(filter: ListWalletsFilter): Promise<Wallet[]>;
  getBalance(id: string): Promise<BalanceResult>;
  listTransactions(id: string, opts: ListTransactionsOptions): Promise<Transaction[]>;
  transfer(req: TransferRequest): Promise<TransferResult>;
  createPaymentQr(req: PaymentQrRequest): Promise<PaymentQrResult>;
  deposit(req: DepositRequest): Promise<DepositResult>;
  setWalletStatus(id: string, status: WalletStatus, reason?: string): Promise<Wallet>;
  lookupAccount(req: LookupAccountRequest): Promise<LookupAccountResult>;
  parseIncomingPayment(body: unknown): IncomingPayment;
  applyIncomingPayment(p: IncomingPayment): Promise<ApplyIncomingResult>;
  listIncomingPayments(filter: ListIncomingFilter): Promise<IncomingPaymentRecord[]>;
  // Đánh dấu 1 bản ghi "báo có" đã forward xuống hệ thống khác THÀNH CÔNG
  // (F08, RE-AUDIT 2026-09-17) — outbox sweep định kỳ dùng để biết bản ghi
  // nào còn nợ forward sau khi process restart/downstream outage kéo dài.
  markIncomingPaymentForwarded(eventId: string, forwardedAt: string): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
