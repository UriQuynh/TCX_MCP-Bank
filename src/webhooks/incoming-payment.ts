import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type { AuditLogger } from '../audit/audit-log.js';
import { isPrivateIp } from '../bank/http-bank.provider.js';
import type { ApplyIncomingResult, BankProvider, IncomingPaymentRecord } from '../bank/types.js';
import { AppError } from '../errors.js';

export interface WebhookVerifyOptions {
  secret: string;
  toleranceSec: number;
  now?: () => number;
}

// Scheme mặc định: X-Bank-Timestamp (unix giây) + X-Bank-Signature = hex(HMAC-SHA256(secret, `${ts}.${rawBody}`)).
// Ngân hàng thật dùng scheme khác -> sửa hàm này (giữ nguyên chống replay + so sánh timing-safe).
export function verifyWebhookSignature(
  rawBody: Buffer,
  headers: { timestamp?: string; signature?: string },
  opts: WebhookVerifyOptions,
): void {
  const ts = Number(headers.timestamp);
  if (!headers.timestamp || !Number.isFinite(ts)) throw new AppError('WEBHOOK_REJECTED', 'Thiếu/sai X-Bank-Timestamp');
  const nowSec = Math.floor((opts.now ?? (() => Date.now()))() / 1000);
  if (Math.abs(nowSec - ts) > opts.toleranceSec) throw new AppError('WEBHOOK_REJECTED', 'Timestamp ngoài khoảng cho phép (replay?)');
  const sig = (headers.signature ?? '').trim().toLowerCase().replace(/^sha256=/, '');
  if (!/^[a-f0-9]{64}$/.test(sig)) throw new AppError('WEBHOOK_REJECTED', 'Thiếu/sai X-Bank-Signature');
  const expected = createHmac('sha256', opts.secret).update(`${ts}.`).update(rawBody).digest();
  const given = Buffer.from(sig, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AppError('WEBHOOK_REJECTED', 'Chữ ký không khớp');
  }
}

export interface ForwardOptions {
  url: string;
  secret: string;
  audit: AuditLogger;
  fetchImpl?: typeof fetch;
  attempts?: number;
  timeoutMs?: number;
  allowInsecure?: boolean;
}

// Kiểm target KHÔNG trỏ về địa chỉ nội bộ — cùng guard với HttpBankProvider
// (vá audit vòng 9, 2026-09-11: trước đây chỉ HttpBankProvider có SSRF guard,
// đường forward-webhook này không có dù cũng POST tới 1 URL đọc từ env).
// URL do người vận hành cấu hình (INCOMING_PAYMENT_FORWARD_URL), không phải
// input tấn công trực tiếp — nhưng nếu .env trỏ nhầm/bị rebind DNS, guard này
// chặn âm thầm POST payload báo có ra 1 service nội bộ không nên nhận nó.
async function assertSafeForwardTarget(rawUrl: string): Promise<void> {
  const u = new URL(rawUrl);
  if (u.protocol !== 'https:') {
    throw new AppError('PROVIDER_ERROR', 'INCOMING_PAYMENT_FORWARD_URL phải là https://');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  for (const ip of addrs) {
    if (isPrivateIp(ip)) {
      throw new AppError('PROVIDER_ERROR', `INCOMING_PAYMENT_FORWARD_URL phân giải về địa chỉ nội bộ (${ip}) - bị chặn (SSRF)`);
    }
  }
}

// Chuyển tiếp bản ghi "báo có" sang hệ thống khác (vd TCX_Backend) với chữ ký riêng, retry có backoff.
export async function forwardIncomingPayment(record: IncomingPaymentRecord, opts: ForwardOptions): Promise<boolean> {
  if (!opts.allowInsecure) {
    try {
      await assertSafeForwardTarget(opts.url);
    } catch (err) {
      opts.audit.log({ transport: 'http', keyId: null, keyName: null, event: 'forward', outcome: 'error', code: 'SSRF_BLOCKED', reason: record.event_id });
      throw err;
    }
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 3;
  const body = JSON.stringify({ type: 'incoming_payment', data: record });
  for (let i = 1; i <= attempts; i++) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', opts.secret).update(`${ts}.${body}`).digest('hex');
    try {
      const res = await fetchImpl(opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TCX-Timestamp': ts, 'X-TCX-Signature': sig },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
        redirect: 'error',
      });
      if (res.ok) {
        opts.audit.log({ transport: 'http', keyId: null, keyName: null, event: 'forward', outcome: 'success', reason: record.event_id });
        return true;
      }
      opts.audit.log({ transport: 'http', keyId: null, keyName: null, event: 'forward', outcome: 'error', code: `HTTP_${res.status}`, reason: record.event_id });
    } catch (err) {
      opts.audit.log({ transport: 'http', keyId: null, keyName: null, event: 'forward', outcome: 'error', code: (err as Error).name, reason: record.event_id });
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
  }
  return false;
}

export interface HandleWebhookDeps {
  bank: BankProvider;
  audit: AuditLogger;
  verify: WebhookVerifyOptions;
  forward?: Omit<ForwardOptions, 'audit'>;
  remoteIp?: string;
}

export interface HandleWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleIncomingPaymentWebhook(
  rawBody: Buffer,
  headers: { timestamp?: string; signature?: string },
  deps: HandleWebhookDeps,
): Promise<HandleWebhookResult> {
  const base = { transport: 'http' as const, keyId: null, keyName: null, event: 'webhook' as const, ...(deps.remoteIp ? { remoteIp: deps.remoteIp } : {}) };
  try {
    verifyWebhookSignature(rawBody, headers, deps.verify);
  } catch (err) {
    const e = err as AppError;
    deps.audit.log({ ...base, outcome: 'denied', code: e.code, reason: e.message });
    return { status: 401, body: { ok: false, error: { code: 'WEBHOOK_REJECTED', message: 'Chữ ký/timestamp không hợp lệ' } } };
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    deps.audit.log({ ...base, outcome: 'error', code: 'VALIDATION_ERROR', reason: 'body không phải JSON' });
    return { status: 400, body: { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Body không phải JSON' } } };
  }

  let applied: ApplyIncomingResult;
  try {
    const payment = deps.bank.parseIncomingPayment(json);
    applied = await deps.bank.applyIncomingPayment(payment);
  } catch (err) {
    const e = err instanceof AppError ? err : new AppError('PROVIDER_ERROR', 'Không xử lý được webhook');
    deps.audit.log({ ...base, outcome: 'error', code: e.code, reason: e.message, params: json as Record<string, unknown> });
    return { status: e.code === 'VALIDATION_ERROR' ? 400 : 500, body: { ok: false, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } } };
  }

  const { record, duplicate } = applied;
  deps.audit.log({
    ...base,
    outcome: 'success',
    tool: 'incoming_payment',
    params: { event_id: record.event_id, account_number: record.account_number, amount: record.amount, wallet_id: record.wallet_id, applied: record.applied, duplicate },
  });
  if (!duplicate && deps.forward) {
    void forwardIncomingPayment(record, { ...deps.forward, audit: deps.audit });
  }
  return {
    status: 200,
    body: { ok: true, event_id: record.event_id, wallet_id: record.wallet_id, applied: record.applied, duplicate, transaction_id: record.transaction_id },
  };
}
