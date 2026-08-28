import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLogger } from '../src/audit/audit-log.js';
import { MemoryRateLimiter } from '../src/auth/rate-limit.js';
import { MockBankProvider } from '../src/bank/mock-bank.provider.js';
import { loadConfig } from '../src/config.js';
import { createHttpApp } from '../src/transports/http.js';
import { makeKey, makeStore } from './helpers.js';
import { createHmac } from 'node:crypto';

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};
const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('http transport auth', () => {
  const a = makeKey('key-a', ['wallet:read']);
  const b = makeKey('key-b', ['wallet:read']);
  let server: Server;
  let base: string;
  let closeAll: () => Promise<void>;

  const bank = new MockBankProvider();
  const forwarded: unknown[] = [];

  beforeAll(async () => {
    const cfg = loadConfig({
      MCP_TRANSPORT: 'http',
      MCP_HTTP_PORT: '0',
      API_KEYS_FILE: '/dev/null',
      BANK_WEBHOOK_SECRET: 'whsec_test',
      INCOMING_PAYMENT_FORWARD_URL: 'https://backend.example/hook',
      INCOMING_PAYMENT_FORWARD_SECRET: 'fwd_test',
    });
    const built = createHttpApp(cfg, {
      store: makeStore(a.record, b.record),
      audit: new AuditLogger({ filePath: null, stderr: false }),
      rateLimiter: new MemoryRateLimiter(),
      bank,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        forwarded.push(JSON.parse(String(init?.body)));
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch,
    });
    closeAll = built.closeAll;
    server = await new Promise<Server>((resolve) => {
      const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await closeAll();
    await new Promise((r) => server.close(r));
  });

  it('health is public', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect((((await r.json()) as any)).provider).toBe('mock');
  });

  it('401 without key, 401 with bad key', async () => {
    const r1 = await fetch(`${base}/mcp`, { method: 'POST', headers: HEADERS, body: JSON.stringify(INIT) });
    expect(r1.status).toBe(401);
    expect(r1.headers.get('www-authenticate')).toMatch(/Bearer/);
    const r2 = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...HEADERS, authorization: 'Bearer tcxb_bad' }, body: JSON.stringify(INIT) });
    expect(r2.status).toBe(401);
  });

  it('initializes with valid key, binds session to that key', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...HEADERS, authorization: `Bearer ${a.plaintext}` }, body: JSON.stringify(INIT) });
    expect(r.status).toBe(200);
    const sid = r.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    await r.text();

    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    const ok = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS, 'x-api-key': a.plaintext, 'mcp-session-id': sid! },
      body: JSON.stringify(list),
    });
    expect(ok.status).toBe(200);
    const body = ((await ok.json()) as any);
    expect(body.result.tools.map((t: any) => t.name)).toContain('bank_get_balance');
    expect(body.result.tools.map((t: any) => t.name)).not.toContain('bank_transfer');

    const hijack = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${b.plaintext}`, 'mcp-session-id': sid! },
      body: JSON.stringify(list),
    });
    expect(hijack.status).toBe(403);

    const unknownSession = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${a.plaintext}`, 'mcp-session-id': 'does-not-exist' },
      body: JSON.stringify(list),
    });
    expect(unknownSession.status).toBe(404);
  });

  it('non-initialize request without session is 400', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${a.plaintext}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    expect(r.status).toBe(400);
  });
});

describe('incoming payment webhook + https guard', () => {
  const sign = (secret: string, ts: string, body: string) => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

  it('rejects bad signature / stale timestamp, applies valid event once, forwards it', async () => {
    const bank = new MockBankProvider();
    const forwarded: any[] = [];
    const cfg = loadConfig({ MCP_TRANSPORT: 'http', API_KEYS_FILE: '/dev/null', BANK_WEBHOOK_SECRET: 'whsec_test', INCOMING_PAYMENT_FORWARD_URL: 'https://backend.example/hook', INCOMING_PAYMENT_FORWARD_SECRET: 'fwd_test' });
    const built = createHttpApp(cfg, {
      store: makeStore(),
      audit: new AuditLogger({ filePath: null, stderr: false }),
      rateLimiter: new MemoryRateLimiter(),
      bank,
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        forwarded.push({ headers: init?.headers, body: JSON.parse(String(init?.body)) });
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch,
    });
    const server = await new Promise<Server>((resolve) => { const s = built.app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const w = await bank.createWallet({ owner_ref: 'u1', owner_name: 'A' });
      const body = JSON.stringify({ event_id: 'bank-evt-100', account_number: w.account_number, amount: 120_000, description: 'CK don 55', payer_name: 'Khach' });
      const ts = String(Math.floor(Date.now() / 1000));
      const url = `${base}/webhooks/bank/incoming`;

      const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bank-timestamp': ts, 'x-bank-signature': 'f'.repeat(64) }, body });
      expect(bad.status).toBe(401);
      const stale = String(Math.floor(Date.now() / 1000) - 3600);
      const old = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bank-timestamp': stale, 'x-bank-signature': sign('whsec_test', stale, body) }, body });
      expect(old.status).toBe(401);
      expect((await bank.getBalance(w.id)).balance).toBe(0);

      const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bank-timestamp': ts, 'x-bank-signature': sign('whsec_test', ts, body) }, body });
      expect(ok.status).toBe(200);
      const j = ((await ok.json()) as any);
      expect(j.applied).toBe(true);
      expect(j.duplicate).toBe(false);
      expect((await bank.getBalance(w.id)).balance).toBe(120_000);

      const again = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bank-timestamp': ts, 'x-bank-signature': sign('whsec_test', ts, body) }, body });
      expect((((await again.json()) as any)).duplicate).toBe(true);
      expect((await bank.getBalance(w.id)).balance).toBe(120_000);

      await new Promise((r) => setTimeout(r, 50));
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].body.data.event_id).toBe('bank-evt-100');
      const h = forwarded[0].headers as Record<string, string>;
      expect(h['X-TCX-Signature']).toBe(sign('fwd_test', h['X-TCX-Timestamp']!, JSON.stringify(forwarded[0].body)));

      const invalid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bank-timestamp': ts, 'x-bank-signature': sign('whsec_test', ts, '{"amount":-1}') }, body: '{"amount":-1}' });
      expect(invalid.status).toBe(400);
    } finally {
      await built.closeAll();
      await new Promise((r) => server.close(r));
    }
  });

  it('webhook disabled without secret -> 404', async () => {
    const cfg = loadConfig({ MCP_TRANSPORT: 'http', API_KEYS_FILE: '/dev/null' });
    const built = createHttpApp(cfg, { store: makeStore(), audit: new AuditLogger({ filePath: null, stderr: false }), rateLimiter: new MemoryRateLimiter(), bank: new MockBankProvider() });
    const server = await new Promise<Server>((resolve) => { const s = built.app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const r = await fetch(`${base}/webhooks/bank/incoming`, { method: 'POST', body: '{}' });
      expect(r.status).toBe(404);
    } finally {
      await built.closeAll();
      await new Promise((r) => server.close(r));
    }
  });

  it('MCP_REQUIRE_HTTPS defaults on for non-loopback bind and blocks plain http', async () => {
    const cfg = loadConfig({ MCP_TRANSPORT: 'http', API_KEYS_FILE: '/dev/null', MCP_HTTP_HOST: '0.0.0.0', MCP_ALLOWED_HOSTS: '127.0.0.1' });
    expect(cfg.MCP_REQUIRE_HTTPS).toBe(true);
    const built = createHttpApp(cfg, { store: makeStore(), audit: new AuditLogger({ filePath: null, stderr: false }), rateLimiter: new MemoryRateLimiter(), bank: new MockBankProvider() });
    const server = await new Promise<Server>((resolve) => { const s = built.app.listen(0, '127.0.0.1', () => resolve(s)); });
    const port = (server.address() as { port: number }).port;
    try {
      const plain = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' }, body: '{}' });
      expect(plain.status).toBe(403);
      const viaProxy = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: '{}' });
      expect(viaProxy.status).toBe(401);
      expect(loadConfig({ MCP_TRANSPORT: 'http', API_KEYS_FILE: '/dev/null' }).MCP_REQUIRE_HTTPS).toBe(false);
    } finally {
      await built.closeAll();
      await new Promise((r) => server.close(r));
    }
  });
});
