// OpenAI's official `tunnel-client` binary: locating, verifying and invoking it.
//
// Same pinned release and SHA256 table as WebCode AI Studio (core/src/openai_tunnel.rs),
// so either app can verify a copy the other downloaded. Candidate order:
//   1. VIDEO_CREATOR_TUNNEL_CLIENT_BIN (explicit override; version-checked, errors are reported)
//   2. our own managed cache            (SHA-pinned)
//   3. AI Studio's managed cache         (read-only reuse, SHA-pinned; never written to)
//   4. tunnel-client on PATH             (version-checked)
//   5. download into our managed cache   (archive + binary SHA verified before install)
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const TUNNEL_CLIENT_VERSION = '0.0.12';
export const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_CLIENT_VERSION}`;
export const BIN_OVERRIDE_ENV = 'VIDEO_CREATOR_TUNNEL_CLIENT_BIN';
const AI_STUDIO_IDENTIFIER = 'com.jiayiqiu.webcode-ai-studio';
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

const ASSETS = {
  'linux-x64': { target: 'linux-amd64', archiveSha256: '2bb693bd7b5cd28da7ce09cd9e309529dbb33b7cc9dc0058e62a064688f92c81', binarySha256: 'ee9d4a75bc0b42f36f345aa96231e0db1ab00488122f34ebc99d6db055b6603e' },
  'linux-arm64': { target: 'linux-arm64', archiveSha256: '6813878a3edb82ebebb32fe5a859bc6327a81cce5bc7b635a2313174d26365d6', binarySha256: '0a48e6696de0df5951c013e40be81ce775e6644e209758c48795a0ecbda06406' },
  'darwin-x64': { target: 'darwin-amd64', archiveSha256: '33de53aec680faafedc795f8f8268d6861577bddb871cb2d49529c91f88c2009', binarySha256: '4133dab2575223252732a998210c34b7ed96a51765cf5ea835a8e24cf2be1272' },
  'darwin-arm64': { target: 'darwin-arm64', archiveSha256: '42fb3138dc9c081d5777cb7e8bd1e041cc48b67c4978dbab3c5167ca1aabca02', binarySha256: 'b1757220cf4722cec9085ee4a908cf0ee4c1a499a33bd99979b9a9c7669e29b1' },
  'win32-x64': { target: 'windows-amd64', archiveSha256: '2a2804933924e38a502d62b61f0266cb80d56d65744f4c29876b2bf9c1544356', binarySha256: '6649169733686805ca16cccd91774594d0c017fd729c37ad4ce1cd18323d9ae8' },
  'win32-arm64': { target: 'windows-arm64', archiveSha256: '65ab54221554481bb1c23b6015b99abe0b7f79b08593f4fb17a9e2e25532281d', binarySha256: '480684ec1031fc2985c7e87f9d669e7dfda4012a8ecdab21eabe1b5deafdd656' },
};

export function executableName(platform = process.platform) {
  return platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client';
}

export function assetFor(platform = process.platform, arch = process.arch) {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) {
    return null;
  }
  return { ...asset, fileName: `tunnel-client-v${TUNNEL_CLIENT_VERSION}-${asset.target}.zip`, member: executableName(platform) };
}

/** Tauri's app_data_dir for another app identifier (where AI Studio keeps its managed copy). */
export function tauriAppDataDir(identifier, { platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', identifier);
  }
  if (platform === 'win32') {
    return env.APPDATA ? join(env.APPDATA, identifier) : null;
  }
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), identifier);
}

/** Ordered candidates (pure: no filesystem access) — the order itself is unit-tested. */
export function tunnelClientCandidates({ env = process.env, platform = process.platform, arch = process.arch, home = homedir(), managedRoot } = {}) {
  const asset = assetFor(platform, arch);
  const name = executableName(platform);
  const candidates = [];
  if (env[BIN_OVERRIDE_ENV]) {
    candidates.push({ kind: 'override', path: env[BIN_OVERRIDE_ENV] });
  }
  if (asset && managedRoot) {
    candidates.push({ kind: 'managed', path: join(managedRoot, TUNNEL_CLIENT_VERSION, asset.target, name), sha256: asset.binarySha256 });
  }
  const studio = asset && tauriAppDataDir(AI_STUDIO_IDENTIFIER, { platform, env, home });
  if (studio) {
    candidates.push({ kind: 'ai-studio', path: join(studio, 'tools', 'tunnel-client', TUNNEL_CLIENT_VERSION, asset.target, name), sha256: asset.binarySha256 });
  }
  for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
    candidates.push({ kind: 'path', path: join(dir, name) });
  }
  return candidates;
}

export async function resolveTunnelClient({ managedRoot, env = process.env, log = () => {} } = {}) {
  for (const candidate of tunnelClientCandidates({ env, managedRoot })) {
    if (candidate.kind === 'override') {
      if (!(await isFile(candidate.path))) {
        throw new Error(`${BIN_OVERRIDE_ENV} 指向的不是一个文件: ${candidate.path}`);
      }
      await verifyVersion(candidate.path);
      return { path: candidate.path, source: candidate.kind };
    }
    if (!(await isFile(candidate.path))) {
      continue;
    }
    if (candidate.sha256) {
      if ((await sha256File(candidate.path)) === candidate.sha256) {
        return { path: candidate.path, source: candidate.kind };
      }
      continue;
    }
    if (await verifyVersion(candidate.path).then(() => true, () => false)) {
      return { path: candidate.path, source: candidate.kind };
    }
  }
  const asset = assetFor();
  if (!asset) {
    throw new Error(`${process.platform}/${process.arch} 上没有可自动安装的 tunnel-client，请自行安装并设置 ${BIN_OVERRIDE_ENV}`);
  }
  if (!managedRoot) {
    throw new Error('没有可用的 tunnel-client');
  }
  log(`downloading tunnel-client ${TUNNEL_CLIENT_VERSION} (${asset.target})`);
  return { path: await installManaged(join(managedRoot, TUNNEL_CLIENT_VERSION, asset.target), asset), source: 'downloaded' };
}

/** Download, verify both SHA256s, then rename into place (a half-installed file never sits at the final path). */
async function installManaged(dir, asset) {
  const destination = join(dir, asset.member);
  const temporary = join(dir, `.install-${randomUUID()}`);
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    const response = await fetch(`${RELEASE_BASE}/${asset.fileName}`, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new Error(`下载 tunnel-client 失败: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
      throw new Error('下载的 tunnel-client 过大');
    }
    if (sha256(bytes) !== asset.archiveSha256) {
      throw new Error('下载的 tunnel-client 压缩包校验失败：SHA256 不匹配');
    }
    const archive = join(temporary, asset.fileName);
    await writeFile(archive, bytes, { mode: 0o600 });
    await extractMember(archive, asset.member, temporary);
    const candidate = join(temporary, asset.member);
    if ((await sha256File(candidate)) !== asset.binarySha256) {
      throw new Error('解出的 tunnel-client 校验失败：SHA256 不匹配');
    }
    await chmod(candidate, 0o755);
    await verifyVersion(candidate);
    await rename(candidate, destination);
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** System unzip (macOS/Linux) or bsdtar (Windows 10+) — no npm dependency for one archive. */
async function extractMember(archive, member, destination) {
  const [command, args] =
    process.platform === 'win32' ? ['tar', ['-xf', archive, '-C', destination, member]] : ['unzip', ['-o', '-j', archive, member, '-d', destination]];
  const result = await runCapture(command, args, { timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(`解压 tunnel-client 失败: ${lastLine(result.output)}`);
  }
}

export async function verifyVersion(path) {
  const result = await runCapture(path, ['--version'], { timeoutMs: 10_000 });
  if (result.code !== 0 || !result.output.trim().startsWith(TUNNEL_CLIENT_VERSION)) {
    throw new Error(`tunnel-client 版本不符（需要 ${TUNNEL_CLIENT_VERSION}）: ${lastLine(result.output) || `exit ${result.code}`}`);
  }
}

/**
 * Env for every tunnel-client invocation: the restricted key only. The daemon must
 * not inherit broader OpenAI credentials from the parent environment.
 */
export function tunnelEnv(baseEnv, { tunnelId, apiKey }) {
  const env = { ...baseEnv, CONTROL_PLANE_TUNNEL_ID: tunnelId, CONTROL_PLANE_API_KEY: apiKey };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_ADMIN_KEY;
  return env;
}

/** `run` arguments. Secrets never appear here (argv is visible in ps): the key is env, the Bearer is a file reference. */
export function buildRunArgs({ mcpUrl, authorizationFile, healthUrlFile, logFile, pidFile }) {
  return [
    'run',
    '--mcp.server-url', `url=${mcpUrl},channel=main`,
    '--mcp.extra-headers', `Authorization: file:${authorizationFile}`,
    '--health.listen-addr', '127.0.0.1:0',
    '--health.url-file', healthUrlFile,
    '--log.file', logFile,
    '--log.format', 'json',
    '--log.level', 'info',
    ...(pidFile ? ['--pid.file', pidFile] : []),
  ];
}

export function buildProbeArgs(tunnelId) {
  return ['admin', 'tunnels', 'get', tunnelId];
}

/** Map control-plane probe output to an actionable message (network vs. credentials vs. tunnel). */
export function controlPlaneErrorMessage(detail) {
  const text = String(detail).toLowerCase();
  if (['eof', 'connection reset', 'connection refused', 'timed out', 'timeout', 'no such host'].some((marker) => text.includes(marker))) {
    return '连接 OpenAI 控制面失败，请检查网络或代理 / Cannot reach the OpenAI control plane';
  }
  if (text.includes('401') || text.includes('invalid_api_key')) {
    return 'OpenAI 拒绝了这把 API Key，请确认它有效且属于该 Tunnel 的 workspace / OpenAI rejected the API key';
  }
  return '控制面未能确认这条 Tunnel：请确认 Tunnel ID 属于同一 workspace，且 Key 有 Tunnels Read + Use 权限 / The control plane could not confirm this tunnel';
}

/** The health URL file decides what we GET next, so only a bare loopback origin is accepted. */
export function parseLoopbackHealthUrl(text) {
  const value = String(text).trim().replace(/\/+$/, '');
  const match = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(value);
  return match ? value : null;
}

export function runCapture(command, args, { env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolvePromise({ code: -1, output: error.message });
      return;
    }
    let output = '';
    const collect = (chunk) => {
      if (output.length < 64 * 1024) {
        output += chunk.toString();
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      output += '\ntimed out';
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, output: `${output}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, output });
    });
  });
}

export function lastLine(text) {
  const line = String(text).split(/\r?\n/).map((item) => item.trim()).filter(Boolean).pop() ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
