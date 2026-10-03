#!/usr/bin/env node
// `npm run tauri*` entry: run the Tauri CLI with leaked parent-app build
// variables removed (see scripts/lib/tauri-env.mjs). All arguments pass through.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { sanitizeTauriEnv } from './lib/tauri-env.mjs';

const require = createRequire(import.meta.url);
const cli = require.resolve('@tauri-apps/cli/tauri.js');
const { env, removed } = sanitizeTauriEnv(process.env);
if (removed.includes('TAURI_CONFIG')) {
  console.error(`[video-creator] ignored inherited TAURI_CONFIG=${process.env.TAURI_CONFIG} (leaked from a parent Tauri app)`);
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
