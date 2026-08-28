import { z } from 'zod';
import type { Principal } from '../auth/authenticate.js';
import { SCOPES, SCOPE_DESCRIPTIONS, type Scope } from '../auth/scopes.js';
import type { BankProvider } from '../bank/types.js';
import { AppError } from '../errors.js';

export interface ToolContext {
  bank: BankProvider;
  principal: Principal;
  maxTransferAmount: number;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  scopes: readonly Scope[];
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  input: Shape;
  run(ctx: ToolContext, args: z.infer<z.ZodObject<Shape>>): Promise<unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any>;

function defineTool<Shape extends z.ZodRawShape>(def: ToolDefinition<Shape>): AnyToolDefinition {
  return def;
}

// ---- field schemas (chặt, từ chối input lạ ngay tại biên) ----
const ownerRef = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:@-]+$/, 'owner_ref chỉ gồm chữ, số, _ . : @ -');
const ownerName = z.string().trim().min(2).max(100);
const walletId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'wallet_id không hợp lệ');
const bankCode = z.string().regex(/^[A-Z0-9]{2,12}$/, 'bank_code phải là 2-12 ký tự A-Z0-9');
const accountNumber = z.string().regex(/^[0-9]{6,20}$/, 'account_number phải là 6-20 chữ số');
const amountVnd = z.number().int('Số tiền VND phải là số nguyên').positive().max(1_000_000_000_000);
const description = z
  .string()
  .trim()
  .min(1)
  .max(140)
  .regex(/^[^\r\n\t]+$/, 'description không được chứa xuống dòng/tab');
const idempotencyKey = z.string().min(8).max(64).regex(/^[A-Za-z0-9_.:-]+$/, 'idempotency_key không hợp lệ');
const limit = z.number().int().min(1).max(100).default(20);
const isoDate = z.string().datetime({ offset: true });
const metadata = z.record(z.string().max(32), z.string().max(200)).optional();

export const TOOL_DEFINITIONS: readonly AnyToolDefinition[] = [
  defineTool({
    name: 'bank_whoami',
    title: 'Thông tin API key hiện tại',
    description:
      'Trả về tên key, danh sách scope được cấp và provider ngân hàng đang dùng. Gọi tool này trước để biết mình được phép làm gì.',
    scopes: [],
    readOnly: true,
    idempotent: true,
    input: {},
    async run(ctx) {
      return {
        key_id: ctx.principal.keyId,
        key_name: ctx.principal.name,
        scopes: ctx.principal.scopes.map((s) => ({ scope: s, description: SCOPE_DESCRIPTIONS[s] })),
        rate_limit_per_minute: ctx.principal.rateLimitPerMinute,
        bank_provider: ctx.bank.name,
        max_transfer_amount_vnd: ctx.maxTransferAmount,
      };
    },
  }),

  defineTool({
    name: 'bank_create_wallet',
    title: 'Tạo ví với ngân hàng',
    description:
      'Mở một ví/tài khoản mới tại ngân hàng cho chủ sở hữu (owner_ref là id nội bộ, ví dụ users.id của TCX). Trả về wallet kèm số tài khoản nhận tiền. Yêu cầu scope wallet:create.',
    scopes: [SCOPES.WALLET_CREATE],
    readOnly: false,
    input: {
      owner_ref: ownerRef.describe('Định danh nội bộ của chủ ví (vd: users.id)'),
      owner_name: ownerName.describe('Tên chủ ví hiển thị trên tài khoản'),
      metadata: metadata.describe('Tối đa 10 cặp key/value tuỳ chọn'),
    },
    async run(ctx, args) {
      if (args.metadata && Object.keys(args.metadata).length > 10) {
        throw new AppError('VALIDATION_ERROR', 'metadata tối đa 10 khoá');
      }
      return ctx.bank.createWallet({
        owner_ref: args.owner_ref,
        owner_name: args.owner_name,
        ...(args.metadata ? { metadata: args.metadata } : {}),
      });
    },
  }),

  defineTool({
    name: 'bank_get_wallet',
    title: 'Xem thông tin ví',
    description: 'Lấy chi tiết một ví theo wallet_id. Yêu cầu scope wallet:read.',
    scopes: [SCOPES.WALLET_READ],
    readOnly: true,
    idempotent: true,
    input: { wallet_id: walletId },
    async run(ctx, args) {
      const w = await ctx.bank.getWallet(args.wallet_id);
      if (!w) throw new AppError('WALLET_NOT_FOUND', 'Không tìm thấy ví', { wallet_id: args.wallet_id });
      return w;
    },
  }),

  defineTool({
    name: 'bank_list_wallets',
    title: 'Danh sách ví',
    description: 'Liệt kê ví, lọc theo owner_ref nếu cần. Yêu cầu scope wallet:read.',
    scopes: [SCOPES.WALLET_READ],
    readOnly: true,
    idempotent: true,
    input: { owner_ref: ownerRef.optional(), limit },
    async run(ctx, args) {
      return ctx.bank.listWallets({ limit: args.limit, ...(args.owner_ref ? { owner_ref: args.owner_ref } : {}) });
    },
  }),

  defineTool({
    name: 'bank_get_balance',
    title: 'Số dư ví',
    description: 'Lấy số dư hiện tại (VND) của ví. Yêu cầu scope wallet:read.',
    scopes: [SCOPES.WALLET_READ],
    readOnly: true,
    idempotent: true,
    input: { wallet_id: walletId },
    async run(ctx, args) {
      return ctx.bank.getBalance(args.wallet_id);
    },
  }),

  defineTool({
    name: 'bank_list_transactions',
    title: 'Lịch sử giao dịch',
    description: 'Liệt kê giao dịch của ví, mới nhất trước. Yêu cầu scope transaction:read.',
    scopes: [SCOPES.TRANSACTION_READ],
    readOnly: true,
    idempotent: true,
    input: { wallet_id: walletId, limit, since: isoDate.optional().describe('ISO 8601, chỉ lấy giao dịch từ mốc này') },
    async run(ctx, args) {
      return ctx.bank.listTransactions(args.wallet_id, { limit: args.limit, ...(args.since ? { since: args.since } : {}) });
    },
  }),

  defineTool({
    name: 'bank_transfer',
    title: 'Chuyển tiền từ ví',
    description:
      'Chuyển tiền (VND) từ ví sang tài khoản ngân hàng khác. BẮT BUỘC idempotency_key duy nhất cho mỗi lệnh; gửi lại cùng key sẽ trả về kết quả cũ thay vì chuyển lần 2. Yêu cầu scope transfer:create.',
    scopes: [SCOPES.TRANSFER_CREATE],
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: {
      from_wallet_id: walletId,
      to_bank_code: bankCode,
      to_account_number: accountNumber,
      to_account_name: z.string().trim().min(2).max(100).optional(),
      amount: amountVnd,
      description,
      idempotency_key: idempotencyKey,
    },
    async run(ctx, args) {
      if (args.amount > ctx.maxTransferAmount) {
        throw new AppError('VALIDATION_ERROR', 'Vượt hạn mức chuyển tối đa mỗi lệnh', {
          amount: args.amount,
          max_transfer_amount_vnd: ctx.maxTransferAmount,
        });
      }
      return ctx.bank.transfer({
        from_wallet_id: args.from_wallet_id,
        to_bank_code: args.to_bank_code,
        to_account_number: args.to_account_number,
        ...(args.to_account_name ? { to_account_name: args.to_account_name } : {}),
        amount: args.amount,
        description: args.description,
        idempotency_key: args.idempotency_key,
      });
    },
  }),

  defineTool({
    name: 'bank_create_payment_qr',
    title: 'Tạo QR nhận tiền',
    description: 'Tạo mã QR để nạp tiền vào ví (số tiền/nội dung tuỳ chọn). Yêu cầu scope qr:create.',
    scopes: [SCOPES.QR_CREATE],
    readOnly: false,
    input: {
      wallet_id: walletId,
      amount: amountVnd.optional(),
      description: description.optional(),
      expires_in_seconds: z.number().int().min(60).max(86_400).optional(),
    },
    async run(ctx, args) {
      return ctx.bank.createPaymentQr({
        wallet_id: args.wallet_id,
        ...(args.amount !== undefined ? { amount: args.amount } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.expires_in_seconds ? { expires_in_seconds: args.expires_in_seconds } : {}),
      });
    },
  }),

  defineTool({
    name: 'bank_deposit',
    title: 'Nạp tiền vào ví',
    description:
      'Ghi có (nạp tiền, VND) vào ví. BẮT BUỘC idempotency_key duy nhất; gửi lại cùng key trả kết quả cũ, không nạp lần 2. Ví đóng băng vẫn nhận được, ví đã đóng thì không. Yêu cầu scope deposit:create.',
    scopes: [SCOPES.DEPOSIT_CREATE],
    readOnly: false,
    idempotent: true,
    input: {
      wallet_id: walletId,
      amount: amountVnd,
      description,
      idempotency_key: idempotencyKey,
      source: z.string().trim().min(1).max(100).optional().describe('Nguồn tiền (vd: "escrow-order-123", "manual-topup")'),
    },
    async run(ctx, args) {
      return ctx.bank.deposit({
        wallet_id: args.wallet_id,
        amount: args.amount,
        description: args.description,
        idempotency_key: args.idempotency_key,
        ...(args.source ? { source: args.source } : {}),
      });
    },
  }),

  defineTool({
    name: 'bank_freeze_wallet',
    title: 'Đóng băng / mở băng ví',
    description:
      'action=freeze: khoá chiều chuyển tiền ra (vẫn nhận tiền vào). action=unfreeze: mở lại. Không áp dụng cho ví đã đóng. Yêu cầu scope wallet:manage.',
    scopes: [SCOPES.WALLET_MANAGE],
    readOnly: false,
    idempotent: true,
    input: {
      wallet_id: walletId,
      action: z.enum(['freeze', 'unfreeze']),
      reason: z.string().trim().min(1).max(200).optional(),
    },
    async run(ctx, args) {
      return ctx.bank.setWalletStatus(args.wallet_id, args.action === 'freeze' ? 'frozen' : 'active', args.reason);
    },
  }),

  defineTool({
    name: 'bank_close_wallet',
    title: 'Đóng ví',
    description: 'Đóng vĩnh viễn ví (không mở lại được). Ví phải có số dư 0. Yêu cầu scope wallet:manage.',
    scopes: [SCOPES.WALLET_MANAGE],
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: { wallet_id: walletId, reason: z.string().trim().min(1).max(200) },
    async run(ctx, args) {
      return ctx.bank.setWalletStatus(args.wallet_id, 'closed', args.reason);
    },
  }),

  defineTool({
    name: 'bank_lookup_account',
    title: 'Tra cứu tên chủ tài khoản thụ hưởng',
    description:
      'Tra tên chủ tài khoản theo mã ngân hàng + số tài khoản để đối chiếu trước khi chuyển tiền. Yêu cầu scope account:lookup.',
    scopes: [SCOPES.ACCOUNT_LOOKUP],
    readOnly: true,
    idempotent: true,
    input: { bank_code: bankCode, account_number: accountNumber },
    async run(ctx, args) {
      return ctx.bank.lookupAccount({ bank_code: args.bank_code, account_number: args.account_number });
    },
  }),

  defineTool({
    name: 'bank_list_incoming_payments',
    title: 'Danh sách tiền vào (webhook báo có)',
    description:
      'Liệt kê các khoản tiền vào đã nhận qua webhook ngân hàng, mới nhất trước; lọc theo wallet_id/since. Yêu cầu scope transaction:read.',
    scopes: [SCOPES.TRANSACTION_READ],
    readOnly: true,
    idempotent: true,
    input: { wallet_id: walletId.optional(), limit, since: isoDate.optional() },
    async run(ctx, args) {
      return ctx.bank.listIncomingPayments({ limit: args.limit, ...(args.wallet_id ? { wallet_id: args.wallet_id } : {}), ...(args.since ? { since: args.since } : {}) });
    },
  }),
];

export function toolsForScopes(granted: readonly string[]): AnyToolDefinition[] {
  return TOOL_DEFINITIONS.filter((t) => t.scopes.every((s) => granted.includes(s)));
}
