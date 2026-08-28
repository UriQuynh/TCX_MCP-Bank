#!/usr/bin/env tsx
// CLI quản lý API key: create | list | revoke | scopes
import { parseArgs } from 'node:util';
import { generateApiKey, hashSecret } from '../src/auth/api-key.js';
import { FileApiKeyStore, type ApiKeyRecord } from '../src/auth/api-key.store.js';
import { ALL_SCOPES, isScope, SCOPE_DESCRIPTIONS } from '../src/auth/scopes.js';

const USAGE = `Cách dùng:
  npm run keys -- create --name <tên> --scopes <a,b,c> [--expires-days N] [--rate N]
  npm run keys -- list
  npm run keys -- revoke <key_id>
  npm run keys -- scopes

Kho key: $API_KEYS_FILE (mặc định ./data/api-keys.json)`;

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      scopes: { type: 'string' },
      'expires-days': { type: 'string' },
      rate: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }
  const store = new FileApiKeyStore(process.env.API_KEYS_FILE ?? './data/api-keys.json');

  switch (cmd) {
    case 'scopes': {
      for (const s of ALL_SCOPES) console.log(`${s.padEnd(18)} ${SCOPE_DESCRIPTIONS[s]}`);
      return;
    }
    case 'list': {
      const rows = store.list();
      if (!rows.length) {
        console.log('(chưa có key nào)');
        return;
      }
      for (const k of rows) {
        const state = !k.enabled ? 'REVOKED' : k.expiresAt && new Date(k.expiresAt) <= new Date() ? 'EXPIRED' : 'active';
        console.log(`${k.id}  ${state.padEnd(8)} ${k.name.padEnd(24)} scopes=[${k.scopes.join(',')}] exp=${k.expiresAt ?? '-'} rate=${k.rateLimitPerMinute ?? 'default'}`);
      }
      return;
    }
    case 'revoke': {
      const id = positionals[1];
      if (!id) throw new Error('Thiếu key_id');
      if (!store.revoke(id)) throw new Error(`Không tìm thấy key ${id}`);
      console.log(`Đã thu hồi ${id}. Kho key tự nạp lại, phiên HTTP mới sẽ bị từ chối ngay; phiên stdio đang chạy cần restart.`);
      return;
    }
    case 'create': {
      if (!values.name) throw new Error('Thiếu --name');
      const scopes = (values.scopes ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!scopes.length) throw new Error(`Thiếu --scopes. Scope hợp lệ: ${ALL_SCOPES.join(', ')}`);
      const bad = scopes.filter((s) => !isScope(s));
      if (bad.length) throw new Error(`Scope không hợp lệ: ${bad.join(', ')}. Hợp lệ: ${ALL_SCOPES.join(', ')}`);
      const days = values['expires-days'] ? Number(values['expires-days']) : null;
      if (days !== null && (!Number.isInteger(days) || days <= 0)) throw new Error('--expires-days phải là số nguyên dương');
      const rate = values.rate ? Number(values.rate) : null;
      if (rate !== null && (!Number.isInteger(rate) || rate <= 0)) throw new Error('--rate phải là số nguyên dương');

      const gen = generateApiKey();
      const record: ApiKeyRecord = {
        id: gen.id,
        name: values.name,
        secretHash: hashSecret(gen.secret),
        scopes: [...new Set(scopes)],
        enabled: true,
        createdAt: new Date().toISOString(),
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
        rateLimitPerMinute: rate,
      };
      store.add(record);
      console.log(`Đã tạo key "${record.name}" (id=${record.id}) scopes=[${record.scopes.join(', ')}]`);
      console.log('');
      console.log('API KEY (chỉ hiển thị MỘT LẦN, kho chỉ lưu hash):');
      console.log(`  ${gen.plaintext}`);
      return;
    }
    default:
      throw new Error(`Lệnh không hợp lệ: ${cmd}\n${USAGE}`);
  }
}

try {
  main();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
