import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuditLogger } from '../src/audit/audit-log.js';
import { generateApiKey, hashSecret } from '../src/auth/api-key.js';
import { MemoryApiKeyStore, type ApiKeyRecord } from '../src/auth/api-key.store.js';
import type { Principal } from '../src/auth/authenticate.js';
import { MemoryRateLimiter } from '../src/auth/rate-limit.js';
import type { Scope } from '../src/auth/scopes.js';
import { MockBankProvider } from '../src/bank/mock-bank.provider.js';
import { createBankMcpServer } from '../src/server.js';

export function makeKey(name: string, scopes: string[], extra: Partial<ApiKeyRecord> = {}) {
  const gen = generateApiKey();
  const record: ApiKeyRecord = {
    id: gen.id,
    name,
    secretHash: hashSecret(gen.secret),
    scopes,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    rateLimitPerMinute: null,
    ...extra,
  };
  return { plaintext: gen.plaintext, record };
}

export function makeStore(...keys: ApiKeyRecord[]) {
  return new MemoryApiKeyStore(keys);
}

export function makePrincipal(scopes: Scope[], rate = 1000): Principal {
  return { keyId: 'abcdefabcdef', name: 'test', scopes, rateLimitPerMinute: rate };
}

export async function connectClient(principal: Principal, opts: { bank?: MockBankProvider; rateLimiter?: MemoryRateLimiter; maxTransfer?: number } = {}) {
  const bank = opts.bank ?? new MockBankProvider();
  const server = createBankMcpServer({
    principal,
    bank,
    audit: new AuditLogger({ filePath: null, stderr: false }),
    rateLimiter: opts.rateLimiter ?? new MemoryRateLimiter(),
    transport: 'test',
    maxTransferAmount: opts.maxTransfer ?? 500_000_000,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientT);
  return { client, server, bank };
}

export function parseResult(r: { content: unknown; isError?: boolean }): { ok: boolean; data?: any; error?: { code: string; message: string; details?: any } } {
  const c = (r.content as Array<{ type: string; text: string }>)[0]!;
  return JSON.parse(c.text);
}

export function textOf(r: { content: unknown }): string {
  return (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');
}
