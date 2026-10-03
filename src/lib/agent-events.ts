// Normalizes the headless event streams of different coding CLIs into one
// timeline shape for the Agent page. Adding a CLI = adding one parser here;
// the UI never sees CLI-specific JSON. Dependency-free so `node --test` can
// import it directly (Node strips the type annotations).

export type AgentCliId = 'claude_code' | 'codex';

export type AgentEvent =
  | { kind: 'session'; sessionId?: string; tools?: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; tool: string; args: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; ok: boolean; summary: string; data?: unknown }
  | { kind: 'done'; ok: boolean; summary?: string; costUsd?: number; denied?: string[] }
  | { kind: 'error'; message: string };

const MCP_PREFIX = 'mcp__video-creator__';

/** Strip the MCP namespace so the UI can label video tools ("video_render") uniformly. */
export function toolName(name: string) {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

export function parseAgentLine(cli: AgentCliId, line: string): AgentEvent[] {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(message)) {
    return [];
  }
  return cli === 'codex' ? parseCodex(message) : parseClaude(message);
}

function parseClaude(message: Record<string, unknown>): AgentEvent[] {
  switch (message.type) {
    case 'system':
      return message.subtype === 'init'
        ? [{ kind: 'session', sessionId: str(message.session_id), tools: Array.isArray(message.tools) ? message.tools.map(String).map(toolName) : undefined }]
        : [];
    case 'assistant':
    case 'user': {
      const content = isRecord(message.message) && Array.isArray(message.message.content) ? message.message.content : [];
      const events: AgentEvent[] = [];
      for (const block of content) {
        if (!isRecord(block)) {
          continue;
        }
        if (block.type === 'text' && str(block.text)?.trim()) {
          events.push({ kind: 'text', text: String(block.text) });
        } else if (block.type === 'tool_use') {
          events.push({ kind: 'tool_call', id: String(block.id ?? ''), tool: toolName(String(block.name ?? '')), args: isRecord(block.input) ? block.input : {} });
        } else if (block.type === 'tool_result') {
          const text = resultText(block.content);
          events.push({ kind: 'tool_result', id: String(block.tool_use_id ?? ''), ok: block.is_error !== true, summary: text, data: tryJson(text) });
        }
      }
      return events;
    }
    case 'result': {
      const denied = Array.isArray(message.permission_denials)
        ? message.permission_denials.map((item) => (isRecord(item) ? toolName(String(item.tool_name ?? '')) : String(item)))
        : [];
      return [
        {
          kind: 'done',
          ok: message.subtype === 'success' && message.is_error !== true,
          summary: str(message.result),
          costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined,
          denied: denied.length > 0 ? denied : undefined,
        },
      ];
    }
    default:
      return [];
  }
}

function parseCodex(message: Record<string, unknown>): AgentEvent[] {
  switch (message.type) {
    case 'thread.started':
      return [{ kind: 'session', sessionId: str(message.thread_id) }];
    case 'item.started':
    case 'item.completed': {
      const item = isRecord(message.item) ? message.item : {};
      const id = String(item.id ?? '');
      const completed = message.type === 'item.completed';
      if (item.type === 'agent_message') {
        return completed && str(item.text)?.trim() ? [{ kind: 'text', text: String(item.text) }] : [];
      }
      if (item.type === 'mcp_tool_call') {
        if (!completed) {
          return [{ kind: 'tool_call', id, tool: String(item.tool ?? ''), args: isRecord(item.arguments) ? item.arguments : {} }];
        }
        const text = item.error ? describeError(item.error) : resultText(isRecord(item.result) ? item.result.content : item.result);
        const isError = Boolean(item.error) || item.status === 'failed' || (isRecord(item.result) && item.result.isError === true);
        return [{ kind: 'tool_result', id, ok: !isError, summary: text, data: tryJson(text) }];
      }
      if (item.type === 'command_execution') {
        if (!completed) {
          return [{ kind: 'tool_call', id, tool: 'shell', args: { command: item.command } }];
        }
        return [{ kind: 'tool_result', id, ok: item.exit_code === 0 || item.status === 'completed', summary: String(item.aggregated_output ?? '').slice(0, 2000) }];
      }
      if (item.type === 'error' && completed) {
        return [{ kind: 'error', message: String(item.message ?? 'error') }];
      }
      return [];
    }
    case 'turn.completed':
      return [{ kind: 'done', ok: true }];
    case 'turn.failed':
      return [{ kind: 'done', ok: false, summary: describeError(message.error) }];
    case 'error':
      return [{ kind: 'error', message: String(message.message ?? 'error') }];
    default:
      return [];
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function describeError(error: unknown) {
  return isRecord(error) ? String(error.message ?? JSON.stringify(error)) : String(error ?? 'error');
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function str(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
