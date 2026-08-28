import type { AppConfig } from '../config.js';
import { HttpBankProvider } from './http-bank.provider.js';
import { LedgerBankProvider } from './ledger-bank.provider.js';
import { MemoryLedgerStore, SqliteLedgerStore, type LedgerStore } from './ledger-store.js';
import { MockBankProvider } from './mock-bank.provider.js';
import type { BankProvider } from './types.js';

export function createBankProvider(cfg: AppConfig): { bank: BankProvider; store: LedgerStore } {
  if (cfg.BANK_PROVIDER === 'http') {
    // Ngân hàng giữ sổ cái; SQLite chỉ lưu bản ghi webhook "báo có" để tool tra cứu lại.
    const store = new SqliteLedgerStore(cfg.LEDGER_DB_FILE);
    const bank = new HttpBankProvider({
      baseUrl: cfg.BANK_API_BASE_URL!,
      apiKey: cfg.BANK_API_KEY!,
      ...(cfg.BANK_API_SECRET ? { apiSecret: cfg.BANK_API_SECRET } : {}),
      timeoutMs: cfg.BANK_API_TIMEOUT_MS,
      allowInsecure: cfg.BANK_API_ALLOW_INSECURE,
      incomingStore: store,
    });
    return { bank, store };
  }
  if (cfg.BANK_PROVIDER === 'local') {
    const store = new SqliteLedgerStore(cfg.LEDGER_DB_FILE);
    return { bank: new LedgerBankProvider(store, { name: 'local', bankCode: 'TCXLOCAL' }), store };
  }
  const store = new MemoryLedgerStore();
  return { bank: new MockBankProvider(), store };
}

export type { BankProvider } from './types.js';
export { MockBankProvider } from './mock-bank.provider.js';
export { LedgerBankProvider } from './ledger-bank.provider.js';
export { HttpBankProvider } from './http-bank.provider.js';
export { MemoryLedgerStore, SqliteLedgerStore } from './ledger-store.js';
