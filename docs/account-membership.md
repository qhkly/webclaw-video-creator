# 账户与会员接入

App 内登录与会员状态读取。支付全部由 webclaw-store 负责，App 只打开商店的结账页。

代码位置：

| 层 | 文件 |
|---|---|
| 登录、存储、会员刷新（Rust） | `src-tauri/src/commands/account_commands.rs`（所有外部地址和规则集中在文件顶部） |
| 套餐限制（权威，Rust） | `account_commands.rs` 的 `limits_for` / `current_limits`，由导出、渲染、Agent 命令调用 |
| 套餐限制（Node 侧） | `scripts/lib/plan.mjs`（sidecar 参数、entitlement 文件、分辨率与水印计算） |
| 会员模型与 UI 门控（纯 TS，有单测） | `src/lib/membership.ts` |
| 状态与生命周期（zustand） | `src/store/useAccountStore.ts` |
| UI | `src/components/AccountPanel.tsx`（侧栏卡片、设置页「账户与会员」、门控提示） |
| 账户服务（Cloudflare Worker） | `account-service/`（部署说明见 `account-service/README.md`） |

## 架构

```
App ──PKCE 授权──▶ auth.qhkly.com ──302──▶ http://127.0.0.1:1886x/auth/callback（App 本地监听）
App ──POST /api/auth/exchange（code + code_verifier，无 secret）──▶ auth.qhkly.com → 身份 + idToken(15 分钟)
App ──POST {ACCOUNT_API}/v1/session（idToken）──▶ 账户服务 → App 会话 token + 会员状态
App ──GET  {ACCOUNT_API}/v1/membership（Bearer）──▶ 账户服务 ──Basic secret──▶ store /api/v1/membership
App ──打开浏览器──▶ store.qhkly.com/checkout?product=webclaw-video-creator&plan=pro-monthly|pro-yearly
```

为什么需要「账户服务」这一跳：webclaw-store 的会员查询接口只认 `BILLING_CLIENTS_*`
接入方凭证（HTTP Basic secret），而 secret 不能放进桌面安装包（`docs/billing-api.md`
的契约）。auth.qhkly.com 又只发 15 分钟的 idToken、不发 refresh token。所以需要一个服务端：
验 idToken、发 App 自己的可吊销会话、带着自己的 secret 去问 store。这与 AI Studio
（ai-studio-web 的 launcher exchange/renew）和 Voice Master（speech gateway 代查 membership）是同一模式，
实现就在本仓库的 `account-service/`（验签与会员查询逐条对齐 ccdub-speech-gateway 的 Voice Master 实现）。

## 需要在服务端完成的登记 / 部署（TODO）

1. **auth.qhkly.com 公开客户端**：新增环境变量（不要改已有变量）

   ```
   AUTH_CLIENTS_VIDEO_CREATOR='[{"id":"video-creator","public":true,"redirectUris":[
     "http://127.0.0.1:18861/auth/callback",
     "http://127.0.0.1:18862/auth/callback",
     "http://127.0.0.1:18863/auth/callback"]}]'
   ```

   auth 对回调地址做精确匹配，三个端口都要登记（App 依次尝试，避免端口被占用时无法登录）。
   可选：在 auth `lib/brands.ts` 加 `video-creator` 品牌，让登录页显示产品名；不加则是中性样式。

2. **webclaw-store 接入方**（给账户服务用，不进 App）：store 的 `.env.example` 已有
   `BILLING_CLIENTS_VIDEO_CREATOR`（id `webclaw-video-creator`，`read:entitlements`，只能碰
   `webclaw-video-creator`），在配置中心生成 secret 即可。
   产品 `webclaw-video-creator` 在售套餐为 `pro-monthly` / `pro-yearly`；早年的 `trial` / `yearly` / `lifetime`
   已停售，已发出的权益照旧算会员。

3. **部署账户服务**：`account-service/README.md`（建 KV、`wrangler secret put STORE_CLIENT_SECRET`、deploy）。
   计划域名 `video-api.qhkly.com` **尚未开通**：wrangler 里的自定义域名路由是注释状态，开通并确认
   `/healthz` 正常后，再用 `VIDEO_CREATOR_ACCOUNT_API_URL=https://video-api.qhkly.com npm run tauri:build`
   构建（正式构建只接受 https，编译期写入，包里不含任何 secret）。未配置时 App 显示「会员服务尚未开通」，
   按免费版运行（手工剪辑可用，导出最高 720p 带水印，AI 能力不可用）。

## 账户服务契约（App 侧已实现）

所有时间戳为 Unix 秒。错误响应体为 `{ "error": "…" }`。

| 请求 | 响应 |
|---|---|
| `POST /v1/session`，body `{ "idToken", "product": "webclaw-video-creator" }` | `{ "token", "expiresAt", "membership"? }` |
| `GET /v1/membership?product=webclaw-video-creator[&fresh=1]`，`Authorization: Bearer <token>` | store `/api/v1/membership` 的应用所需字段（含 `benefits`）；`fresh=1` 绕过服务端 ≤60 s 缓存 |
| `POST /v1/session/renew`，Bearer | `{ "token", "expiresAt" }` |
| `POST /v1/session/revoke`，Bearer | 任意 2xx（App 退出时尽力调用，不等待结果） |

服务端要求：

- `/v1/session` 必须用 `GET https://auth.qhkly.com/api/auth/public-key` 验 idToken：
  RS256、`iss=auth.qhkly.com`、`aud=video-creator`、未过期；以 `sub`（`usr_…`）作为用户。
- 会员只看 store 的 `member` 字段，并按 store 指引缓存（肯定 ≤60 s、否定 ≤15 s），store 不可用时返回 5xx（fail closed）。
- 状态码语义（App 据此处理）：`401` = 会话失效，App 要求重新登录；`429/5xx`/网络错误 =
  暂时不可用，App 只在上次确认后 60 秒内沿用「是会员」；其他 4xx = 异常，App 按非会员处理。

## App 侧行为

- **登录**：系统浏览器打开授权页，本地端口 18861–18863 接回调，校验 `state`，5 分钟超时；
  浏览器没打开时可复制登录链接。陌生请求（favicon、旧标签页的回调）不会中断当前登录。
- **持久化**：`<app data>/account.json`（0600，原子写入），含用户资料、App 会话 token、最近一次会员结果。
  token 不出 Rust，前端只拿到不含 token 的 `AccountView`。
- **刷新时机**：启动时、窗口重新获得焦点时（60 s 节流）、手动「刷新会员状态」、
  打开结账页后 15 分钟内每 15 s 一次直到变成会员。会话剩余不足 24 h 时自动续期。
- **购买入口**：设置页「账户与会员」与侧栏卡片的「升级会员」，打开
  `https://store.qhkly.com/checkout?product=webclaw-video-creator&plan=pro-monthly|pro-yearly`。
  价格不写死在 App 里，以商店页面为准。退订后（`renewal=cancelled`）、微信一次性付款会到期的会员
  （`renewal=one_time` 且有 `expiresAt`）、以及旧试用权益仍显示购买 / 续费入口。
- **权益**：门控只读 store 下发的机读权益 `benefits`，见下节。
- **退出**：删除本地 `account.json`，尽力吊销服务端会话。浏览器里 auth.qhkly.com 的登录 Cookie 保留，
  下次登录可一键完成（与 Voice Master 一致）。

## 免费版 / Pro 与门控

**原则：谁承担成本决定门控。** 用户自带额度或用户自己机器承担成本的能力（自己已登录的 Claude Code / Codex、
自己的 ChatGPT 图片额度（Codex OAuth）、自己配置的 API Key、本机 Remotion / FFmpeg / 本地启发式）对免费版
完全开放，也不要求登录。只有 WebClaw 代付成本的能力（以后的平台托管 AI / 语音 / 素材等）和高级产出
（高分辨率、去水印）才要求 Pro。

| 能力 | 免费版 | Pro（store `benefits`） |
|---|---|---|
| 手工文字剪辑、场景编辑、预览 | 可用 | 可用 |
| 导出分辨率（短边） | 最高 720p | `maxExportHeight`（4K = 2160） |
| 水印 | 必带 WebClaw Video Creator 水印 | `watermarkFree: true` 时无 |
| AI 导演（Agent CLI、ChatGPT 调用视频工具） | 可用，无需登录（推理用用户自己的 Claude Code / Codex / ChatGPT） | 可用 |
| AI 生图 `video_image_generate`（Codex/ChatGPT OAuth） | 可用，消耗用户自己的图片额度，每次调用都需确认 | 同左 |
| 文字剪辑 AI 一键清理（去语气词、删长停顿） | 可用（本机启发式；转写用本地 / 用户自己的 Key） | 可用 |
| 商用授权 | 仅个人使用 | `commercialUse: true`（只做展示，见下） |

**判定只有一处**：Rust `limits_for(entitled, membership)`。未登录、非会员、会话过期、服务不可用超过 60 秒宽限、
或会员但 `benefits` 缺失 / 字段类型不对，一律得到免费版限制（fail closed，逐字段判断）。登录或会员查询出错
不会影响免费版能力：这些路径从不依赖账户，只会拿到免费版限制。

**实际执行点**（不是只藏 UI）：

| 能力 | 执行入口 | 检查 |
|---|---|---|
| 场景渲染分辨率 + 水印 | `render_video`（Rust）→ `scripts/render.mjs`（Remotion） | Rust 按套餐钳制 `--resolution`，传 `--maxHeight` / `--watermark`；`render.mjs` 缺参数时默认免费版，再钳制一次；水印是 Remotion 合成里的一层（`remotion/src/Watermark.tsx`），渲进每一帧 |
| 文字剪辑导出分辨率 + 水印 | `export_cut`（Rust）→ `scripts/cut-export.mjs`（FFmpeg） | 同上传参；FFmpeg 在 concat 之后 `scale` 到短边 ≤ 限制，再用 `overlay` 叠 `scripts/assets/watermark.png`（不依赖系统字体） |
| MCP 工具的套餐限制（Agent CLI、ChatGPT 隧道） | `mcp/protocol.mjs` 的每一次 `tools/call` | 读 Rust 写的 `<app config>/entitlement.json`（`VIDEO_CREATOR_ENTITLEMENT_FILE`，15 分钟过期，后台每 5 分钟刷新会员并重写）；没有文件、过期或格式不对 → 免费版限制，**但工具照常可用**。`video_render` 把限制传给 `render.mjs`（720p + 水印）。目前没有任何工具要求 Pro |
| 用户额度确认（`cost: 'paid'`） | `mcp/approval.mjs` | `cost` 只是审批语义：`paid` = 消耗用户自己的额度（如 `video_image_generate`），每次调用都要用户确认，与 WebClaw 套餐无关 |

**扩展点。** 以后接入 WebClaw 代付的能力时：前端功能加进 `src/lib/membership.ts` 的 `PAID_FEATURES`
并对应一个套餐限制；MCP 工具声明 `planFeature: '<限制字段>'`，`protocol.mjs` 在该字段不为 `true` 时返回
`PRO_REQUIRED_MESSAGE`。用户自带成本的能力放在 `OWN_COST_FEATURES`，不加 `planFeature`。store 仍可能下发
`aiDirector` / `aiCutCleanup` 权益，App 会忽略。
| 商用授权 | 无 | 架构里没有可执行的技术点，只在「账户与会员」展示，不虚构限制 |

预览（Remotion Player）对免费版同样显示水印，所见即所得。

边界：以上都在用户自己的机器上执行，能挡住 App 内的所有路径（UI、命令、Agent、ChatGPT），但挡不住改源码或改本地文件的人；
真正不可绕过的只有服务端（账户服务与 store）给出的会员结论。

## 待产品决策

1. **离线宽限期。** 按 store 契约 fail closed，只在 60 秒内沿用「是会员」（`OFFLINE_GRACE_SECS`）。
   桌面 App 断网时 Pro 功能会立即按免费版处理；如果要给离线用户更长宽限，需要产品确认后调大这个常量。
2. **价格。** store 文档标注价格是「推荐默认值、未最终拍板」，App 不显示价格，以商店页为准。
3. **会话时长。** 账户服务会话 7 天、续期最长到首次登录后 30 天，之后需要重新登录（`SESSION_TTL_SECONDS` /
   `SESSION_MAX_AGE_SECONDS`）。
4. **结账回跳。** store 的 `returnTo` 只接受 `*.qhkly.com`，不能直接跳回 App。目前靠窗口焦点刷新和轮询感知购买完成；
   如果希望支付后自动回到 App，需要注册自定义 URL scheme（deep link），并在 store 端加白名单。
5. **账号不一致。** 商店在浏览器里自己走一次 auth 登录。如果用户在浏览器里登录了另一个账号，会员会记到那个账号上。
   界面已提示「请使用同一账号付款」。如需强制一致，store 结账页要支持登录提示参数（比如 `login_hint`）。
