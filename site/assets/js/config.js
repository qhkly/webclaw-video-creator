/* WebClaw Video Creator — site-wide constants.
   This is the single place to change URLs before deploying:
   the page markup carries matching defaults so the site works without JS,
   and site.js re-points every [data-link] href and the <head> canonical/OG
   tags from the values here. */
(function () {
  'use strict';
  window.WVC_CONFIG = {
    /* Official site origin. Placeholder until the domain is finalized —
       also drives canonical, hreflang, og:url and the JSON-LD url. */
    siteUrl: 'https://creator.qhkly.com',

    /* Download: the release workflow (.github/workflows/release.yml) publishes
       installers for macOS (arm64 + Intel), Windows (x64) and Linux (x64 + arm64)
       as GitHub Releases on every v* tag. */
    downloadUrl: 'https://github.com/qhkly/webclaw-video-creator/releases/latest',
    releasesUrl: 'https://github.com/qhkly/webclaw-video-creator/releases',
    repoUrl: 'https://github.com/qhkly/webclaw-video-creator',
    issuesUrl: 'https://github.com/qhkly/webclaw-video-creator/issues',

    /* Purchase: WebClaw Store product page (30-day free trial / yearly / lifetime). */
    storeUrl: 'https://store.qhkly.com/zh/products/webclaw-video-creator',
    storeUrlEn: 'https://store.qhkly.com/en/products/webclaw-video-creator',
    storeHomeUrl: 'https://store.qhkly.com',

    /* Shown in the hero and the final CTA; keep in sync with src-tauri/tauri.conf.json. */
    version: '0.1.2'
  };
})();
