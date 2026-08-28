import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Định dạng: tcxb_<id 12 hex>_<secret 43 base64url>
// id dùng để tra cứu O(1); chỉ secret được hash (sha256) trong kho.
export const KEY_PREFIX = 'tcxb';
const KEY_RE = /^tcxb_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedKey {
  id: string;
  secret: string;
  plaintext: string;
}

export function generateApiKey(): GeneratedKey {
  const id = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { id, secret, plaintext: `${KEY_PREFIX}_${id}_${secret}` };
}

export function parseApiKey(raw: string | undefined | null): { id: string; secret: string } | null {
  if (!raw) return null;
  const m = KEY_RE.exec(raw.trim());
  if (!m) return null;
  return { id: m[1]!, secret: m[2]! };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function verifySecret(secret: string, expectedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(expectedHash, 'hex');
  } catch {
    return false;
  }
  return a.length === b.length && timingSafeEqual(a, b);
}
