# TCX_MCP-Bank

MCP server (Model Context Protocol) của Trạm Chủ Xe dùng để **kết nối ngân hàng** và **tạo ví/tài khoản nhận tiền**. Mọi tool đều bị khoá sau **API key có scope**: key không có scope tương ứng thì tool **không hiển thị** và **không gọi được**; không có key hợp lệ thì bị từ chối ngay ở tầng transport.

- Runtime: Node 22, TypeScript, `@modelcontextprotocol/sdk`
- Transport: `stdio` (Claude Code / Claude Desktop) hoặc `http` (Streamable HTTP, cho backend/agent từ xa, đặt sau nginx TLS)
- Bank provider: `mock` (sổ cái bộ nhớ), `local` (sổ cái SQLite bền vững), `http` (adapter REST tổng quát, xem mục 6)
- Webhook "báo có" từ ngân hàng (HMAC + chống replay), chuyển tiếp có chữ ký sang TCX_Backend
- Rate-limit theo key/IP: bộ nhớ (1 instance) hoặc Redis (nhiều instance)

---

## 1. Cài đặt

```bash
npm install
cp .env.example .env
npm run build
```

## 2. Cấp API key (bắt buộc trước khi dùng)

```bash
# Xem scope có sẵn
npm run keys -- scopes

# Tạo key: chỉ cấp đúng quyền cần dùng
npm run keys -- create --name "tcx-backend" --scopes wallet:create,wallet:read,qr:create --expires-days 90 --rate 120

# Liệt kê / thu hồi
npm run keys -- list
npm run keys -- revoke <key_id>
```

Key có dạng `tcxb_<id>_<secret>`, chỉ in **một lần**. Kho `data/api-keys.json` chỉ lưu **SHA-256 của secret** (file mode 0600, gitignored). Thu hồi có hiệu lực ngay với phiên HTTP mới (kho tự nạp lại theo mtime); phiên stdio đang chạy cần restart.

### Scope

| Scope | Cho phép | Tool |
|---|---|---|
| `wallet:create` | Tạo ví mới với ngân hàng | `bank_create_wallet` |
| `wallet:read` | Xem ví, danh sách ví, số dư | `bank_get_wallet`, `bank_list_wallets`, `bank_get_balance` |
| `transaction:read` | Lịch sử giao dịch | `bank_list_transactions` |
| `transfer:create` | Chuyển tiền ra khỏi ví (rủi ro cao) | `bank_transfer` |
| `qr:create` | Tạo QR nhận tiền vào ví | `bank_create_payment_qr` |
| `deposit:create` | Nạp tiền (ghi có) vào ví, idempotent | `bank_deposit` |
| `wallet:manage` | Đóng băng / mở băng / đóng ví | `bank_freeze_wallet`, `bank_close_wallet` |
| `account:lookup` | Tra cứu tên chủ tài khoản thụ hưởng | `bank_lookup_account` |
| `transaction:read` | Xem tiền vào nhận qua webhook | `bank_list_incoming_payments` |
| *(bất kỳ key hợp lệ)* | Xem key mình có quyền gì | `bank_whoami` |

Quy tắc trạng thái ví: `active` ⇄ `frozen` (đóng băng chỉ khoá chiều ra, vẫn nhận tiền vào), `active`/`frozen` → `closed` (bắt buộc số dư 0, không mở lại).

Mọi số tiền là **VND nguyên**. `bank_transfer` bắt buộc `idempotency_key` (gửi lại cùng key trả kết quả cũ, không chuyển lần 2) và bị chặn bởi `MAX_TRANSFER_AMOUNT_VND`.

## 3. Chạy với Claude Code / Claude Desktop (stdio)

`.mcp.json` (hoặc `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tcx-bank": {
      "command": "node",
      "args": ["/Users/uriquynh/TramChuXe/TCX_MCP-Bank/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "BANK_MCP_API_KEY": "tcxb_...",
        "API_KEYS_FILE": "/Users/uriquynh/TramChuXe/TCX_MCP-Bank/data/api-keys.json",
        "AUDIT_LOG_FILE": "/Users/uriquynh/TramChuXe/TCX_MCP-Bank/data/audit.log",
        "BANK_PROVIDER": "mock"
      }
    }
  }
}
```

Key sai/thiếu → process thoát mã 2 và ghi audit `denied`. Key hợp lệ → chỉ tool đủ scope được đăng ký.

## 4. Chạy HTTP (backend / agent từ xa)

```bash
MCP_TRANSPORT=http MCP_HTTP_HOST=127.0.0.1 MCP_HTTP_PORT=3020 npm start
```

- Endpoint: `POST/GET/DELETE /mcp`, `GET /health` (public, không lộ dữ liệu).
- Xác thực mỗi request: `Authorization: Bearer <key>` hoặc `X-API-Key: <key>`. Thiếu/sai → `401` (JSON-RPC error), quá 30 lần sai/phút/IP → `429`.
- Session (`Mcp-Session-Id`) gắn chặt với key đã khởi tạo; key khác dùng lại session → `403`.
- Bind ra ngoài `127.0.0.1` phải đặt `MCP_ALLOWED_HOSTS` (chống DNS rebinding) và **đặt sau nginx TLS** (không chạy HTTP trần ở prod).
- Phiên không hoạt động quá `MCP_SESSION_TTL_MS` (mặc định 30 phút) bị đóng.
- Nhiều instance: đặt `REDIS_URL` để rate-limit (theo key, theo IP sai key, webhook) dùng chung qua Redis; Redis lỗi thì **chặn** (fail-closed) trừ khi `RATE_LIMIT_FAIL_OPEN=true`.

### TLS: server không tự làm TLS - bắt buộc đứng sau nginx

`MCP_REQUIRE_HTTPS` (mặc định **bật** khi `MCP_HTTP_HOST` khác loopback): request `/mcp` và `/webhooks/*` không mang `X-Forwarded-Proto: https` từ proxy tin cậy (`trust proxy 1`) bị trả `403`. Cấu hình mẫu:

- [deploy/nginx/tcx-mcp-bank.conf](deploy/nginx/tcx-mcp-bank.conf) - TLS 1.2/1.3, HSTS, `proxy_buffering off` cho SSE, `limit_req` riêng cho `/mcp` và `/webhooks/`, chỗ bật mTLS/allowlist IP ngân hàng.
- [deploy/docker-compose.yml](deploy/docker-compose.yml) - `mcp` (không publish port) + `redis` (requirepass) + `nginx` (443). Chạy: `cd deploy && docker compose --env-file ../.env up -d`.

Với hạ tầng TCX hiện có: copy conf vào `TCX_Infra/nginx/conf.d/`, dùng chung cert Cloudflare Origin CA `nginx/ssl/tramchuxe/`, thêm A record `mcp.tramchuxe.com` (proxied) trên Cloudflare.

Docker:

```bash
docker build -t tcx-mcp-bank .
docker run -d --name tcx-mcp-bank -p 127.0.0.1:3020:3020 \
  -v tcx_mcp_bank_data:/app/data --env-file .env tcx-mcp-bank
# cấp key bên trong container
docker exec tcx-mcp-bank node -e "" # dùng: npm run keys ... trên host với API_KEYS_FILE trỏ vào volume, hoặc copy file api-keys.json vào /app/data
```

## 5. Webhook "báo có" (tiền vào)

`POST /webhooks/bank/incoming` - bật khi có `BANK_WEBHOOK_SECRET`. Không dùng API key MCP; xác thực bằng:

- `X-Bank-Timestamp`: unix giây, lệch quá `BANK_WEBHOOK_TOLERANCE_SEC` (mặc định 300) → 401 (chống replay)
- `X-Bank-Signature`: `hex(HMAC-SHA256(secret, "<ts>.<raw body>"))`, so sánh timing-safe

Body chuẩn hoá (ngân hàng thật có payload khác → map trong `parseIncomingPayment` của provider):

```json
{ "event_id": "bank-evt-100", "account_number": "912345678901", "amount": 120000,
  "description": "CK don 55", "reference": "FT123", "payer_name": "Khach A", "payer_account": "0011002233",
  "occurred_at": "2026-08-28T10:00:00+07:00" }
```

Xử lý: dedupe theo `event_id` (gửi lại → `200 {duplicate:true}`, không ghi có 2 lần) → provider `mock`/`local` ghi có vào ví có `account_number` khớp (ví đã đóng hoặc không tìm thấy → lưu bản ghi `applied:false` để đối soát) → nếu có `INCOMING_PAYMENT_FORWARD_URL` thì POST bản ghi sang đó với `X-TCX-Timestamp` + `X-TCX-Signature = hex(HMAC-SHA256(INCOMING_PAYMENT_FORWARD_SECRET, "<ts>.<body>"))`, retry 3 lần backoff. Tool `bank_list_incoming_payments` tra lại lịch sử.

Test tay:

```bash
BODY='{"event_id":"e1","account_number":"912345678901","amount":50000}'; TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BANK_WEBHOOK_SECRET" | awk '{print $2}')
curl -s -X POST https://mcp.tramchuxe.com/webhooks/bank/incoming -H "Content-Type: application/json" \
  -H "X-Bank-Timestamp: $TS" -H "X-Bank-Signature: $SIG" -d "$BODY"
```

## 6. Audit log

Mỗi lần xác thực và mỗi tool call ghi 1 dòng JSON vào `AUDIT_LOG_FILE` (và stderr): key id/name, session, tool, tham số (secret bị `[REDACTED]`, số tài khoản chỉ giữ 4 số cuối), kết quả `success|error|denied`, mã lỗi, thời gian xử lý, IP (HTTP).

## 7. Bank provider

### `mock` (mặc định) và `local`
Cùng một sổ cái nội bộ (`LedgerBankProvider`): tạo ví, nạp/chuyển tiền (kiểm tra số dư, idempotency, transaction nguyên tử), đóng băng/đóng ví, tra cứu tài khoản nội bộ, ghi có từ webhook, QR giả.
- `mock`: lưu bộ nhớ, mất khi restart - dev/test.
- `local`: lưu SQLite (`node:sqlite` built-in, WAL) tại `LEDGER_DB_FILE` - bền vững qua restart, dùng khi TCX tự giữ sổ phụ trước khi nối ngân hàng thật. Backup = copy file `.sqlite` (kèm `-wal`/`-shm`) hoặc `sqlite3 ledger.sqlite ".backup ..."`. Node in cảnh báo `ExperimentalWarning: SQLite` ra stderr - vô hại.

### `http` - adapter REST tổng quát
Vì chưa chốt ngân hàng/VA provider cụ thể, adapter dùng một contract REST tối giản; khi ký hợp đồng API thật, sửa các hàm `map*` trong `src/bank/http-bank.provider.ts` cho khớp. Contract mặc định:

| Thao tác | Request | Response (JSON) |
|---|---|---|
| Tạo ví | `POST /wallets` `{owner_ref, owner_name, metadata?}` | `Wallet` |
| Xem ví | `GET /wallets/:id` | `Wallet` (404 nếu không có) |
| Danh sách | `GET /wallets?owner_ref=&limit=` | `Wallet[]` hoặc `{wallets: Wallet[]}` |
| Số dư | `GET /wallets/:id/balance` | `{wallet_id, balance, as_of}` |
| Giao dịch | `GET /wallets/:id/transactions?limit=&since=` | `Transaction[]` hoặc `{transactions: [...]}` |
| Chuyển tiền | `POST /transfers` + header `Idempotency-Key` | `{transaction_id, status, amount, fee, balance_after, created_at}` |
| QR nhận tiền | `POST /wallets/:id/payment-qr` `{amount?, description?, expires_in_seconds?}` | `{bank_code, account_number, account_name, qr_content, qr_image_url?, expires_at?}` |
| Nạp tiền | `POST /wallets/:id/deposits` + header `Idempotency-Key` `{amount, description, source?}` | `{transaction_id, amount, balance_after, created_at}` |
| Đổi trạng thái | `POST /wallets/:id/status` `{status: active\|frozen\|closed, reason?}` | `Wallet` |
| Tra cứu thụ hưởng | `GET /accounts/lookup?bank_code=&account_number=` | `{account_name, bank_code, account_number}` (404 → `ACCOUNT_NOT_FOUND`) |
| Health | `GET /health` | 2xx |

Với provider `http`, webhook "báo có" chỉ **ghi nhận** (ngân hàng đã ghi có) và resolve `wallet_id` qua `GET /wallets?account_number=`; bản ghi lưu SQLite `LEDGER_DB_FILE` để `bank_list_incoming_payments` tra lại.

`Wallet = {id, owner_ref, owner_name, bank_code, account_number, status, balance, created_at, metadata?}`.

Bảo mật phía gọi ra: `Authorization: Bearer $BANK_API_KEY`; nếu có `BANK_API_SECRET` thì thêm `X-Timestamp` + `X-Signature = HMAC-SHA256(secret, "<ts>.<METHOD>.<path+query>.<body>")`. Bắt buộc `https://`, chặn base URL phân giải về IP nội bộ (SSRF), timeout `BANK_API_TIMEOUT_MS`, không follow redirect. Mã lỗi map: 404→`WALLET_NOT_FOUND`, 409→`DUPLICATE_REQUEST`, 402/`INSUFFICIENT*`→`INSUFFICIENT_FUNDS`, 400/422→`VALIDATION_ERROR`, còn lại `PROVIDER_ERROR`.

## 8. Định dạng kết quả tool

```json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": { "code": "PERMISSION_DENIED", "message": "...", "details": { "missing_scopes": ["transfer:create"] } } }
```

Mã lỗi: `UNAUTHENTICATED`, `PERMISSION_DENIED`, `RATE_LIMITED`, `VALIDATION_ERROR`, `WALLET_NOT_FOUND`, `WALLET_INACTIVE`, `INVALID_STATE`, `ACCOUNT_NOT_FOUND`, `INSUFFICIENT_FUNDS`, `DUPLICATE_REQUEST`, `WEBHOOK_REJECTED`, `PROVIDER_ERROR`, `NOT_SUPPORTED`.

## 9. Phát triển

```bash
npm run dev        # tsx src/index.ts
npm run typecheck
npm test           # vitest: auth, scope gating, wallet lifecycle, ledger SQLite, webhook, http auth/https guard
```

Cấu trúc:

```
src/
  auth/        scopes, định dạng key, kho key (file/memory), authenticate, rate-limit (memory/Redis)
  audit/       audit logger (JSON lines, redact)
  bank/        BankProvider interface, ledger store (memory/SQLite), ledger provider (mock/local), http adapter, factory
  webhooks/    xác thực HMAC + xử lý "báo có" + chuyển tiếp có chữ ký
  tools/       định nghĩa tool + scope yêu cầu + zod schema
  server.ts    tạo McpServer theo principal: chỉ đăng ký tool đủ scope, re-check khi gọi
  transports/  stdio (key từ env), http (key từ header, session gắn key)
scripts/keys.ts  CLI cấp/thu hồi key
deploy/          nginx TLS conf + docker-compose (mcp + redis + nginx)
```
