import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateApiKey } from '../src/auth/api-key.js';
import { MemoryRateLimiter } from '../src/auth/rate-limit.js';
import { MockBankProvider } from '../src/bank/mock-bank.provider.js';
import { loadConfig } from '../src/config.js';
import { runStdio } from '../src/transports/stdio.js';
import { CollectingAudit, makeStore } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('runStdio denial path', () => {
  it.each([
    ['malformed key', 'tcxb_bad', 'malformed', null],
    ['well-formed but unknown key', `tcxb_000000000000_${'a'.repeat(43)}`, 'unknown_key', '000000000000'],
  ])('%s -> audit denied with reason, stderr notice, exit code 2', async (_name, key, reason, keyId) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const audit = new CollectingAudit();
    const cfg = loadConfig({ API_KEYS_FILE: '/dev/null', BANK_MCP_API_KEY: key });

    await expect(runStdio(cfg, { store: makeStore(), audit, rateLimiter: new MemoryRateLimiter(), bank: new MockBankProvider() })).rejects.toThrow('exit:2');

    expect(audit.entries[0]).toMatchObject({ transport: 'stdio', event: 'auth', outcome: 'denied', code: 'UNAUTHENTICATED', reason, keyId });
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`TỪ CHỐI.*\\(${reason}\\)`)));
    expect(exit).toHaveBeenCalledWith(2);
    void generateApiKey;
  });
});
