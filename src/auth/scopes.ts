export const SCOPES = {
  WALLET_CREATE: 'wallet:create',
  WALLET_READ: 'wallet:read',
  TRANSACTION_READ: 'transaction:read',
  TRANSFER_CREATE: 'transfer:create',
  QR_CREATE: 'qr:create',
  WALLET_MANAGE: 'wallet:manage',
  DEPOSIT_CREATE: 'deposit:create',
  ACCOUNT_LOOKUP: 'account:lookup',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const ALL_SCOPES: readonly Scope[] = Object.values(SCOPES);

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  'wallet:create': 'Tạo ví/tài khoản mới với ngân hàng',
  'wallet:read': 'Xem thông tin ví, danh sách ví, số dư',
  'transaction:read': 'Xem lịch sử giao dịch của ví',
  'transfer:create': 'Chuyển tiền ra khỏi ví (thao tác tài chính, rủi ro cao)',
  'qr:create': 'Tạo mã QR nhận tiền vào ví',
  'wallet:manage': 'Đóng băng / mở băng / đóng ví',
  'deposit:create': 'Nạp tiền (ghi có) vào ví',
  'account:lookup': 'Tra cứu tên chủ tài khoản thụ hưởng',
};

export function isScope(value: string): value is Scope {
  return (ALL_SCOPES as readonly string[]).includes(value);
}

export function hasScopes(granted: readonly string[], required: readonly Scope[]): boolean {
  return required.every((s) => granted.includes(s));
}

export function missingScopes(granted: readonly string[], required: readonly Scope[]): Scope[] {
  return required.filter((s) => !granted.includes(s));
}
