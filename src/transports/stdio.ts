import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AuditLogger } from '../audit/audit-log.js';
import { parseApiKey } from '../auth/api-key.js';
import type { ApiKeyStore } from '../auth/api-key.store.js';
import { authenticate, type Principal } from '../auth/authenticate.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import type { BankProvider } from '../bank/types.js';
import { APP_NAME, type AppConfig } from '../config.js';
import { AuthError } from '../errors.js';
import { createBankMcpServer } from '../server.js';

export interface StdioDeps {
  store: ApiKeyStore;
  audit: AuditLogger;
  rateLimiter: RateLimiter;
  bank: BankProvider;
}

export async function runStdio(cfg: AppConfig, deps: StdioDeps): Promise<void> {
  const raw = cfg.BANK_MCP_API_KEY;
  let principal: Principal;
  try {
    principal = authenticate(deps.store, raw, { defaultRateLimitPerMinute: cfg.RATE_LIMIT_PER_MINUTE });
  } catch (err) {
    const reason = err instanceof AuthError ? err.reason : 'unknown';
    deps.audit.log({
      transport: 'stdio',
      keyId: parseApiKey(raw)?.id ?? null,
      keyName: null,
      event: 'auth',
      outcome: 'denied',
      code: 'UNAUTHENTICATED',
      reason,
    });
    process.stderr.write(`[${APP_NAME}] TỪ CHỐI: BANK_MCP_API_KEY không hợp lệ (${reason}). Cấp key bằng: npm run keys -- create ...\n`);
    process.exit(2);
  }

  deps.audit.log({ transport: 'stdio', keyId: principal.keyId, keyName: principal.name, event: 'auth', outcome: 'success' });
  const server = createBankMcpServer({
    principal,
    bank: deps.bank,
    audit: deps.audit,
    rateLimiter: deps.rateLimiter,
    transport: 'stdio',
    maxTransferAmount: cfg.MAX_TRANSFER_AMOUNT_VND,
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[${APP_NAME}] stdio sẵn sàng - key="${principal.name}" scopes=[${principal.scopes.join(', ')}] provider=${deps.bank.name}\n`);
}
