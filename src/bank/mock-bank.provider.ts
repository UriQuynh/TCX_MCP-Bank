import { LedgerBankProvider } from './ledger-bank.provider.js';
import { MemoryLedgerStore } from './ledger-store.js';

export const MOCK_BANK_CODE = 'TCXMOCK';

// Giả lập trong bộ nhớ (mất khi restart). Cùng logic với provider `local` (SQLite).
export class MockBankProvider extends LedgerBankProvider {
  constructor(now?: () => Date) {
    super(new MemoryLedgerStore(), { name: 'mock', bankCode: MOCK_BANK_CODE, ...(now ? { now } : {}) });
  }
}
