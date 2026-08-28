import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AuditOutcome = 'success' | 'error' | 'denied';

export interface AuditEntry {
  id: string;
  ts: string;
  transport: 'stdio' | 'http' | 'test';
  keyId: string | null;
  keyName: string | null;
  sessionId?: string;
  event: 'auth' | 'tool' | 'webhook' | 'forward';
  tool?: string;
  params?: Record<string, unknown>;
  outcome: AuditOutcome;
  code?: string;
  reason?: string;
  durationMs?: number;
  remoteIp?: string;
}

const REDACT_KEY_RE = /(secret|token|password|passcode|pin|authorization|api[_-]?key)/i;
const MASK_KEY_RE = /(account_number|account_no|acct)/i;

export function redactParams(input: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(input)) return input.map((v) => redactParams(v, depth + 1));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (REDACT_KEY_RE.test(k)) out[k] = '[REDACTED]';
      else if (MASK_KEY_RE.test(k) && typeof v === 'string') out[k] = maskTail(v);
      else out[k] = redactParams(v, depth + 1);
    }
    return out;
  }
  if (typeof input === 'string' && input.length > 500) return `${input.slice(0, 500)}…[${input.length}]`;
  return input;
}

function maskTail(v: string): string {
  if (v.length <= 4) return '*'.repeat(v.length);
  return `${'*'.repeat(v.length - 4)}${v.slice(-4)}`;
}

export interface AuditLoggerOptions {
  filePath?: string | null;
  // stdio transport dùng stdout làm kênh giao thức -> log chỉ được ra stderr
  stderr?: boolean;
}

export class AuditLogger {
  private dirReady = false;

  constructor(private readonly opts: AuditLoggerOptions = {}) {}

  log(entry: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry {
    const full: AuditEntry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      ...entry,
      params: entry.params ? (redactParams(entry.params) as Record<string, unknown>) : undefined,
    };
    const line = `${JSON.stringify(full)}\n`;
    if (this.opts.filePath) {
      try {
        if (!this.dirReady) {
          mkdirSync(dirname(this.opts.filePath), { recursive: true, mode: 0o700 });
          this.dirReady = true;
        }
        appendFileSync(this.opts.filePath, line, { mode: 0o600 });
      } catch (err) {
        process.stderr.write(`[audit] ghi file thất bại: ${(err as Error).message}\n`);
      }
    }
    if (this.opts.stderr) process.stderr.write(line);
    return full;
  }
}
