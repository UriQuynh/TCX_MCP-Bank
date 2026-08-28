import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, redactParams } from '../src/audit/audit-log.js';

const dir = mkdtempSync(join(tmpdir(), 'tcx-audit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

describe('AuditLogger.log', () => {
  it('with filePath -> appends exactly one JSON line with redacted params and generated id/ts', () => {
    const file = join(dir, 'audit.log');
    const logger = new AuditLogger({ filePath: file, stderr: false });
    const returned = logger.log({ transport: 'test', keyId: 'k1', keyName: 'svc', event: 'tool', tool: 'bank_transfer', params: { api_key: 'plain', amount: 5 }, outcome: 'success' });
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.params).toEqual({ api_key: '[REDACTED]', amount: 5 });
    expect(parsed.id).toBe(returned.id);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('unwritable filePath -> warns on stderr and does not throw', () => {
    const notADir = join(dir, 'file-not-dir');
    writeFileSync(notADir, 'x');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = new AuditLogger({ filePath: join(notADir, 'audit.log'), stderr: false });
    expect(() => logger.log({ transport: 'test', keyId: null, keyName: null, event: 'auth', outcome: 'denied' })).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/\[audit\] ghi file thất bại/));
  });
});

describe('redactParams', () => {
  it.each([
    ['header-style key is redacted case-insensitively', { 'X-Api-Key': 'v' }, { 'X-Api-Key': '[REDACTED]' }],
    ['account number <= 4 chars fully masked', { account_number: '1234' }, { account_number: '****' }],
    ['nested arrays are walked', { list: [{ token: 't' }, 'ok'] }, { list: [{ token: '[REDACTED]' }, 'ok'] }],
  ])('%s', (_name, input, expected) => {
    expect(redactParams(input)).toEqual(expected);
  });

  it('string longer than 500 chars is truncated with original length suffix', () => {
    const out = redactParams({ note: 'a'.repeat(600) }) as { note: string };
    expect(out.note.startsWith('a'.repeat(500))).toBe(true);
    expect(out.note.endsWith('…[600]')).toBe(true);
  });

  it('nesting deeper than 6 levels collapses to "[depth]"', () => {
    let obj: unknown = 'leaf';
    for (let i = 0; i < 8; i++) obj = { n: obj };
    const out = redactParams(obj) as Record<string, any>;
    expect(out.n.n.n.n.n.n.n).toBe('[depth]');
  });
});
