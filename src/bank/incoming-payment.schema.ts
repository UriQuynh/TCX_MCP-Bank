import { z } from 'zod';

// Payload chuẩn hoá của webhook "báo có". Ngân hàng thật có payload riêng -> map về dạng này trong provider.
export const incomingPaymentSchema = z.object({
  event_id: z.string().min(1).max(128),
  bank_code: z.string().max(12).optional(),
  account_number: z.string().regex(/^[0-9]{6,20}$/),
  amount: z.number().int().positive(),
  description: z.string().max(500).optional(),
  reference: z.string().max(128).optional(),
  payer_name: z.string().max(200).optional(),
  payer_account: z.string().max(32).optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
});

export type IncomingPaymentInput = z.infer<typeof incomingPaymentSchema>;
