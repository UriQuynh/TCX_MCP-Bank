import { z } from 'zod';

export const APP_NAME = 'tcx-mcp-bank';
export const APP_VERSION = '0.1.0';

const boolish = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim().toLowerCase() === 'true');

const intEnv = (def: number, min = 1) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_HTTP_HOST: z.string().default('127.0.0.1'),
  MCP_HTTP_PORT: intEnv(3020, 0),
  MCP_ALLOWED_HOSTS: csv,
  MCP_SESSION_TTL_MS: intEnv(30 * 60 * 1000, 1000),
  BANK_MCP_API_KEY: z.string().optional(),
  API_KEYS_FILE: z.string().default('./data/api-keys.json'),
  AUDIT_LOG_FILE: z.string().default('./data/audit.log'),
  RATE_LIMIT_PER_MINUTE: intEnv(60),
  BANK_PROVIDER: z.enum(['mock', 'local', 'http']).default('mock'),
  LEDGER_DB_FILE: z.string().default('./data/ledger.sqlite'),
  REDIS_URL: z.string().optional(),
  RATE_LIMIT_FAIL_OPEN: boolish,
  MCP_REQUIRE_HTTPS: z.string().optional(),
  BANK_WEBHOOK_SECRET: z.string().optional(),
  BANK_WEBHOOK_TOLERANCE_SEC: intEnv(300, 10),
  INCOMING_PAYMENT_FORWARD_URL: z.string().optional(),
  INCOMING_PAYMENT_FORWARD_SECRET: z.string().optional(),
  BANK_API_BASE_URL: z.string().optional(),
  BANK_API_KEY: z.string().optional(),
  BANK_API_SECRET: z.string().optional(),
  BANK_API_TIMEOUT_MS: intEnv(10_000, 100),
  BANK_API_ALLOW_INSECURE: boolish,
  MAX_TRANSFER_AMOUNT_VND: intEnv(500_000_000),
});

export type AppConfig = Omit<z.infer<typeof envSchema>, 'MCP_REQUIRE_HTTPS'> & { MCP_REQUIRE_HTTPS: boolean };

export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Cấu hình env không hợp lệ: ${msg}`);
  }
  const raw = parsed.data;
  // Mặc định fail-closed: bind ra ngoài loopback thì bắt buộc đi sau proxy TLS.
  const requireHttps =
    raw.MCP_REQUIRE_HTTPS === undefined || raw.MCP_REQUIRE_HTTPS === ''
      ? !LOOPBACK_HOSTS.includes(raw.MCP_HTTP_HOST)
      : raw.MCP_REQUIRE_HTTPS.trim().toLowerCase() === 'true';
  const cfg: AppConfig = { ...raw, MCP_REQUIRE_HTTPS: requireHttps };
  if (cfg.INCOMING_PAYMENT_FORWARD_URL && !cfg.INCOMING_PAYMENT_FORWARD_SECRET) {
    throw new Error('INCOMING_PAYMENT_FORWARD_URL yêu cầu INCOMING_PAYMENT_FORWARD_SECRET');
  }
  if (cfg.BANK_PROVIDER === 'http') {
    if (!cfg.BANK_API_BASE_URL) throw new Error('BANK_PROVIDER=http yêu cầu BANK_API_BASE_URL');
    if (!cfg.BANK_API_KEY) throw new Error('BANK_PROVIDER=http yêu cầu BANK_API_KEY');
  }
  return cfg;
}
