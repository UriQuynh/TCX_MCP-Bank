import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const recordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/),
  name: z.string().min(1).max(100),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  rateLimitPerMinute: z.number().int().positive().nullable(),
  revokedAt: z.string().nullable().optional(),
});

const fileSchema = z.object({ version: z.literal(1), keys: z.array(recordSchema) });

export type ApiKeyRecord = z.infer<typeof recordSchema>;

export interface ApiKeyStore {
  findById(id: string): ApiKeyRecord | undefined;
  list(): ApiKeyRecord[];
}

export class MemoryApiKeyStore implements ApiKeyStore {
  private readonly records = new Map<string, ApiKeyRecord>();

  constructor(records: ApiKeyRecord[] = []) {
    for (const r of records) this.records.set(r.id, r);
  }

  findById(id: string): ApiKeyRecord | undefined {
    return this.records.get(id);
  }

  list(): ApiKeyRecord[] {
    return [...this.records.values()];
  }

  add(record: ApiKeyRecord): void {
    this.records.set(record.id, record);
  }

  revoke(id: string, at = new Date()): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    this.records.set(id, { ...r, enabled: false, revokedAt: at.toISOString() });
    return true;
  }
}

// Kho JSON trên đĩa, tự nạp lại khi file đổi (mtime) để revoke có hiệu lực ngay, không cần restart.
export class FileApiKeyStore implements ApiKeyStore {
  private records = new Map<string, ApiKeyRecord>();
  private loadedMtimeMs = -1;

  constructor(private readonly filePath: string) {}

  private reloadIfChanged(): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.filePath).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = new Map();
        this.loadedMtimeMs = -1;
        return;
      }
      throw err;
    }
    if (mtimeMs === this.loadedMtimeMs) return;
    const raw = readFileSync(this.filePath, 'utf8');
    const parsed = fileSchema.parse(JSON.parse(raw));
    this.records = new Map(parsed.keys.map((k) => [k.id, k]));
    this.loadedMtimeMs = mtimeMs;
  }

  findById(id: string): ApiKeyRecord | undefined {
    this.reloadIfChanged();
    return this.records.get(id);
  }

  list(): ApiKeyRecord[] {
    this.reloadIfChanged();
    return [...this.records.values()];
  }

  add(record: ApiKeyRecord): void {
    this.reloadIfChanged();
    if (this.records.has(record.id)) throw new Error(`Key id trùng: ${record.id}`);
    this.records.set(record.id, record);
    this.persist();
  }

  revoke(id: string, at = new Date()): boolean {
    this.reloadIfChanged();
    const r = this.records.get(id);
    if (!r) return false;
    this.records.set(id, { ...r, enabled: false, revokedAt: at.toISOString() });
    this.persist();
    return true;
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    const body = JSON.stringify({ version: 1, keys: [...this.records.values()] }, null, 2);
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, this.filePath);
    this.loadedMtimeMs = statSync(this.filePath).mtimeMs;
  }
}
