import { AuthError } from '../errors.js';
import type { ApiKeyStore } from './api-key.store.js';
import { parseApiKey, verifySecret } from './api-key.js';
import { isScope, type Scope } from './scopes.js';

export interface Principal {
  keyId: string;
  name: string;
  scopes: Scope[];
  rateLimitPerMinute: number;
}

export interface AuthenticateOptions {
  defaultRateLimitPerMinute: number;
  now?: () => Date;
}

// Mọi nhánh thất bại đều ném AuthError với reason nội bộ; message ra ngoài luôn giống nhau.
export function authenticate(store: ApiKeyStore, rawKey: string | undefined | null, opts: AuthenticateOptions): Principal {
  const now = (opts.now ?? (() => new Date()))();
  if (!rawKey || !rawKey.trim()) throw new AuthError('missing');

  const parsed = parseApiKey(rawKey);
  if (!parsed) throw new AuthError('malformed');

  const record = store.findById(parsed.id);
  if (!record) throw new AuthError('unknown_key');

  // Verify secret TRƯỚC các check trạng thái để không rò rỉ trạng thái key qua timing.
  if (!verifySecret(parsed.secret, record.secretHash)) throw new AuthError('bad_secret');
  if (!record.enabled) throw new AuthError('disabled');
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= now.getTime()) throw new AuthError('expired');

  const scopes = record.scopes.filter(isScope);
  return {
    keyId: record.id,
    name: record.name,
    scopes,
    rateLimitPerMinute: record.rateLimitPerMinute ?? opts.defaultRateLimitPerMinute,
  };
}

export function extractBearer(headerValue: string | string[] | undefined): string | undefined {
  const v = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!v) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(v.trim());
  return m ? m[1]!.trim() : undefined;
}
