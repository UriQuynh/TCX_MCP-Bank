import { createHmac } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger } from '../src/audit/audit-log.js';
import { MemoryRateLimiter, type RateLimiter } from '../src/auth/rate-limit.js';
import { MockBankProvider } from '../src/bank/mock-bank.provider.js';
import { loadConfig } from '../src/config.js';
import { createHttpApp, type HttpDeps } from '../src/transports/http.js';
import { makeKey, makeStore } from './helpers.js';

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function startApp(env: Record<string, string> = {}, deps: Partial<HttpDeps> = {}) {
  const cfg = loadConfig({ MCP_TRANSPORT: 'http', API_KEYS_FILE: '/dev/null', ...env });
  const built = createHttpApp(cfg, {
    store: makeStore(),
    audit: new AuditLogger({ filePath: null, stderr: false }),
    rateLimiter: new MemoryRateLimiter(),
    bank: new MockBankProvider(),
    ...deps,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = async () => {
    await built.closeAll();
    await new Promise((r) => server.close(r));
  };
  return { base, close, cfg, sessionCount: built.sessionCount };
}

async function initSession(base: string, key: string) {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, authorization: `Bearer ${key}` }, body: JSON.stringify(INIT) });
  await r.text();
  return r.headers.get('mcp-session-id')!;
}

afterEach(() => vi.useRealTimers());

describe('http transport - abuse controls', () => {
  it('30 failed authentications from one IP -> 31st gets 429 with Retry-After', async () => {
    const { base, close } = await startApp();
    try {
      for (let i = 0; i < 30; i++) {
        const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, authorization: 'Bearer tcxb_bad' }, body: JSON.stringify(INIT) });
        expect(r.status).toBe(401);
      }
      const blocked = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, authorization: 'Bearer tcxb_bad' }, body: JSON.stringify(INIT) });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it('webhook rate-limited by limiter -> 429 RATE_LIMITED', async () => {
    const denyWebhooks: RateLimiter = { check: async (key) => (key.startsWith('webhook:') ? { allowed: false, retryAfterMs: 1000 } : { allowed: true }) };
    const { base, close } = await startApp({ BANK_WEBHOOK_SECRET: 'whsec' }, { rateLimiter: denyWebhooks });
    try {
      const r = await fetch(`${base}/webhooks/bank/incoming`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(429);
      expect((((await r.json()) as any)).error.code).toBe('RATE_LIMITED');
      expect(r.headers.get('retry-after')).toBe('1');
    } finally {
      await close();
    }
  });
});

describe('http transport - session & body handling', () => {
  const key = makeKey('k', ['wallet:read']);

  it('GET /mcp without session -> 400', async () => {
    const { base, close } = await startApp({}, { store: makeStore(key.record) });
    try {
      const r = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${key.plaintext}`, accept: 'text/event-stream' } });
      expect(r.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('DELETE /mcp with session -> session closed and removed', async () => {
    const { base, close, sessionCount } = await startApp({}, { store: makeStore(key.record) });
    try {
      const sid = await initSession(base, key.plaintext);
      expect(sessionCount()).toBe(1);
      const r = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${key.plaintext}`, 'mcp-session-id': sid } });
      expect(r.status).toBe(200);
      expect(sessionCount()).toBe(0);
    } finally {
      await close();
    }
  });

  it('malformed JSON body -> 400 with JSON-RPC parse error -32700', async () => {
    const { base, close } = await startApp({}, { store: makeStore(key.record) });
    try {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, authorization: `Bearer ${key.plaintext}` }, body: '{bad' });
      expect(r.status).toBe(400);
      expect((((await r.json()) as any)).error.code).toBe(-32700);
    } finally {
      await close();
    }
  });

  it('body over 256kb -> 413', async () => {
    const { base, close } = await startApp({}, { store: makeStore(key.record) });
    try {
      const big = JSON.stringify({ ...INIT, pad: 'x'.repeat(300_000) });
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, authorization: `Bearer ${key.plaintext}` }, body: big });
      expect(r.status).toBe(413);
      expect((((await r.json()) as any)).error.code).toBe(-32700);
    } finally {
      await close();
    }
  });

  it('Host header not in MCP_ALLOWED_HOSTS -> 403 Invalid Host', async () => {
    const { base, close } = await startApp({ MCP_HTTP_HOST: '0.0.0.0', MCP_ALLOWED_HOSTS: 'mcp.example', MCP_REQUIRE_HTTPS: 'false' });
    try {
      const bad = await fetch(`${base}/health`);
      expect(bad.status).toBe(403);
      expect((((await bad.json()) as any)).error.message).toMatch(/Invalid Host/);
      // fetch/undici không cho ghi đè Host -> dùng node:http để gửi Host hợp lệ
      const goodStatus = await new Promise<number>((resolve, reject) => {
        const u = new URL(`${base}/health`);
        httpRequest({ host: u.hostname, port: u.port, path: '/health', headers: { Host: 'mcp.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on('error', reject)
          .end();
      });
      expect(goodStatus).toBe(200);
    } finally {
      await close();
    }
  });

  it('MCP_REQUIRE_HTTPS also guards the webhook route -> 403 without X-Forwarded-Proto', async () => {
    const { base, close } = await startApp({ MCP_HTTP_HOST: '0.0.0.0', MCP_ALLOWED_HOSTS: '127.0.0.1', BANK_WEBHOOK_SECRET: 'whsec' });
    try {
      const body = '{"event_id":"e","account_number":"123456","amount":1}';
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', 'whsec').update(`${ts}.${body}`).digest('hex');
      const r = await fetch(`${base}/webhooks/bank/incoming`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bank-timestamp': ts, 'x-bank-signature': sig }, body });
      expect(r.status).toBe(403);
    } finally {
      await close();
    }
  });

  it('idle session is swept after MCP_SESSION_TTL_MS', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { base, close, sessionCount } = await startApp({ MCP_SESSION_TTL_MS: '1000' }, { store: makeStore(key.record) });
    try {
      await initSession(base, key.plaintext);
      expect(sessionCount()).toBe(1);
      vi.advanceTimersByTime(61_000);
      expect(sessionCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await close();
    }
  });
});
