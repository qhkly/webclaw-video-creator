# webclaw-video-creator

Desktop tool for generating technical videos from scripts, ideas, or lesson outlines.

The app is built as an independent project in this workspace and does not share runtime code with `webclaw-launcher-tauri`.

## Stack

- Tauri 2 desktop shell
- React + Vite frontend
- Remotion preview and render pipeline
- Edge TTS voice generation, with an F5-TTS integration point reserved for later voice cloning
- FFmpeg via `ffmpeg-static`

## Text-Based Cutter (文字剪辑)

Lightweight AI editor for talking-head / product-demo videos: edit the transcript, and the video follows. It is the first workflow step after the AI Director page (`00 文字剪辑`) and has its own preview and export; the title-bar Preview/Export shortcuts belong to the scene workflow and are hidden on this page.

The transcript and cut decisions are kept in memory while the app runs (switching pages is safe) but are not saved across restarts yet; export before quitting.

1. **Import** a local video (mp4 / mov / m4v / mkv / webm / avi). The source file is never modified.
2. **Transcribe** through `scripts/transcribe.mjs`, which wraps swappable providers configured in Settings → 语音识别:
   - `openai`: any OpenAI-compatible `POST {baseUrl}/audio/transcriptions` endpoint (verbose_json with segment and word timestamps)
   - `whisper-cpp`: local `whisper-cli` plus a `ggml-*.bin` model (segment timestamps)
   - `silence`: always available, needs no keys. FFmpeg `silencedetect` splits speech into editable placeholder segments.
   - `auto` (default): uses openai if a key is set, else whisper-cpp if a model is set, else silence. If the chosen engine fails, it falls back to silence and shows a visible warning.
3. **Edit by text**: select words and press Delete (press it again to restore), use the per-segment delete/restore buttons, click a pause chip, or fix recognition errors with the pencil button. Every change can be undone (⌘Z / ⇧⌘Z).
   AI suggestions (去语气词 / 删长停顿) appear as amber dashed strike-through and can be reverted in one click (撤销 AI 改动).
4. **Preview**: the player skips removed ranges in real time. The strip under the video shows the kept ranges, and source and output timestamps are shown side by side.
5. **Export** through `scripts/cut-export.mjs`: an FFmpeg trim/concat filtergraph with short audio fades at each cut, encoded as H.264 + AAC MP4.

Edit decisions live in `src/lib/cut-plan.ts`. The transcript becomes a gap-free timeline of word, segment and pause units, and cut units become source-time keep ranges. That file has no dependencies and is unit-tested.

CLI equivalents:

```bash
node scripts/transcribe.mjs --input demo.mp4 --provider auto --options '{}'
node scripts/cut-export.mjs --input demo.mp4 --ranges '[{"start":0,"end":3.6},{"start":6.2,"end":14.3}]' --output demo_cut.mp4
```

## Features

- Script editor with manual scene splitting by blank lines
- Scene manager for template, narration, duration, and props editing
- Remotion `<Player>` preview inside the app
- Export flow that saves scene JSON and runs Remotion renderer through a Node sidecar
- Tauri commands for TTS, render progress, and audio/video combining

## Development

Install dependencies:

```bash
npm ci
```

Runtime requirement: TTS, render, the Cutter and the AI Director's MCP tools all run Node sidecars from this project
directory (`scripts/*.mjs`, `mcp/server.mjs`) and need `node` (18+) plus the installed `node_modules` (`ffmpeg-static`,
Remotion, Edge TTS). `node` is resolved from the login-shell PATH (nvm / Homebrew / Volta), so this also works when the
app is started from Finder. A packaged build still resolves the project directory at compile time, so it is not yet a
self-contained installer.

Start the Tauri app:

```bash
npm run tauri:dev
```

Start only the Vite frontend:

```bash
npm run dev
```

Build frontend assets:

```bash
npm run build
```

Build the desktop app:

```bash
npm run tauri:build
```

Preview Remotion templates:

```bash
npm run remotion:preview
```

## Agent MCP Server

Video capabilities are also exposed as atomic MCP tools so a coding agent (Claude Code, Codex, …) can direct the
whole production itself: `video_project_status`, `video_brand_profile_get`, `video_providers_list`,
`video_media_probe`, `video_scenes_save`, `video_tts_synthesize`, `video_render`, `video_audio_mux`.

```bash
npm run mcp     # stdio MCP server; workspace = $VIDEO_CREATOR_WORKSPACE or .video-work
```

The app's first screen is the **AI Director** page: it runs the user's own Claude Code / Codex headless with only these
video tools available (no shell, no code edits), streams progress, asks for confirmation where needed and previews results.
`npm run tauri*` goes through `scripts/tauri.mjs`, which drops build config leaked from a parent Tauri app (e.g. when started
from a WebCode AI Studio session) so the window never loads another app's frontend.

Claude Code picks it up from `.mcp.json`. Architecture, Brand DNA format and roadmap: [docs/agent-director.md](docs/agent-director.md).

## Tests

```bash
npm test   # node --test: cut-plan logic, FFmpeg filter/ASR parsing, a real FFmpeg transcribe → cut → export run, MCP protocol + tools
```

If `ffmpeg-static` fails to run (for example, a truncated download leaves a small binary that exits with 137), reinstall it with `node node_modules/ffmpeg-static/install.js`, or set `FFMPEG_PATH`.

## Smoke Tests

Generate a short TTS file:

```bash
node scripts/tts.mjs \
  --text "Hello world" \
  --voice "en-US-JennyNeural" \
  --output /tmp/webclaw-video-creator-test.mp3
```

Render a video from a scenes JSON file:

```bash
node scripts/render.mjs \
  --scenes /tmp/scenes.json \
  --outputDir /tmp/webclaw-video-render-test
```

## GitHub Actions Release

The release workflow is based on `webcode-i18n-manager`.

It supports:

- macOS arm64
- macOS Intel x64
- Linux x64
- Linux arm64
- Windows x64
- GitHub Release creation when pushing a `v*` tag

Manual package build:

```bash
gh workflow run Release
```

Tag release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

If signing is required, configure these repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

## Project Layout

```text
src/             React app
remotion/        Remotion compositions
scripts/         Node sidecars for TTS and rendering
mcp/             MCP server exposing video tools to coding agents
docs/            Architecture notes
src-tauri/       Tauri Rust shell and commands
.github/         CI and release workflows
```
