// Workspace association detection for the OpenAI Secure Tunnel.
//
// ChatGPT can only use a tunnel that is associated with the target ChatGPT
// workspace. A tunnel with just a Platform organization attached runs fine on
// this machine (tunnel-client healthy, MCP initialize over the tunnel works),
// yet ChatGPT refuses the custom MCP app with "server rejected the access" —
// exactly the failure this layer exists to name.
//
// The check is read-only: `tunnel-client admin --json tunnels get <id>` with
// the restricted runtime key. We only ever extract *counts*; organization and
// workspace ids are identifiers, not user-facing data, and never leave this
// module (see workspaceAccessFromMetadata).
//
// Modifying the association is a platform-console action that needs
// permissions a restricted key does not have — and must not have. The app
// detects and guides; it never tries to rewire the tunnel itself.

/** UI states for the workspace association layer. */
export const WORKSPACE_ACCESS = Object.freeze({
  /** workspace_ids is a non-empty array: ChatGPT workspaces can reach this tunnel. */
  ASSOCIATED: 'associated',
  /** Metadata parsed fine but no workspace is associated. Actionable failure. */
  MISSING: 'missing',
  /** Metadata could not be read/parsed. NOT the same as "no workspace". */
  UNKNOWN: 'unknown',
});

/**
 * Parse `admin --json tunnels get` output into counts.
 *
 * The command can print noise around the JSON object (warnings, log lines), so
 * scan for the outermost {...} block. Returns null when no JSON object parses
 * — callers must map that to UNKNOWN, never to "no workspaces".
 */
export function parseTunnelMetadata(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  let value;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  // An error payload (e.g. {"error": {...}}) is a failed read, not empty metadata.
  if (value.error && !value.id) {
    return null;
  }
  return {
    organizationCount: countIds(value.organization_ids),
    workspaceCount: countIds(value.workspace_ids),
  };
}

function countIds(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '').length : 0;
}

/**
 * Fold parsed metadata into the UI state. Counts only — this is the boundary
 * where workspace ids are dropped, so no caller can leak them to the UI or log.
 */
export function workspaceAccessFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return WORKSPACE_ACCESS.UNKNOWN;
  }
  return metadata.workspaceCount > 0 ? WORKSPACE_ACCESS.ASSOCIATED : WORKSPACE_ACCESS.MISSING;
}
