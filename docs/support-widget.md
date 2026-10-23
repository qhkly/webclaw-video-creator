# 在线客服（support.qhkly.com 统一客服）

状态：**客户端补丁已完成并通过测试；线上未开通。** 在下面「跨仓库配套与阻塞」全部解除前，应用里的客服入口会显示「在线客服暂未开通」，不会误报上线。

## 产品判断

WebClaw Video Creator 是对外销售的桌面产品（官网、会员、store 商品 `webclaw-video-creator`），与 WebClaw Launcher / 平台共用 auth.qhkly.com 的统一账号（见 `account-membership.md`，PKCE 公开客户端 `video-creator`）。所以客服身份直接用这个统一账号，不再造第二套。

## 架构

```
设置页「联系客服」 / 悬浮客服按钮（@webcode/support-ui Widget，Shadow DOM）
  └─ hostCredentials.request ──invoke──▶ Rust `support_ticket`
        └─ POST auth.qhkly.com/api/support/ticket
             { client_id: "video-creator", subject_token_type: "support_grant", subject_token: <grant>, app: "video-creator" }
             ◀── ES256 票据（≤10 分钟）+ 轮换后的新 grant
  └─ Widget ──Authorization: Bearer <票据>──▶ support.qhkly.com（Worker 用 Auth 的 JWKS 离线验签）
```

- **共享 UI 不复制源码**：依赖 `vendor/webcode-support-ui-0.1.6.tgz`（与 webclaw-platform、webclaw-store 同一个文件，sha256 `de132bec…de70`），`package-lock.json` 锁 integrity。升级 = 换 tgz + 改 `scripts/check-release-security.mjs` 里的钉死哈希。
- **客户端不签名、不持有生产密钥、不带 client_secret**：公开客户端只持有 Auth 在登录时发的 per-user `support_grant`（可吊销、每次使用轮换、只能换客服票据）。它和现有 `account.json` 一样放在应用数据目录（0600），**不进前端**，UI 只拿到 `{ticket, uid, expiresAt}`。
- **grant 串行轮换**（Auth 规定：已轮换的旧 grant 再出现 = 被盗，整条 family 作废）：`support_commands.rs` 在 `io_lock` 下完成 读取 → 请求 → 先落盘新 grant → 再返回票据；429 响应里带回的新 grant 同样落盘；网络失败保留原 grant。票据在内存里按用户缓存到剩余 <60 秒。
- 登录请求新增 `support_grant: true`（只在显式为 true 时 Auth 才发；没登记 support 的环境得到 `null`，整个客服入口降级为「暂未开通」）。
- 退出登录：删除 `account.json`、清票据缓存、尽力调用 `/api/support/grant/revoke`；前端销毁 Widget。
- 账号切换：`SupportHost` 以 `authUserId` 为依赖重建 Widget；Worker 的 uid 由 Auth 对 `(app, usr_…)` 做 HMAC 得出，不同账号会话完全隔离。
- 主题：Widget 跟随应用 `<html data-theme>`（亮/暗）和 `--accent`/`--r-md`，ThemePanel 改动时 `syncTheme()`，不重建 DOM、不断会话。语言跟随应用 zh-CN / en-US。
- 附件：图片（png/jpeg/gif/webp ≤2MB）与 webm（≤4MB），最多 4 个；规则以 Worker 为准。
- 未读：收起时只查 `/api/unread`，不会把回复标成已读；设置页显示未读数。

## 文件

| 层 | 文件 |
|---|---|
| 票据中转（Rust） | `src-tauri/src/commands/support_commands.rs`；`account_commands.rs`（登录领 grant、退出吊销） |
| 纯 TS（可测） | `src/lib/support.ts`、`src/lib/support-bridge.ts`、`src/store/useSupportStore.ts` |
| UI | `src/components/SupportWidget.tsx`（`SupportHost` 挂在 `App`，`SupportSection` 在设置页） |
| 测试 | `tests/support.test.mjs`（对**真实 Worker**）、`tests/support-harness.mjs`、`tests/release-security.test.mjs`、Rust 单测 |
| 发行检查 | `scripts/check-release-security.mjs`（`npm run check:release`，构建后会同时扫描 `dist/`） |

## 测试怎么跑

```bash
npm test                      # 含对真实 Worker 的 11 项；找不到 Worker 时这些项显示 SKIPPED（不算通过）
SUPPORT_WORKER_SRC=<webcode-support>/worker npm test   # 指定 Worker 目录；默认找同级 webcode-support/worker
npm run build && npm run check:release
(cd src-tauri && cargo test)
```

真实 Worker 测试覆盖：发消息（UI 输入框）、附件上传与越权 key 被丢弃、转人工/返回 AI、收起态未读与展开已读、账号切换隔离、退出后无法再读写、主题切换、伪造/跨租户/过期/他钥签名票据被拒。Auth 在测试里由一把临时 ES256 密钥模拟（仅测试代码，`src/` 无任何签名代码）。

## 跨仓库配套与阻塞（本仓不改，也未执行）

| # | 阻塞 | 所在仓库 | 解除条件 |
|---|---|---|---|
| 1 | Worker 没有 `video-creator` 租户，票据会被拒 | webcode-support | `worker/src/products.js` 增加 `video-creator`（label/identity/terms，建议 `scope: 'redirect'`）；`SUPPORT_TICKET_TENANTS` 增加 `"video-creator": {"mode": "dual"}`。测试 harness 在 Worker 尚未列出该租户时自行注册，并在输出里提示 |
| 2 | Auth 不会给本应用发 grant/票据 | auth | `lib/clients.ts` 的 `SUPPORT_APPS` 加 `video-creator`；`AUTH_CLIENTS_VIDEO_CREATOR` 里 `video-creator` 条目加 `"support":{"app":"video-creator"}`（公开客户端，不开 anonymous / planFromClient）；补契约测试 |
| 3 | Auth 客服签发未上线 | auth | 按 `auth/docs/SUPPORT-ROLLOUT.md`：备份、迁移 005、配签名密钥/uid 密钥、部署（2026-10-21 预检时 `/api/support/jwks`、`/api/support/ticket` 仍 404，B1–B5 未解除） |
| 4 | Worker 线上落后于 main，未配 JWKS | webcode-support | 按 `docs/PRODUCTION-PREFLIGHT-2026-10-21.md` §4 部署并写入 `SUPPORT_TICKET_TENANTS`；先 `dual` |
| 5 | 无真人 PKCE 换票验收 | — | 用本应用调试构建登录一次，确认能收发、转人工、传图 |
| 6 | 已登录的老用户没有 grant | 应用 | 设置页提示「请重新登录一次以启用客服」（`reauth_required`），无需额外操作 |
| 7 | 未登录用户无法用客服 | 产品决策 | 公开客户端不能发匿名票（Auth 规定）。需要的话改为设置页显示联系邮箱，或另行评估机密服务端中转 |

## 发布与回滚

不要在 1–5 全部满足前发版或宣称客服已上线。满足后：

1. 先 Worker `dual` + Auth 登记 → 内部账号用调试构建验收（`VIDEO_CREATOR_AUTH_ORIGIN` / `VITE_SUPPORT_ORIGIN` 仅调试构建可改，正式构建写死）。
2. `npm run build && npm run check:release && npm test && (cd src-tauri && cargo test)` 全绿后，按现有 `tauri:build` 流程发版。
3. 回滚：Auth 去掉 `video-creator` 的 `support`（立即停发，应用降级为「暂未开通」）；Worker 删除租户条目；应用侧新增字段 `supportGrant` 带 serde 默认值，降级旧版本不会损坏 `account.json`。

## 已知限制

- grant 与会话 token 同放在 `account.json`（0600）。Auth 建议放系统钥匙串；本应用现有账号存储尚未迁移，作为后续统一改造项。
- Auth 响应在网络层丢失时，grant 可能已被轮换而本地还是旧值；下次使用会触发 Auth 的「疑似被盗」吊销，应用收到 `invalid_grant` 后清除 grant 并提示重新登录。这是 Auth 协议的固有取舍。
