import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileApiKeyStore, type ApiKeyRecord } from '../src/auth/api-key.store.js';

// FileApiKeyStore là adapter filesystem -> test với thư mục tạm cô lập (integration nhẹ, không phải unit thuần).
const dir = mkdtempSync(join(tmpdir(), 'tcx-keys-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ID_A = 'abcdefabcdef';
const rec = (id: string, over: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  id,
  name: 'svc',
  secretHash: 'a'.repeat(64),
  scopes: ['wallet:read'],
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  rateLimitPerMinute: null,
  ...over,
});

describe('FileApiKeyStore', () => {
  it('missing file -> findById undefined, list empty', () => {
    const store = new FileApiKeyStore(join(dir, 'none.json'));
    expect(store.findById(ID_A)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('add then findById -> persisted to disk with mode 0600', () => {
    const file = join(dir, 'add.json');
    new FileApiKeyStore(file).add(rec(ID_A));
    expect(new FileApiKeyStore(file).findById(ID_A)?.name).toBe('svc');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('add duplicate id -> throws', () => {
    const store = new FileApiKeyStore(join(dir, 'dup.json'));
    store.add(rec(ID_A));
    expect(() => store.add(rec(ID_A))).toThrow(/trùng/);
  });

  it('revoke existing -> disabled with revokedAt; revoke unknown -> false', () => {
    const store = new FileApiKeyStore(join(dir, 'revoke.json'));
    store.add(rec(ID_A));
    expect(store.revoke(ID_A, new Date('2026-02-02T00:00:00.000Z'))).toBe(true);
    expect(store.findById(ID_A)).toMatchObject({ enabled: false, revokedAt: '2026-02-02T00:00:00.000Z' });
    expect(store.revoke('0123456789ab')).toBe(false);
  });

  it('file edited by another process -> reloaded on next read without restart', () => {
    const file = join(dir, 'reload.json');
    const a = new FileApiKeyStore(file);
    a.add(rec(ID_A));
    expect(a.findById(ID_A)?.enabled).toBe(true);
    new FileApiKeyStore(file).revoke(ID_A);
    const future = new Date(Date.now() + 5_000);
    utimesSync(file, future, future);
    expect(a.findById(ID_A)?.enabled).toBe(false);
  });

  it('corrupt file shape -> throws on read', () => {
    const file = join(dir, 'corrupt.json');
    writeFileSync(file, JSON.stringify({ version: 2, keys: 'nope' }));
    expect(() => new FileApiKeyStore(file).findById(ID_A)).toThrow();
  });
});
