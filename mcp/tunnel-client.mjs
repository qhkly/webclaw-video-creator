// OpenAI's official `tunnel-client` binary: locating, verifying and invoking it.
//
// Video Creator pins its own baseline: the latest public release at the time of
// writing (OpenAI's Secure MCP Tunnel docs recommend the latest public release;
// v0.0.14+ is the validated target for MCP 2026-07-28 sessionless requests, which
// http.mjs serves). Hashes come from the release itself, never from a local download:
//   archiveSha256 — the release's SHA256SUMS.txt
//   binarySha256  — the `tunnel-client` file entry in the release's <target>.spdx.json
// Upgrading = bump TUNNEL_CLIENT_VERSION and replace the table from those two files.
//
// Candidate order (every candidate must be exactly TUNNEL_CLIENT_VERSION):
//   1. VIDEO_CREATOR_TUNNEL_CLIENT_BIN (explicit override; version-checked, errors are reported)
//   2. our own managed cache            (SHA-pinned + version-checked)
//   3. WebCode AI Studio's managed cache (read-only reuse, only its <our version>/<target> copy,
//                                         SHA-pinned + version-checked; other versions are skipped)
//   4. tunnel-client on PATH             (exact version check)
//   5. download into our managed cache   (archive + binary SHA verified before install)
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const TUNNEL_CLIENT_VERSION = '0.0.15';
export const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_CLIENT_VERSION}`;
export const BIN_OVERRIDE_ENV = 'VIDEO_CREATOR_TUNNEL_CLIENT_BIN';
const AI_STUDIO_IDENTIFIER = 'com.jiayiqiu.webcode-ai-studio';
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

// v0.0.15 (2026-09-25). Source: github.com/openai/tunnel-client/releases/tag/v0.0.15
const ASSETS = {
  'linux-x64': { target: 'linux-amd64', archiveSha256: '8c836dc5d68d68b663d9a5c5b28ff9fa780d9f7a3fffb1c306880b8f32fab5f1', binarySha256: '286769f6b1b1837e89896b4684a3ec59c919f860fa2bc159442e3839b6468711' },
  'linux-arm64': { target: 'linux-arm64', archiveSha256: 'c51bfd883fc22e3445494a03c0179875176564bde470661b308fd83af5d01abb', binarySha256: '7764a78fc39ee04d1fc2ae74436df019d85de2a9d93de7c82030e14ef5ae93a0' },
  'darwin-x64': { target: 'darwin-amd64', archiveSha256: '9dcae1e2fb121287e73271edb7b853dda52aa86b7bfca1df91bc275371261bdb', binarySha256: 'c5e63f95c1142fc90d20275d811029d1854a04ae5d5ee79240d8bdc7a141c641' },
  'darwin-arm64': { target: 'darwin-arm64', archiveSha256: 'b2cae3aa9df45b4c2fe9b1d700ebacce39f9feb6a6b46b86e6499f9a51bf72ff', binarySha256: 'f534872593a60b12560b6c74cbbf94adf6f7e1d9fdd67a3f59b8268ff8a8249c' },
  'win32-x64': { target: 'windows-amd64', archiveSha256: '3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1', binarySha256: '1946de55a038313a9b9b2458d05fe1719fa9cf1f20a94dd5f38fc26a98bfdd42' },
  'win32-arm64': { target: 'windows-arm64', archiveSha256: '571e0d59ed9e86d1b105dc34f3267865f654de6968b01efd7c847f0af657d11d', binarySha256: '420a3a5536c0f598b9e6216f9b0c9324214f24eb8f3a61d7203d76163c266871' },
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

export async function resolveTunnelClient({
  managedRoot,
  env = process.env,
  log = () => {},
  platform = process.platform,
  arch = process.arch,
  home = homedir(),
  download = true,
} = {}) {
  for (const candidate of tunnelClientCandidates({ env, platform, arch, home, managedRoot })) {
    if (candidate.kind === 'override') {
      if (!(await isFile(candidate.path))) {
        throw new Error(`${BIN_OVERRIDE_ENV} 指向的不是一个文件: ${candidate.path}`);
      }
      await verifyVersion(candidate.path);
      return { path: candidate.path, source: candidate.kind };
    }
    const verdict = await checkCandidate(candidate);
    if (verdict.ok) {
      return { path: candidate.path, source: candidate.kind };
    }
    if (verdict.reason !== 'missing') {
      log(`skip tunnel-client ${candidate.kind} ${candidate.path}: ${verdict.reason}`);
    }
  }
  const asset = assetFor(platform, arch);
  if (!asset) {
    throw new Error(`${platform}/${arch} 上没有可自动安装的 tunnel-client，请自行安装并设置 ${BIN_OVERRIDE_ENV}`);
  }
  if (!managedRoot || !download) {
    throw new Error(`没有可用的 tunnel-client ${TUNNEL_CLIENT_VERSION}`);
  }
  log(`downloading tunnel-client ${TUNNEL_CLIENT_VERSION} (${asset.target})`);
  return { path: await installManaged(join(managedRoot, TUNNEL_CLIENT_VERSION, asset.target), asset), source: 'downloaded' };
}

/**
 * Whether a non-override candidate is usable: it must exist, match the pinned SHA256
 * when one applies, and report exactly TUNNEL_CLIENT_VERSION. Anything else is skipped.
 */
export async function checkCandidate(candidate) {
  if (!(await isFile(candidate.path))) {
    return { ok: false, reason: 'missing' };
  }
  if (candidate.sha256 && (await sha256File(candidate.path)) !== candidate.sha256) {
    return { ok: false, reason: 'sha256 mismatch' };
  }
  try {
    await verifyVersion(candidate.path);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  return { ok: true };
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
  if (result.code !== 0 || !versionMatches(result.output)) {
    throw new Error(`tunnel-client 版本不符（需要 ${TUNNEL_CLIENT_VERSION}）: ${lastLine(result.output) || `exit ${result.code}`}`);
  }
}

/** `--version` prints "0.0.15+<sha> (git sha: …)"; require exactly our version (0.0.150 or 0.0.12 do not match). */
export function versionMatches(output) {
  const reported = /^v?(\d+\.\d+\.\d+)(?=[+\s]|$)/.exec(String(output).trim());
  return reported?.[1] === TUNNEL_CLIENT_VERSION;
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
