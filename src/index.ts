#!/usr/bin/env node
import { Redis } from 'ioredis';
import { AuditLogger } from './audit/audit-log.js';
import { FileApiKeyStore } from './auth/api-key.store.js';
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from './auth/rate-limit.js';
import { createBankProvider } from './bank/index.js';
import { APP_NAME, loadConfig } from './config.js';
import { runHttp } from './transports/http.js';
import { runStdio } from './transports/stdio.js';

function createRateLimiter(url: string | undefined, failOpen: boolean): RateLimiter {
  if (!url) return new MemoryRateLimiter();
  const redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  redis.on('error', (e: Error) => process.stderr.write(`[${APP_NAME}] redis: ${e.message}\n`));
  return new RedisRateLimiter(redis, { failOpen });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { bank, store } = createBankProvider(cfg);
  const deps = {
    store: new FileApiKeyStore(cfg.API_KEYS_FILE),
    audit: new AuditLogger({ filePath: cfg.AUDIT_LOG_FILE, stderr: true }),
    rateLimiter: createRateLimiter(cfg.REDIS_URL, cfg.RATE_LIMIT_FAIL_OPEN),
    bank,
  };
  process.once('exit', () => store.close());
  if (cfg.MCP_TRANSPORT === 'http') await runHttp(cfg, deps);
  else await runStdio(cfg, deps);
}

main().catch((err) => {
  process.stderr.write(`[${APP_NAME}] khởi động thất bại: ${(err as Error).message}\n`);
  process.exit(1);
});
