import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { performance } from 'node:perf_hooks';
import type { AuditLogger } from './audit/audit-log.js';
import type { Principal } from './auth/authenticate.js';
import type { RateLimiter } from './auth/rate-limit.js';
import { hasScopes, missingScopes, SCOPE_DESCRIPTIONS } from './auth/scopes.js';
import type { BankProvider } from './bank/types.js';
import { APP_NAME, APP_VERSION } from './config.js';
import { AppError, toErrorPayload, type ErrorCode } from './errors.js';
import { TOOL_DEFINITIONS, type AnyToolDefinition, type ToolContext } from './tools/definitions.js';

export interface BankServerDeps {
  principal: Principal;
  bank: BankProvider;
  audit: AuditLogger;
  rateLimiter: RateLimiter;
  transport: 'stdio' | 'http' | 'test';
  maxTransferAmount: number;
  sessionRef?: { id?: string };
  remoteIp?: string;
}

function buildInstructions(p: Principal): string {
  const lines = [
    `Server ngân hàng TCX. API key "${p.name}" được cấp các scope sau:`,
    ...(p.scopes.length ? p.scopes.map((s) => `- ${s}: ${SCOPE_DESCRIPTIONS[s]}`) : ['- (không có scope nào)']),
    'Chỉ những tool đủ scope mới được liệt kê; tool khác sẽ bị từ chối.',
    'Mọi số tiền là VND nguyên (không thập phân). Chuyển tiền luôn cần idempotency_key duy nhất.',
  ];
  return lines.join('\n');
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }, null, 2) }] };
}

function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, null, 2) }],
  };
}

export function createBankMcpServer(deps: BankServerDeps): McpServer {
  const { principal } = deps;
  const server = new McpServer({ name: APP_NAME, version: APP_VERSION }, { instructions: buildInstructions(principal) });
  const ctx: ToolContext = { bank: deps.bank, principal, maxTransferAmount: deps.maxTransferAmount };

  for (const def of TOOL_DEFINITIONS) {
    // Không đủ scope -> không đăng ký -> tools/list không hiển thị, tools/call trả "not found".
    if (!hasScopes(principal.scopes, def.scopes)) continue;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: {
          readOnlyHint: def.readOnly,
          destructiveHint: def.destructive ?? false,
          idempotentHint: def.idempotent ?? false,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => execute(def, args),
    );
  }

  async function execute(def: AnyToolDefinition, args: Record<string, unknown>): Promise<CallToolResult> {
    const t0 = performance.now();
    const base = {
      transport: deps.transport,
      keyId: principal.keyId,
      keyName: principal.name,
      event: 'tool' as const,
      tool: def.name,
      params: args,
      ...(deps.sessionRef?.id ? { sessionId: deps.sessionRef.id } : {}),
      ...(deps.remoteIp ? { remoteIp: deps.remoteIp } : {}),
    };

    const rl = await deps.rateLimiter.check(principal.keyId, principal.rateLimitPerMinute);
    if (!rl.allowed) {
      deps.audit.log({ ...base, outcome: 'denied', code: 'RATE_LIMITED', durationMs: 0 });
      return fail('RATE_LIMITED', 'Vượt giới hạn tần suất của API key', { retry_after_ms: rl.retryAfterMs });
    }

    // Defense in depth: kiểm tra lại scope tại thời điểm gọi dù tool đã được lọc lúc đăng ký.
    const missing = missingScopes(principal.scopes, def.scopes);
    if (missing.length) {
      deps.audit.log({ ...base, outcome: 'denied', code: 'PERMISSION_DENIED', durationMs: 0 });
      return fail('PERMISSION_DENIED', 'API key không có quyền dùng tool này', { missing_scopes: missing });
    }

    try {
      const data = await def.run(ctx, args);
      deps.audit.log({ ...base, outcome: 'success', durationMs: Math.round(performance.now() - t0) });
      return ok(data);
    } catch (err) {
      const payload = toErrorPayload(err);
      deps.audit.log({
        ...base,
        outcome: 'error',
        code: payload.code,
        reason: err instanceof AppError ? err.message : (err as Error)?.message,
        durationMs: Math.round(performance.now() - t0),
      });
      if (!(err instanceof AppError)) process.stderr.write(`[${APP_NAME}] lỗi không mong đợi ở ${def.name}: ${String(err)}\n`);
      return fail(payload.code, payload.message, payload.details);
    }
  }

  return server;
}
