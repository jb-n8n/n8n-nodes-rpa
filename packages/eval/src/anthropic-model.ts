import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatModel, ChatResponse, ToolDef } from 'n8n-rpa-engine';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** The part of the Anthropic client the adapter uses (injectable for tests). */
export interface MessagesClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
  };
}
export interface AnthropicModelOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  client?: MessagesClient;
}

export function toAnthropicTools(defs: ToolDef[]): Anthropic.Tool[] {
  return defs.map((d) => ({ name: d.function.name, description: d.function.description, input_schema: d.function.parameters as Anthropic.Tool.InputSchema }));
}

/**
 * Converts the engine's plain messages to Messages API params. The history stays append-only: an assistant turn with
 * `raw` content (what the API returned) is replayed unchanged, which keeps reasoning blocks valid.
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: Anthropic.MessageParam[] } {
  const system: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  let results: Anthropic.ToolResultBlockParam[] = [];
  const flush = () => {
    if (results.length) out.push({ role: 'user', content: results });
    results = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      results.push({ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content, ...(m.status === 'error' ? { is_error: true } : {}) });
      continue;
    }
    flush();
    if (m.role === 'system') { system.push(m.content); continue; }
    if (m.role === 'user') { out.push({ role: 'user', content: m.content }); continue; }
    if (Array.isArray(m.raw) && m.raw.length) { out.push({ role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] }); continue; }
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const c of m.tool_calls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
    if (blocks.length) out.push({ role: 'assistant', content: blocks });
  }
  flush();
  return { system: system.join('\n\n'), messages: out };
}

export function fromAnthropicResponse(res: Anthropic.Message): ChatResponse {
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  // A refused or truncated reply must not run tools (a cut-off tool call may be incomplete).
  const dropTools = res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens';
  const toolCalls = res.content
    .filter((b): b is Anthropic.ToolUseBlock => !dropTools && b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }));
  const details = (res as unknown as { stop_details?: { category?: string | null } | null }).stop_details;
  const u = res.usage;
  // The engine replays `raw` and then nudges; an unanswered tool_use in it would make the API reject the next request.
  const raw = dropTools ? res.content.filter((b) => b.type !== 'tool_use') : res.content;
  return {
    content:
      res.stop_reason === 'refusal'
        ? `The model declined (${details?.category ?? 'no category'}).`
        : res.stop_reason === 'max_tokens'
          ? `${text}${text ? ' ' : ''}[The reply was cut off at the token limit.]`
          : text,
    tool_calls: toolCalls,
    usage_metadata: { input_tokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output_tokens: u.output_tokens },
    ...(raw.length ? { raw } : {}),
  };
}

/** Marks the first user message's last block as a cache breakpoint (later tool results are rewritten each turn). */
function withFirstTurnBreakpoint(params: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const i = params.findIndex((m) => m.role === 'user');
  if (i < 0) return params;
  const m = params[i];
  const blocks: Anthropic.ContentBlockParam[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [...m.content];
  if (blocks.length === 0) return params;
  const last = blocks[blocks.length - 1];
  blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam;
  const out = [...params];
  out[i] = { role: 'user', content: blocks };
  return out;
}

/** A ChatModel over the Anthropic Messages API (manual tool-use loop; the engine runs the loop). */
export function anthropicChatModel(opts: AnthropicModelOptions = {}): ChatModel {
  const client: MessagesClient = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    bindTools(defs: ToolDef[]) {
      const tools = toAnthropicTools(defs);
      return {
        async invoke(messages: ChatMessage[], options?: { signal?: AbortSignal }): Promise<ChatResponse> {
          const { system, messages: params } = toAnthropicMessages(messages);
          const res = await client.messages.create(
            {
              model,
              max_tokens: opts.maxTokens ?? 16000,
              ...(system ? { system } : {}),
              tools,
              tool_choice: { type: 'auto', disable_parallel_tool_use: true },
              thinking: { type: 'adaptive' },
              output_config: { effort: opts.effort ?? 'medium' },
              cache_control: { type: 'ephemeral' },
              messages: withFirstTurnBreakpoint(params),
            },
            options?.signal ? { signal: options.signal } : undefined,
          );
          return fromAnthropicResponse(res);
        },
      };
    },
  };
}
