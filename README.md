# webclaw-video-creator

Desktop tool for generating technical videos from scripts, ideas, or lesson outlines.

The app is built as an independent project in this workspace and does not share runtime code with `webclaw-launcher-tauri`.

## Stack

- Tauri 2 desktop shell
- React + Vite frontend
- Remotion preview and render pipeline
- Edge TTS voice generation, with an F5-TTS integration point reserved for later voice cloning
- FFmpeg via `ffmpeg-static`

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
src-tauri/       Tauri Rust shell and commands
.github/         CI and release workflows
```
