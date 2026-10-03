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
| `video_render` | `scripts/render.mjs`（Remotion），支持 `notifications/progress` | 本地写，确定性 |
| `video_audio_mux` | FFmpeg 混音（Tauri `combine_audio_video` 的改进版：保留原音轨和视频时长） | 本地写，确定性 |

Agent 能看到的描述包括：`initialize.instructions`（导演工作方式）、每个工具的 `description` / `inputSchema` / `annotations`（readOnly、idempotent 等）。

### 规划中的工具（按能力边界预留）

| 能力 | 计划工具 | 依赖 |
|---|---|---|
| 转写 | `video_transcribe` → `scripts/transcribe.mjs` | Cutter MVP 合并后薄封装 |
| 剪切计划 | `video_cut_plan_suggest` / `video_cut_export` → `cut-plan.ts` + `scripts/cut-export.mjs` | 同上；剪什么由 Agent 判断，计算和导出在本地执行 |
| 字幕 | `video_captions_export`（words.json → SRT/ASS） | 纯本地 |
| 素材 | `video_assets_search`（Pexels）、`video_assets_import`（用户素材/录屏入库） | 现有 `fetch-assets.mjs` |
| 预览 | `video_preview_frames`（抽帧给 Agent 视觉自检） | FFmpeg |
| 图片/视频生成 | `video_image_generate` / `video_clip_generate` | 付费 Provider 适配器，按需配置 key |
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

## 与 Cutter MVP 的兼容

- MCP 代码全部在新目录（`mcp/`、`tests/mcp.test.mjs`、`scripts/lib/stage-media.mjs`），不改动任何页面。
- `package.json` 的 `test` 脚本与 Cutter 分支完全一致，试合并无冲突。
- `mcp/context.mjs` 的 `findFfmpeg` 与 Cutter `scripts/lib/media.mjs` 使用相同的解析顺序；合并后应改为直接 import Cutter 的实现，去掉重复代码。
- 顺带修复了一个现有 bug：带 TTS 音频的场景导出时，Remotion 拒绝 `file://` 路径。`render.mjs` 现在先把本地媒体放进 publicDir，再改写为 `static:` 路径；`mediaSrc()` 遇到 `static:` 时走 `staticFile()`。应用内 Player 不受影响。
