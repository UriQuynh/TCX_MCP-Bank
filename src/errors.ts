export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_INACTIVE'
  | 'INSUFFICIENT_FUNDS'
  | 'DUPLICATE_REQUEST'
  | 'ACCOUNT_NOT_FOUND'
  | 'INVALID_STATE'
  | 'WEBHOOK_REJECTED'
  | 'PROVIDER_ERROR'
  | 'NOT_SUPPORTED';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// reason chỉ ghi vào audit log, KHÔNG trả về client (tránh lộ key nào tồn tại/hết hạn)
export class AuthError extends AppError {
  constructor(public readonly reason: string) {
    super('UNAUTHENTICATED', 'API key không hợp lệ hoặc bị từ chối');
    this.name = 'AuthError';
  }
}

export function toErrorPayload(err: unknown): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
  if (err instanceof AppError) {
    return err.details ? { code: err.code, message: err.message, details: err.details } : { code: err.code, message: err.message };
  }
  return { code: 'PROVIDER_ERROR', message: 'Lỗi nội bộ khi xử lý yêu cầu' };
}
