#!/usr/bin/env node
// stdio entry for the Video Creator MCP server.
//
//   node mcp/server.mjs [--workspace <dir>]
//
// Transport: newline-delimited JSON-RPC on stdin/stdout. stdout carries protocol
// messages only; logs go to stderr. Workspace defaults to $VIDEO_CREATOR_WORKSPACE
// or <app>/.video-work.
import { createInterface } from 'node:readline';
import { createContext } from './context.mjs';
import { createMcpServer } from './protocol.mjs';
import { tools } from './tools.mjs';

const workspaceFlag = process.argv.indexOf('--workspace');
const ctx = createContext({ workspace: workspaceFlag >= 0 ? process.argv[workspaceFlag + 1] : undefined });
const log = (message) => process.stderr.write(`[video-creator-mcp] ${message}\n`);
const server = createMcpServer({ tools, ctx, log });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

log(`workspace ${ctx.workspace}; ${tools.length} tools`);

const pending = new Set();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  // Requests run concurrently so a long render does not block status queries.
  const task = server
    .handle(message, send)
    .then((response) => response && send(response))
    .catch((error) => log(`unhandled: ${error.stack || error.message}`))
    .finally(() => pending.delete(task));
  pending.add(task);
});
lines.on('close', async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
