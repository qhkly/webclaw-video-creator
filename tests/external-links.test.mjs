import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPENAI_API_KEY_CONSOLE_URL,
  OPENAI_TUNNEL_CONSOLE_URL,
  OPENAI_TUNNEL_DOCS_URL,
  isAllowedOpenAiExternalUrl,
} from '../src/lib/external-links.ts';

test('the three OpenAI credential/doc pages are allowed', () => {
  assert.equal(OPENAI_TUNNEL_CONSOLE_URL, 'https://platform.openai.com/settings/organization/tunnels');
  assert.equal(OPENAI_API_KEY_CONSOLE_URL, 'https://platform.openai.com/api-keys');
  assert.equal(OPENAI_TUNNEL_DOCS_URL, 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels');
  for (const url of [OPENAI_TUNNEL_CONSOLE_URL, OPENAI_API_KEY_CONSOLE_URL, OPENAI_TUNNEL_DOCS_URL]) {
    assert.equal(isAllowedOpenAiExternalUrl(url), true, url);
  }
});

test('everything else is refused, including other openai.com URLs', () => {
  for (const url of [
    'https://evil.example/',
    'https://platform.openai.com.evil.example/api-keys',
    'https://evil.example/?u=https://platform.openai.com/api-keys',
    'http://platform.openai.com/api-keys',
    'https://user@platform.openai.com/api-keys',
    'https://platform.openai.com/',
    'https://platform.openai.com/settings',
    'https://platform.openai.com/api-keys/',
    'https://platform.openai.com/api-keys?next=https://evil.example',
    'https://platform.openai.com/api-keys#x',
    'https://PLATFORM.openai.com/api-keys',
    'https://developers.openai.com/api/docs',
    'https://openai.com/',
    ` ${OPENAI_API_KEY_CONSOLE_URL}`,
    'javascript:alert(1)',
    'file:///etc/passwd',
    '',
  ]) {
    assert.equal(isAllowedOpenAiExternalUrl(url), false, url);
  }
  for (const value of [undefined, null, 42, {}, new URL(OPENAI_API_KEY_CONSOLE_URL)]) {
    assert.equal(isAllowedOpenAiExternalUrl(value), false, String(value));
  }
});
