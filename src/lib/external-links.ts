// External pages the app may open. Pure (no Tauri imports) so node tests can load it.
//
// Exact-match allowlist: only these three pages, nothing else on openai.com. This is
// the first layer; the Rust open_external_url command keeps its own host allowlist.

// Both credentials can only be created on the OpenAI platform; the card links straight to the right pages.
export const OPENAI_TUNNEL_CONSOLE_URL = 'https://platform.openai.com/settings/organization/tunnels';
export const OPENAI_API_KEY_CONSOLE_URL = 'https://platform.openai.com/api-keys';
export const OPENAI_TUNNEL_DOCS_URL = 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels';

const ALLOWED_EXTERNAL_URLS: ReadonlySet<string> = new Set([OPENAI_TUNNEL_CONSOLE_URL, OPENAI_API_KEY_CONSOLE_URL, OPENAI_TUNNEL_DOCS_URL]);

export function isAllowedOpenAiExternalUrl(url: unknown): url is string {
  return typeof url === 'string' && ALLOWED_EXTERNAL_URLS.has(url);
}
