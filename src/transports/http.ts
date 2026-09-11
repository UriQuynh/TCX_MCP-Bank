import { randomUUID } from 'node:crypto';
import type { Server as NodeHttpServer } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation, localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AuditLogger } from '../audit/audit-log.js';
import { parseApiKey } from '../auth/api-key.js';
import type { ApiKeyStore } from '../auth/api-key.store.js';
import { authenticate, extractBearer, type Principal } from '../auth/authenticate.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import type { BankProvider } from '../bank/types.js';
import { APP_NAME, APP_VERSION, LOOPBACK_HOSTS, type AppConfig } from '../config.js';
import { AuthError } from '../errors.js';
import { createBankMcpServer } from '../server.js';
import { handleIncomingPaymentWebhook } from '../webhooks/incoming-payment.js';

export interface HttpDeps {
  store: ApiKeyStore;
  audit: AuditLogger;
  rateLimiter: RateLimiter;
  bank: BankProvider;
  fetchImpl?: typeof fetch;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  keyId: string;
  lastActive: number;
}

const AUTH_FAIL_PER_MINUTE_PER_IP = 30;
const WEBHOOK_PER_MINUTE_PER_IP = 300;

function headerStr(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export function createHttpApp(cfg: AppConfig, deps: HttpDeps) {
  const app = express();
  const sessions = new Map<string, Session>();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Đăng ký TRƯỚC hostHeaderValidation: /health cố tình public, không lộ dữ liệu
  // (dùng cho Docker HEALTHCHECK/monitoring gọi thẳng qua 127.0.0.1, Host header
  // không khớp MCP_ALLOWED_HOSTS — nếu đặt sau middleware này sẽ luôn bị 403).
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', name: APP_NAME, version: APP_VERSION, provider: deps.bank.name });
  });

  if (cfg.MCP_ALLOWED_HOSTS.length) app.use(hostHeaderValidation(cfg.MCP_ALLOWED_HOSTS));
  else if (LOOPBACK_HOSTS.includes(cfg.MCP_HTTP_HOST)) app.use(localhostHostValidation());

  // Server không tự làm TLS: khi bắt buộc HTTPS, chỉ chấp nhận request đã qua proxy TLS (X-Forwarded-Proto: https).
  const requireHttps = (req: Request, res: Response, next: NextFunction): void => {
    if (cfg.MCP_REQUIRE_HTTPS && req.protocol !== 'https') {
      rpcError(res, 403, -32003, 'HTTPS bắt buộc: đặt server sau reverse proxy TLS (nginx) và forward X-Forwarded-Proto');
      return;
    }
    next();
  };

  const authMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = req.ip ?? 'unknown';
    const raw = extractBearer(req.headers.authorization) ?? headerStr(req.headers['x-api-key']);
    try {
      const principal = authenticate(deps.store, raw, { defaultRateLimitPerMinute: cfg.RATE_LIMIT_PER_MINUTE });
      res.locals.principal = principal;
      (req as Request & { auth?: unknown }).auth = { token: '[redacted]', clientId: principal.keyId, scopes: principal.scopes };
      next();
    } catch (err) {
      const reason = err instanceof AuthError ? err.reason : 'unknown';
      deps.audit.log({ transport: 'http', keyId: parseApiKey(raw)?.id ?? null, keyName: null, event: 'auth', outcome: 'denied', code: 'UNAUTHENTICATED', reason, remoteIp: ip });
      const rl = await deps.rateLimiter.check(`authfail:${ip}`, AUTH_FAIL_PER_MINUTE_PER_IP);
      if (!rl.allowed) {
        res.set('Retry-After', String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)));
        rpcError(res, 429, -32029, 'Quá nhiều lần xác thực thất bại');
        return;
      }
      res.set('WWW-Authenticate', `Bearer realm="${APP_NAME}"`);
      rpcError(res, 401, -32001, 'Unauthorized: API key không hợp lệ hoặc bị từ chối');
    }
  };

  const requireSession = (req: Request, res: Response, principal: Principal): Session | null => {
    const sid = headerStr(req.headers['mcp-session-id']);
    if (!sid) {
      rpcError(res, 400, -32000, 'Bad Request: thiếu header Mcp-Session-Id');
      return null;
    }
    const s = sessions.get(sid);
    if (!s) {
      rpcError(res, 404, -32001, 'Session không tồn tại hoặc đã hết hạn');
      return null;
    }
    if (s.keyId !== principal.keyId) {
      deps.audit.log({ transport: 'http', keyId: principal.keyId, keyName: principal.name, sessionId: sid, event: 'auth', outcome: 'denied', code: 'PERMISSION_DENIED', reason: 'session_key_mismatch', remoteIp: req.ip ?? 'unknown' });
      rpcError(res, 403, -32003, 'Forbidden: session thuộc về API key khác');
      return null;
    }
    s.lastActive = Date.now();
    return s;
  };

  app.post('/mcp', requireHttps, authMiddleware, express.json({ limit: '256kb' }), async (req, res) => {
    const principal = res.locals.principal as Principal;
    const sid = headerStr(req.headers['mcp-session-id']);
    if (sid) {
      const s = requireSession(req, res, principal);
      if (s) await s.transport.handleRequest(req, res, req.body);
      return;
    }
    if (!isInitializeRequest(req.body)) {
      rpcError(res, 400, -32000, 'Bad Request: cần initialize trước hoặc thiếu Mcp-Session-Id');
      return;
    }
    const sessionRef: { id?: string } = {};
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessionRef.id = id;
        sessions.set(id, { transport, keyId: principal.keyId, lastActive: Date.now() });
        deps.audit.log({ transport: 'http', keyId: principal.keyId, keyName: principal.name, sessionId: id, event: 'auth', outcome: 'success', remoteIp: req.ip ?? 'unknown' });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = createBankMcpServer({
      principal,
      bank: deps.bank,
      audit: deps.audit,
      rateLimiter: deps.rateLimiter,
      transport: 'http',
      maxTransferAmount: cfg.MAX_TRANSFER_AMOUNT_VND,
      sessionRef,
      ...(req.ip ? { remoteIp: req.ip } : {}),
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', requireHttps, authMiddleware, async (req, res) => {
    const s = requireSession(req, res, res.locals.principal as Principal);
    if (s) await s.transport.handleRequest(req, res);
  });

  app.delete('/mcp', requireHttps, authMiddleware, async (req, res) => {
    const s = requireSession(req, res, res.locals.principal as Principal);
    if (s) await s.transport.handleRequest(req, res);
  });

  // Webhook "báo có" từ ngân hàng: xác thực bằng HMAC + timestamp, không dùng API key MCP.
  app.post('/webhooks/bank/incoming', requireHttps, express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
    if (!cfg.BANK_WEBHOOK_SECRET) {
      res.status(404).json({ ok: false, error: { code: 'NOT_SUPPORTED', message: 'Webhook chưa được bật (thiếu BANK_WEBHOOK_SECRET)' } });
      return;
    }
    const ip = req.ip ?? 'unknown';
    const rl = await deps.rateLimiter.check(`webhook:${ip}`, WEBHOOK_PER_MINUTE_PER_IP);
    if (!rl.allowed) {
      res.set('Retry-After', String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)));
      res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED', message: 'Quá nhiều webhook' } });
      return;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await handleIncomingPaymentWebhook(
      raw,
      { timestamp: headerStr(req.headers['x-bank-timestamp']), signature: headerStr(req.headers['x-bank-signature']) },
      {
        bank: deps.bank,
        audit: deps.audit,
        verify: { secret: cfg.BANK_WEBHOOK_SECRET, toleranceSec: cfg.BANK_WEBHOOK_TOLERANCE_SEC },
        ...(cfg.INCOMING_PAYMENT_FORWARD_URL && cfg.INCOMING_PAYMENT_FORWARD_SECRET
          ? {
              forward: {
                url: cfg.INCOMING_PAYMENT_FORWARD_URL,
                secret: cfg.INCOMING_PAYMENT_FORWARD_SECRET,
                // Cùng cờ sandbox dùng cho HttpBankProvider (vá audit vòng 9) —
                // không thêm biến env riêng cho 1 guard cùng mục đích.
                allowInsecure: cfg.BANK_API_ALLOW_INSECURE,
                ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
              },
            }
          : {}),
        remoteIp: ip,
      },
    );
    res.status(result.status).json(result.body);
  });

  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      rpcError(res, err.status ?? 400, -32700, 'Parse error: body không hợp lệ hoặc quá lớn');
      return;
    }
    process.stderr.write(`[${APP_NAME}] http error: ${err.message}\n`);
    rpcError(res, 500, -32603, 'Internal error');
  });

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - cfg.MCP_SESSION_TTL_MS;
    for (const [id, s] of sessions) {
      if (s.lastActive < cutoff) {
        sessions.delete(id);
        void s.transport.close();
      }
    }
  }, 60_000);
  sweeper.unref();

  const closeAll = async (): Promise<void> => {
    clearInterval(sweeper);
    await Promise.all([...sessions.values()].map((s) => s.transport.close().catch(() => undefined)));
    sessions.clear();
  };

  return { app, closeAll, sessionCount: () => sessions.size };
}

export async function runHttp(cfg: AppConfig, deps: HttpDeps): Promise<NodeHttpServer> {
  const { app, closeAll } = createHttpApp(cfg, deps);
  const server = app.listen(cfg.MCP_HTTP_PORT, cfg.MCP_HTTP_HOST, () => {
    process.stderr.write(
      `[${APP_NAME}] http sẵn sàng tại http://${cfg.MCP_HTTP_HOST}:${cfg.MCP_HTTP_PORT}/mcp provider=${deps.bank.name} require_https=${cfg.MCP_REQUIRE_HTTPS} webhook=${cfg.BANK_WEBHOOK_SECRET ? 'on' : 'off'}\n`,
    );
  });
  const shutdown = () => {
    void closeAll().finally(() => server.close(() => process.exit(0)));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}
