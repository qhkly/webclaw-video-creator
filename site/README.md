# WebClaw Video Creator — product site

Hand-written static pages, zero dependencies, no build step. Same shape as the
`webcode-ai-studio-site` public site: `index.html` (EN) + `zh/index.html` (ZH),
plus `privacy.html` / `terms.html` in both languages.

```
site/
├── index.html            EN landing (hero → screenshots → workflow → features →
│                         stack → pricing → roadmap → FAQ → get started → footer)
├── privacy.html          EN privacy policy
├── terms.html            EN terms
├── zh/                   ZH mirrors of the three pages
├── robots.txt / sitemap.xml
└── assets/
    ├── css/site.css      light + dark themes via CSS variables
    ├── js/config.js      ← all external URLs live here (see below)
    ├── js/site.js        theme toggle, reveal-on-scroll, lightbox, config hydration
    └── img/              logo/favicon SVG + neutral placeholder screenshot SVGs
```

## Central constants

Every outbound URL and the current version are defined once in
`assets/js/config.js` (`window.WVC_CONFIG`). The pages carry the same values as
plain `href` defaults so they work without JS; `site.js` re-points every
`[data-link]` href, `[data-version]` span, and the canonical/`og:url` tags from
the config. Before deploying:

1. Replace the placeholder `siteUrl` (`https://creator.qhkly.com`) with the real
   domain — also update `robots.txt`, `sitemap.xml`, and the canonical/hreflang/
   OG/JSON-LD URLs in the four HTML heads.
2. Keep `version` in sync with `src-tauri/tauri.conf.json`.
3. `downloadUrl` points at GitHub Releases (populated by
   `.github/workflows/release.yml` on every `v*` tag); `storeUrl` at the WebClaw
   Store product page for `webclaw-video-creator`.

## Content rules

The copy deliberately mirrors what the app can do today (AI director via the
user's own Claude Code / Codex / ChatGPT, text-based cutter, scene workflow,
Remotion preview, Edge TTS, GPT Image via the Codex OAuth login, MP4 export).
Do not add claims for AI video-clip generation, voice cloning, auto-updates, or
a self-contained installer — check `README.md` at the repo root and
`docs/agent-director.md` before editing feature/roadmap copy.

## Preview locally

```bash
cd site && python3 -m http.server 8090
# → http://127.0.0.1:8090
```

Deployment is not wired up yet; the pages are deployable as-is to any static
host (GitHub Pages, Cloudflare Pages) once the domain in step 1 above is final.
