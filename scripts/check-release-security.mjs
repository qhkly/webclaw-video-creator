#!/usr/bin/env node
// Release gate for the customer-support integration (and secret hygiene in general).
// Fails (exit 1) if anything that could leak a credential, or let the client mint its own support
// identity, is present in what ships: source, Rust, scripts, MCP server and the built bundle.
//
//   node scripts/check-release-security.mjs            # source + dist/ if built
//   node scripts/check-release-security.mjs --root <d> # (tests) check another tree
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bump together with vendor/webcode-support-ui-*.tgz (docs/support-widget.md). */
export const SUPPORT_UI_TGZ = { file: 'vendor/webcode-support-ui-0.1.6.tgz', sha256: '342b1f3a8124d1705ce4c2f7d47a924c272c12f8171ac42d7993249178919975' };

const SHIPPED = ['src', 'src-tauri/src', 'src-tauri/tauri.conf.json', 'src-tauri/capabilities', 'remotion/src', 'mcp', 'scripts', 'index.html', 'dist'];
const SKIP_DIRS = new Set(['node_modules', 'target', '.git', 'assets']);
const SKIP_FILES = new Set(['check-release-security.mjs']); // this file names the patterns
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|html|css|rs|toml|md|txt|map)$/i;

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key material'],
  [/SUPPORT_TICKET_SIGNING_KEY|SUPPORT_UID_KEY|SUPPORT_TICKET_EXTRA_JWKS/, 'Auth support signing/uid secret name'],
  [/SIGN_SECRET(_[A-Z0-9_]+)?\b/, 'legacy support signing secret name'],
  [/STORE_CLIENT_SECRET|BILLING_CLIENTS_[A-Z_]+/, 'store credential name'],
  [/client_secret/i, 'OAuth client_secret (this is a public client; it must not carry one)'],
  [/"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/, 'JWK private component'],
  [/\bsg1_[A-Za-z0-9_-]{20,}/, 'a real-looking support grant'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a hard-coded JWT'],
];

// The browser/webview side must never sign anything.
const CLIENT_SIGNING = /\b(createSign|createHmac|subtle\.sign|importKey\s*\(\s*['"](?:jwk|pkcs8))/;

function* walk(dir) {
  if (!existsSync(dir)) return;
  const stat = statSync(dir);
  if (stat.isFile()) { yield dir; return; }
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(path.join(dir, name));
  }
}

export function checkRelease(root = process.cwd()) {
  const findings = [];
  const fail = (rule, where, detail) => findings.push({ rule, where, detail });
  const rel = (p) => path.relative(root, p) || p;

  // 1. The shared UI comes from the pinned tarball, not from copied source.
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.dependencies?.['@webcode/support-ui'] !== `file:${SUPPORT_UI_TGZ.file}`) {
    fail('support-ui-dependency', 'package.json', '@webcode/support-ui must be file:' + SUPPORT_UI_TGZ.file);
  }
  const tgz = path.join(root, SUPPORT_UI_TGZ.file);
  if (!existsSync(tgz)) fail('support-ui-tarball', SUPPORT_UI_TGZ.file, 'missing');
  else {
    const sha = createHash('sha256').update(readFileSync(tgz)).digest('hex');
    if (sha !== SUPPORT_UI_TGZ.sha256) fail('support-ui-tarball', SUPPORT_UI_TGZ.file, `sha256 ${sha} does not match the pinned build`);
    try {
      const names = execFileSync('tar', ['tzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean);
      const bad = names.filter((n) => /(^|\/)(test|demo|\.env|\.dev\.vars)/.test(n) || /\.(pem|key)$/.test(n));
      if (bad.length) fail('support-ui-tarball', SUPPORT_UI_TGZ.file, `contains ${bad.join(', ')}`);
    } catch { fail('support-ui-tarball', SUPPORT_UI_TGZ.file, 'cannot list tarball'); }
  }
  const lockPath = path.join(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const entry = JSON.parse(readFileSync(lockPath, 'utf8')).packages?.['node_modules/@webcode/support-ui'];
    if (!entry?.integrity) fail('support-ui-lock', 'package-lock.json', 'no integrity for @webcode/support-ui');
  }
  if (existsSync(path.join(root, 'src/support-ui')) || existsSync(path.join(root, 'src/lib/support-ui'))) {
    fail('support-ui-copied', 'src', 'shared support UI source must not be copied into this repo');
  }

  // 2. No secrets or signing code in anything that ships.
  for (const entry of SHIPPED) {
    for (const file of walk(path.join(root, entry))) {
      if (!TEXT.test(file) || SKIP_FILES.has(path.basename(file))) continue;
      let text = readFileSync(file, 'utf8');
      if (file.endsWith('.rs')) text = text.split('#[cfg(test)]')[0]; // unit-test fixtures are not shipped
      for (const [pattern, label] of SECRET_PATTERNS) {
        if (pattern.test(text)) fail('secret-in-shipped-code', rel(file), label);
      }
      const inBrowserCode = /^(src|dist)[\\/]/.test(rel(file));
      if (inBrowserCode && CLIENT_SIGNING.test(text)) fail('client-side-signing', rel(file), 'webview code must not sign anything');
    }
  }

  // 3. The support ticket command exists and is the only way credentials reach the page.
  const rust = path.join(root, 'src-tauri/src/commands/support_commands.rs');
  const lib = path.join(root, 'src-tauri/src/lib.rs');
  if (!existsSync(rust)) fail('ticket-relay', 'src-tauri/src/commands/support_commands.rs', 'missing');
  else {
    const code = readFileSync(rust, 'utf8').split('#[cfg(test)]')[0];
    if (!/subject_token_type"?\s*:\s*"support_grant"/.test(code)) fail('ticket-relay', rel(rust), 'must trade the support_grant');
    if (/"(uid|sub|email|plan)"\s*:/.test(code)) fail('ticket-relay', rel(rust), 'the ticket request must not send identity fields');
  }
  if (existsSync(lib) && !/support_ticket/.test(readFileSync(lib, 'utf8'))) fail('ticket-relay', 'src-tauri/src/lib.rs', 'support_ticket not registered');

  // 4. No env/secret files tracked.
  try {
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n');
    const bad = tracked.filter((f) => /(^|\/)(\.env(\..+)?|\.dev\.vars|.*\.pem|.*\.p12)$/.test(f) && !/\.example$/.test(f));
    for (const f of bad) fail('tracked-secret-file', f, 'must not be committed');
  } catch { /* not a git checkout (tests) */ }

  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? path.resolve(process.argv[i + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const findings = checkRelease(root);
  const built = existsSync(path.join(root, 'dist'));
  if (findings.length) {
    for (const f of findings) console.error(`FAIL [${f.rule}] ${f.where}: ${f.detail}`);
    process.exit(1);
  }
  console.log(`release security check passed${built ? '' : ' (dist/ not built: bundle not scanned; run after npm run build)'}`);
}
