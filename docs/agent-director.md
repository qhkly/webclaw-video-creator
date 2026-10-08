# Agent 导演 + 视频 MCP 工具箱

一句话：**编程 CLI Agent 负责规划和判断，Video Creator 只提供原子化的视频能力。**产品里不写死"AI 工作流"。

```
用户任务 ──▶ Claude Code / Codex / Gemini CLI …（用户自己的套餐，负责推理）
                 │  读取 Brand DNA，自主规划：写脚本 → 分镜 → 配音 → 渲染 → 合成
                 ▼  MCP（stdio，node mcp/server.mjs）
        ┌──────────────── Video Creator MCP 工具箱 ────────────────┐
        │ 薄封装：调用现有 scripts/*.mjs、FFmpeg、scenes.json        │
        │ 确定性工作在本地执行，不调用任何 LLM                        │
        └──────┬──────────────┬───────────────┬────────────────────┘
               ▼              ▼               ▼
         TTS Provider     Remotion 渲染     FFmpeg 探测/合成     （图/视频生成 Provider：预留插槽）
```

## 分层与约束

| 层 | 职责 | 不做什么 |
|---|---|---|
| Agent（外部 CLI） | 理解任务、写稿、选模板、决定流程顺序、检查结果并重试 | 不直接拼 FFmpeg 命令（交给工具） |
| MCP 工具（`mcp/tools.mjs`） | 参数校验、路径沙箱、调用已有能力、返回结构化结果 | 不写业务流程，不调用 LLM |
| Provider（`mcp/providers.mjs`） | 把"生成请求"变成媒体文件，标明 `billing: free/local/paid` | 不承担 Agent 推理；Claude/OpenAI API 不进视频主链 |
| 现有能力（`scripts/*.mjs`、Remotion、Tauri 命令） | 真正干活 | 不感知 MCP；UI 和 MCP 共用同一份实现 |

- **不重写**：TTS、渲染直接 spawn `scripts/tts.mjs` 和 `scripts/render.mjs`，参数与 Tauri 命令一致。`video_tts_synthesize` 绑定到场景时，写回规则与编辑器"生成配音"按钮相同。
- **写入沙箱**：工具写出的所有文件都落在 workspace 内（`$VIDEO_CREATOR_WORKSPACE`，默认 `<app>/.video-work`）。读取允许绝对路径，方便处理用户录屏和素材。
- **工具错误与协议错误分开**：参数错误、文件缺失等返回 `isError: true` 和可执行的提示，让 Agent 自行修正；未知工具和方法才返回 JSON-RPC 错误。

## 从 webcode-ai-studio 复用的思路（复用思想，不复制 UI）

| AI Studio 机制 | 位置 | 在这里的对应 |
|---|---|---|
| MCP server 把产品能力暴露成工具，由 Agent 编排 | `core/src/mcp_server/tools_studio.rs` | `mcp/tools.mjs`：每个工具是 `{name, description, inputSchema, annotations, handler}` |
| `run_tool` 统一包装：超时、结果序列化、错误转换 | `tools_worker.rs` `run_tool/tool_result` | `protocol.mjs` `callTool`：统一 `structuredContent` + `isError` |
| 项目级 `.mcp.json` 注册，CLI 会话自动发现 | `.mcp.json`（studio http server） | 本项目根目录 `.mcp.json`（stdio） |
| MCP server 注册、启停、列举（读写 `~/.claude/settings.json`） | `commands/mcp_commands.rs` | 下一阶段：Video Creator 设置页一键把本 server 注册到 Claude Code / Codex |
| 会话调度：`studio_create_session(cli_type, task, model, provider_id)` | `tools_studio.rs` | 下一阶段：在 UI 里"把任务交给 Agent"，复用 AI Studio 的会话层，或直接调用其 MCP |
| Runtime 原则：统一抽象 + 薄适配器，可选组件不得影响主路径 | `docs/RUNTIME_ARCHITECTURE.md` | Provider 适配器；MCP 层是加法，不改变 UI 路径 |

## MCP 工具目录（第一阶段）

| 工具 | 封装的现有能力 | 性质 |
|---|---|---|
| `video_project_status` | workspace / projects / scenes.json / 音频与渲染产物 | 只读，建议第一个调用 |
| `video_brand_profile_get` | Brand DNA（见下文） | 只读 |
| `video_providers_list` | Provider 注册表 + 可用性探测 | 只读 |
| `video_media_probe` | `ffmpeg -i` 解析（与 Cutter 的 `probeMedia` 一致） | 只读，确定性 |
| `video_scenes_save` | 校验并写 `scenes.json`（等价 Tauri `save_scenes_json`，外加校验） | 本地写，确定性 |
| `video_tts_synthesize` | `scripts/tts.mjs`（edge / f5 克隆声音） | 本地写，调用 Provider |
| `video_image_generate` | `openai-oauth-image`：本机 Codex OAuth 登录态 + `@openai-oauth/ai-sdk` 调 `gpt-image-2`，ffmpeg 统一裁成 1920x1080 / 1080x1920 / 1080x1080 PNG 写入 `assets/` | 付费（消耗账户额度），始终需审批 |
| `video_render` | `scripts/render.mjs`（Remotion），支持 `notifications/progress` | 本地写，确定性 |
| `video_audio_mux` | FFmpeg 混音（Tauri `combine_audio_video` 的改进版：保留原音轨和视频时长） | 本地写，确定性 |
| `video_director_plan` | Director 工作流入口：保存分镜 + brief + 素材盘点，跑确定性检查 | 本地写，确定性 |
| `video_director_preview` | 720p 预览渲染 + 逐场景中间帧 + 联络表（contact sheet），并作为 image content 附给上层模型 | 本地写，确定性 |
| `video_director_frames` | 按 round/sceneId 重读审片帧，作为 image content 返回（远程 Agent 真正"看到"） | 只读，确定性 |
| `video_director_review` | 记录评审结论（findings + verdict），合并确定性检查 | 本地写，确定性 |
| `video_director_finalize` | 门禁通过后的正式渲染（audio-first + review 双门禁，可 override） | 本地写，确定性 |

Agent 能看到的描述包括：`initialize.instructions`（导演工作方式）、每个工具的 `description` / `inputSchema` / `annotations`（readOnly、idempotent 等）。

**图像直传（通用协议能力）**：任何 tool handler 都可以在返回值里附带 `mcpImages: [{data, mimeType, title?}]`（base64），`protocol.mjs` 会把它转成 `tools/call` 结果里的 `{type:'image'}` content block（置于 text 之前），并从 `structuredContent`/text JSON 中剥离该键。单图上限约 1.1MB、单次调用总量约 4.5MB，超限的图会被丢弃并附说明——本地路径始终在 `structuredContent` 里作为兜底。这样通过 Secure Tunnel 调用的 ChatGPT/Claude 不需要读本机文件就能真正看到审片帧。

## Director 工作流（autoproduce）

一键成片的"导演循环"不做成黑盒，而是拆成 4 个可组合的工具，审美判断始终在 Agent 手里，工具只负责持久化状态、跑确定性检查和驱动现有渲染/TTS sidecar：

```
brief ─▶ video_director_plan ─▶ video_tts_synthesize（逐场景，audio-first）
                                    │
              ┌─────────────────────▼──────────────────────┐
              │ video_director_preview（720p + 抽帧 + 联络表） │
              │ Agent 看帧，形成评审意见                        │
              │ video_director_review（findings + verdict）    │
              │   verdict=revise → 只改被点名的场景 → 再 preview │
              │   verdict=pass   → approved                    │
              └─────────────────────┬──────────────────────┘
                                    ▼
                        video_director_finalize（正式渲染）
```

- **阶段状态机**：`planned → previewed → revising → approved → done`，持久化在 `projects/<id>/director/state.json`；每轮 preview/review 的产物落在 `director/previews/round-N/`、`director/reviews/round-N.json`，revise 会开启下一轮而不是覆盖上一轮的评审材料。
- **审片帧直传**：preview 默认把 contact sheet（1024px 宽）+ 至多 4 张代表帧（640px，JPEG）作为 MCP image content 附在结果里（`images: false` 可关）；`video_director_frames` 可按 round/sceneId 重读任意帧，供修改后复查。上限控制见上文"图像直传"。
- **返回契约**：每个 director 工具都返回 `{ phase, artifacts, nextStep }`，失败时 `isError` 带明确的失败点，Agent 不需要记住流程。
- **确定性检查**（`mcp/director.mjs` `runDirectorChecks`）：audio-first（有 narration 无 audio = blocker）、时长漂移 >1.6s、字幕覆盖、连续纯文字卡片 >2、标题溢出（按画幅区分阈值）、结尾 CTA 缺失提示。`video_director_review` 会把这些和 Agent 的 findings 合并，blocker 存在时 verdict=pass 也不会 approved。
- **finalize 门禁**：audio-first + review approved 双门禁；`override: true` 需要理由并记录在状态里——用户是最终裁判。
- **免费原则**：director 工具本身没有 `planFeature`（自有额度/本地计算能力对免费用户开放）；预览固定 720p，正式渲染仍走 `video_render` 的 plan 限制（免费 = 720p + 水印）。`video_image_generate` 保持原有的按次审批语义不变。
- 视觉规范见 `docs/remotion-best-practices.md`（内嵌自 remotion-dev/skills 官方最佳实践）。

### 规划中的工具（按能力边界预留）

| 能力 | 计划工具 | 依赖 |
|---|---|---|
| 转写 | `video_transcribe` → `scripts/transcribe.mjs` | Cutter MVP 合并后薄封装 |
| 剪切计划 | `video_cut_plan_suggest` / `video_cut_export` → `cut-plan.ts` + `scripts/cut-export.mjs` | 同上；剪什么由 Agent 判断，计算和导出在本地执行 |
| 字幕 | `video_captions_export`（words.json → SRT/ASS） | 纯本地 |
| 素材 | `video_assets_search`（Pexels）、`video_assets_import`（用户素材/录屏入库） | 现有 `fetch-assets.mjs` |
| 预览 | `video_preview_frames`（抽帧给 Agent 视觉自检） | FFmpeg |
| 视频生成 | `video_clip_generate` | 付费 Provider 适配器，按需配置 key |
| 长任务 | `video_job_start/status/cancel` | 渲染超过客户端超时后改为 job 模型 |

## Brand DNA（个人 IP 配置）

位置：`<workspace>/brand/<profile>.json`。可以手写，也可以由 Agent 按 `video_brand_profile_get` 返回的结构创建。缺失字段用默认值深合并。

```jsonc
{
  "displayName": "…",
  "voice":   { "provider": "f5", "voiceId": "…", "cloneReference": "brand/voice-ref.wav", "rate": "+0%" },
  "persona": { "audience": "…", "tone": "…", "pointsOfView": [], "mustSay": [], "avoid": [], "language": "zh-CN" },
  "visual":  { "aspect": "9:16", "palette": { "background": "…", "text": "…", "accent": "…" }, "fontFamily": null, "preferredTemplates": [], "logo": null },
  "captions":{ "enabled": true, "position": "bottom", "fontSize": 48, "activeColor": "#facc15", "inactiveColor": "#ffffff" },
  "music":   { "mood": "…", "bgm": [], "volume": 0.15 },
  "assets":  [{ "id": "intro", "path": "brand/intro.mp4", "kind": "video", "notes": "…" }]
}
```

工具会消费 Brand DNA 的默认值：TTS 用 `voice.provider` / `voice.voiceId`，渲染用 `visual.aspect` 和 `captions`。`persona` 只给 Agent 写稿时遵守。

## 接入方式

- **Claude Code**：在本项目目录启动时自动读取 `.mcp.json`；在其他目录使用时执行
  `claude mcp add video-creator -- node <app>/mcp/server.mjs --workspace <dir>`
- **Codex**：在 `~/.codex/config.toml` 中添加
  ```toml
  [mcp_servers.video-creator]
  command = "node"
  args = ["<app>/mcp/server.mjs", "--workspace", "<dir>"]
  ```
- 手动调试：`npm run mcp`（stdin/stdout 使用换行分隔的 JSON-RPC，日志输出到 stderr）。

## 前台：Video Creator 自己的 Agent 入口（视频产品化裁剪）

### 为什么启动后出现完整 AI Studio 首页（已修复）

Video Creator 的代码里从来没有 AI Studio UI，问题出在**启动链路的环境变量泄漏**：

1. WebCode AI Studio 本身以 `tauri dev` 运行，Tauri CLI 会给 App 进程注入 `TAURI_CONFIG={"build":{"devUrl":"http://127.0.0.1:1430"}}`（另外还有 `CARGO_PKG_NAME=webcode-ai-studio`、`TAURI_ENV_*` 等）；
2. AI Studio 拉起的每个 Claude Code / Codex 会话和终端都会继承这份环境；
3. 在这样的会话里执行 Video Creator 的 `npm run tauri:dev`，Tauri CLI 会把继承来的 `TAURI_CONFIG` 合并进本项目配置，devUrl 被改成 1430；
4. 结果是窗口标题写着「WebClaw Video Creator」，加载的却是 AI Studio 的前端（工程管理首页）。

已复现并修复：

- `npm run tauri*` 改走 `scripts/tauri.mjs`，先用 `scripts/lib/tauri-env.mjs` 清掉泄漏的 `TAURI_CONFIG` / `TAURI_ENV_*` / `CARGO_PKG_*` 等，再调用 Tauri CLI。`TAURI_SIGNING_*` 等发布签名变量保留，CI 的 `npm run tauri:build -- --target …` 参数原样透传；
- dev 端口从 Tauri 模板默认的 1420（与 dockyard、opentypeless 等本机项目共用）改为 1471，避免 debug 窗口误连其他项目的 dev server；
- `agent_start` 启动 CLI 时同样移除 `TAURI_CONFIG`。

验证：在仍带有泄漏变量的会话里重新启动，窗口首屏就是「AI 导演」，WebKit 只连接 1471。

建议在 AI Studio 一侧也修正：拉起会话时不要把自己的 `TAURI_CONFIG` / `CARGO_*` 传给子进程。

### 保留什么，不保留什么

| 保留（视频用户需要的） | 实现 |
|---|---|
| 简洁的 Agent 任务入口（首屏） | `src/pages/AgentPage.tsx`：一个输入框、示例任务、项目名、开始/停止 |
| Claude Code / Codex 的选择与运行状态 | 默认自动选择，展示版本与状态；CLI、模型、确认策略收在「高级」里 |
| 任务进度、工具调用、需要确认的操作 | 时间线：Agent 文本、每次视频工具调用及结果；确认卡片（允许/拒绝）置顶 |
| 中间结果与成片预览 | 结果面板：最新渲染视频（asset 协议，范围仅 `.video-work`）、渲染列表、场景数 |
| 脚本、场景、预览、导出（以及合并后的 Cutter）工作区 | 原有页面不变；「在场景编辑器中打开」把 Agent 产出的分镜接入现有编辑器 |
| 必要的登录与设置 | 现有设置页；未安装或未登录 CLI 时给出安装和登录提示（登录在 CLI 内完成） |

| 不保留（面向程序员的 Studio UI） | 原因 |
|---|---|
| 添加代码文件夹、新建代码工程、工程扫描与导航 | 视频用户只需要「视频项目」，使用 `.video-work/projects/<id>` |
| Git / worktree 管理 | Agent 不写代码；workspace 只存视频产物 |
| 通用多 CLI 管理器、会话列表、终端 | 只保留一次一个任务的 Agent 运行；CLI 选择收进「高级」 |
| AI 管理器、编排器、专家台等 | 与视频创作无关 |

### 复用 AI Studio 的什么（能力，而不是界面）

- **找到 CLI**：AI Studio `login_shell_path` 的做法——从 Dock 启动的 GUI 进程拿不到 nvm/Homebrew 的 PATH，需要从用户登录 shell 取回真实 PATH，并扫描常见安装目录（`agent_commands.rs::effective_path`）；
- **CLI 会话与状态回传**：headless 运行用户自己的 CLI（`claude -p --output-format stream-json` / `codex exec --json`），事件归一化放在 `src/lib/agent-events.ts`。前台不感知具体是哪个 CLI，新增 CLI 只需加一个 parser，没有写死 DSH 或任何单一 Runtime；
- **MCP 能力暴露**：同一个 `mcp/server.mjs`，每次运行生成 MCP 配置并注入环境变量；
- **审批**：确认闸门放在视频 MCP server 自己里面（`mcp/approval.mjs`，基于文件的请求/决定通道），因此对 Claude Code 和 Codex 行为一致：只读工具从不询问；付费生成总是询问；本地和免费联网工具按策略决定。前台每 0.7 秒轮询并显示确认卡片。

### 安全边界

- Claude Code 以 `--restricted --tools "" --strict-mcp-config` 运行：没有任何内置工具（不能执行 Bash、不能编辑文件），也不读取用户和项目的 settings，只能用 video-creator 的 8 个工具（已实测 `init.tools` 只有这 8 个）；
- Codex 以 `--sandbox read-only` 运行；
- 客户端 MCP 工具超时统一设为 1 小时（Codex 默认 300 秒，等待确认或长时间渲染会超时，已实测）。服务端确认等待 15 分钟后按拒绝处理。

## 与 Cutter MVP 的兼容

- MCP 代码全部在新目录（`mcp/`、`tests/mcp.test.mjs`、`scripts/lib/stage-media.mjs`），不改动任何页面。
- `package.json` 的 `test` 脚本与 Cutter 分支完全一致，试合并无冲突。
- 已合并：`mcp/context.mjs` 直接复用 Cutter `scripts/lib/media.mjs` 的 `findFfmpeg`；所有 Rust 命令（Cutter、TTS、渲染、Agent）通过 `commands/node_env.rs` 用同一套登录 Shell PATH 解析 `node`。
- 已合并：顶栏「预览 / 导出」只属于场景流程（脚本 → 场景 → 预览 → 导出），在 AI 导演与文字剪辑页隐藏；这两页各有自己的结果预览与导出。
- 顺带修复了一个现有 bug：带 TTS 音频的场景导出时，Remotion 拒绝 `file://` 路径。`render.mjs` 现在先把本地媒体放进 publicDir，再改写为 `static:` 路径；`mediaSrc()` 遇到 `static:` 时走 `staticFile()`。应用内 Player 不受影响。
