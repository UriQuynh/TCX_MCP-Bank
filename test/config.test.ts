import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = { API_KEYS_FILE: '/dev/null' };

describe('loadConfig', () => {
  it('invalid MCP_TRANSPORT -> throws naming the field', () => {
    expect(() => loadConfig({ ...BASE, MCP_TRANSPORT: 'bogus' })).toThrow(/MCP_TRANSPORT/);
  });

  it.each([
    ['missing BANK_API_BASE_URL', { BANK_PROVIDER: 'http', BANK_API_KEY: 'k' }, /BANK_API_BASE_URL/],
    ['missing BANK_API_KEY', { BANK_PROVIDER: 'http', BANK_API_BASE_URL: 'https://bank.example' }, /BANK_API_KEY/],
  ])('BANK_PROVIDER=http with %s -> throws', (_name, env, re) => {
    expect(() => loadConfig({ ...BASE, ...env })).toThrow(re);
  });

  it('INCOMING_PAYMENT_FORWARD_URL without secret -> throws', () => {
    expect(() => loadConfig({ ...BASE, INCOMING_PAYMENT_FORWARD_URL: 'https://b.example/hook' })).toThrow(/INCOMING_PAYMENT_FORWARD_SECRET/);
  });

  it.each([
    ['0.0.0.0 + unset -> true (fail-closed default)', '0.0.0.0', undefined, true],
    ['0.0.0.0 + "false" -> false (explicit override)', '0.0.0.0', 'false', false],
    ['127.0.0.1 + "true" -> true (explicit override)', '127.0.0.1', 'true', true],
    ['localhost + unset -> false', 'localhost', undefined, false],
  ])('MCP_REQUIRE_HTTPS: %s', (_name, host, flag, expected) => {
    const env = { ...BASE, MCP_HTTP_HOST: host, ...(flag !== undefined ? { MCP_REQUIRE_HTTPS: flag } : {}) };
    expect(loadConfig(env).MCP_REQUIRE_HTTPS).toBe(expected);
  });

  it('MCP_ALLOWED_HOSTS csv is trimmed and empty items dropped', () => {
    expect(loadConfig({ ...BASE, MCP_ALLOWED_HOSTS: ' a.com, b.com ,,' }).MCP_ALLOWED_HOSTS).toEqual(['a.com', 'b.com']);
  });

  it('RATE_LIMIT_PER_MINUTE=0 (below min) -> throws', () => {
    expect(() => loadConfig({ ...BASE, RATE_LIMIT_PER_MINUTE: '0' })).toThrow(/RATE_LIMIT_PER_MINUTE/);
  });

  it('defaults: port 3020, provider mock, insecure flag false, rate 60', () => {
    const cfg = loadConfig(BASE);
    expect(cfg.MCP_HTTP_PORT).toBe(3020);
    expect(cfg.BANK_PROVIDER).toBe('mock');
    expect(cfg.BANK_API_ALLOW_INSECURE).toBe(false);
    expect(cfg.RATE_LIMIT_PER_MINUTE).toBe(60);
  });
});
