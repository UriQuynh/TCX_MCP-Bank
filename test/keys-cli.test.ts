import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// CLI chạy như tiến trình thật (tsx) với kho key tạm -> integration test, không phải unit.
const dir = mkdtempSync(join(tmpdir(), 'tcx-cli-'));
const file = join(dir, 'api-keys.json');
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]) {
  return spawnSync(TSX, ['scripts/keys.ts', ...args], { cwd: process.cwd(), env: { ...process.env, API_KEYS_FILE: file }, encoding: 'utf8' });
}

describe('keys CLI', () => {
  it('create -> prints plaintext key once; store holds only the hash', () => {
    const r = run('create', '--name', 'svc', '--scopes', 'wallet:read,qr:create');
    expect(r.status).toBe(0);
    const keys = r.stdout.match(/tcxb_[a-f0-9]{12}_[A-Za-z0-9_-]{43}/g) ?? [];
    expect(keys).toHaveLength(1);
    const secret = keys[0]!.split('_')[2]!;
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(stored.keys[0].secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(file, 'utf8')).not.toContain(secret);
  }, 30_000);

  it('create with unknown scope -> exit 1 and explains valid scopes', () => {
    const r = run('create', '--name', 'bad', '--scopes', 'wallet:read,admin:all');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Scope không hợp lệ: admin:all/);
  }, 30_000);

  it('revoke then list -> shows REVOKED', () => {
    const created = run('create', '--name', 'to-revoke', '--scopes', 'wallet:read');
    const id = /id=([a-f0-9]{12})/.exec(created.stdout)![1]!;
    expect(run('revoke', id).status).toBe(0);
    const list = run('list');
    expect(list.stdout).toMatch(new RegExp(`${id}\\s+REVOKED`));
  }, 30_000);
});
