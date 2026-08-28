import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuditLogger, type AuditEntry } from '../src/audit/audit-log.js';
import { generateApiKey, hashSecret } from '../src/auth/api-key.js';
import { MemoryApiKeyStore, type ApiKeyRecord } from '../src/auth/api-key.store.js';
import type { Principal } from '../src/auth/authenticate.js';
import { MemoryRateLimiter, type RateLimiter } from '../src/auth/rate-limit.js';
import type { Scope } from '../src/auth/scopes.js';
import { MockBankProvider } from '../src/bank/mock-bank.provider.js';
import type { BankProvider } from '../src/bank/types.js';
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

// Fake audit (own type): gom entry để assert, không ghi file/stderr.
export class CollectingAudit extends AuditLogger {
  readonly entries: AuditEntry[] = [];
  constructor() {
    super({ filePath: null, stderr: false });
  }
  override log(entry: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry {
    const full = super.log(entry);
    this.entries.push(full);
    return full;
  }
}

export interface ConnectOptions {
  bank?: BankProvider;
  rateLimiter?: RateLimiter;
  maxTransfer?: number;
  audit?: AuditLogger;
  sessionRef?: { id?: string };
  remoteIp?: string;
}

export async function connectClient(principal: Principal, opts: ConnectOptions = {}) {
  const bank = opts.bank ?? new MockBankProvider();
  const server = createBankMcpServer({
    principal,
    bank,
    audit: opts.audit ?? new AuditLogger({ filePath: null, stderr: false }),
    rateLimiter: opts.rateLimiter ?? new MemoryRateLimiter(),
    transport: 'test',
    maxTransferAmount: opts.maxTransfer ?? 500_000_000,
    ...(opts.sessionRef ? { sessionRef: opts.sessionRef } : {}),
    ...(opts.remoteIp ? { remoteIp: opts.remoteIp } : {}),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientT);
  return { client, server, bank: bank as MockBankProvider };
}

// callTool trả union type (content | toolResult) -> nhận unknown rồi ép kiểu, tránh weak-type check của TS.
type TextContent = Array<{ type: string; text: string }>;
export function parseResult(r: unknown): { ok: boolean; data?: any; error?: { code: string; message: string; details?: any } } {
  const c = ((r as { content?: TextContent }).content ?? [])[0]!;
  return JSON.parse(c.text);
}

export function textOf(r: unknown): string {
  return ((r as { content?: TextContent }).content ?? []).map((c) => c.text).join('\n');
}
