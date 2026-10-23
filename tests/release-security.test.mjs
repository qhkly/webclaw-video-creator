import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRelease } from '../scripts/check-release-security.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vc-release-'));
  cpSync(path.join(repo, 'package.json'), path.join(dir, 'package.json'));
  mkdirSync(path.join(dir, 'vendor'));
  cpSync(path.join(repo, 'vendor/webcode-support-ui-0.1.6.tgz'), path.join(dir, 'vendor/webcode-support-ui-0.1.6.tgz'));
  cpSync(path.join(repo, 'src-tauri/src/commands/support_commands.rs'), path.join(dir, 'src-tauri/src/commands/support_commands.rs'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
const rules = (dir) => checkRelease(dir).map((f) => f.rule);

test('the repository itself passes the release security check', () => {
  assert.deepEqual(checkRelease(repo), []);
});

test('planted secrets, signing code and copied UI are caught', () => {
  const dir = fixture({
    'src/a.ts': 'const k = "-----BEGIN PRIVATE KEY-----";',
    'src/b.ts': 'import { createHmac } from "node:crypto"; createHmac("sha256", x);',
    'src/c.ts': 'fetch(u, { body: JSON.stringify({ client_secret: "x" }) })',
    'dist/index.js': 'var SUPPORT_TICKET_SIGNING_KEY="x"',
    'src/support-ui/index.js': 'export {}',
  });
  try {
    const found = rules(dir);
    for (const rule of ['secret-in-shipped-code', 'client-side-signing', 'support-ui-copied']) assert.ok(found.includes(rule), rule);
    assert.ok(checkRelease(dir).filter((f) => f.rule === 'secret-in-shipped-code').length >= 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a tampered or missing tarball fails; a Rust relay that sends identity fields fails', () => {
  const dir = fixture();
  try {
    writeFileSync(path.join(dir, 'vendor/webcode-support-ui-0.1.6.tgz'), 'not the pinned build');
    assert.ok(rules(dir).includes('support-ui-tarball'));
    writeFileSync(path.join(dir, 'src-tauri/src/commands/support_commands.rs'), 'json!({ "uid": "u_x", "subject_token_type": "support_grant" })');
    assert.ok(rules(dir).includes('ticket-relay'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
