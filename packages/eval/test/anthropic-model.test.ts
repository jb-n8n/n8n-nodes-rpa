import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AGENT_TOOLS, type ChatMessage } from 'n8n-rpa-engine';
import { anthropicChatModel, DEFAULT_MODEL, fromAnthropicResponse, toAnthropicMessages, toAnthropicTools, type MessagesClient } from '../src/anthropic-model.js';

function fakeClient(responses: Anthropic.Message[]) {
  const calls: { body: Anthropic.MessageCreateParamsNonStreaming; options?: { signal?: AbortSignal } }[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (body, options) => {
        calls.push({ body, options });
        const next = responses.shift();
        if (!next) throw new Error('no scripted response');
        return next;
      },
    },
  };
  return { client, calls };
}
const message = (content: unknown[], over: Record<string, unknown> = {}): Anthropic.Message => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: DEFAULT_MODEL, content, stop_reason: 'tool_use', stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }, ...over,
}) as unknown as Anthropic.Message;

describe('anthropic adapter', () => {
  it('maps tool definitions to name, description and input_schema', () => {
    const click = toAnthropicTools(AGENT_TOOLS)[1];
    expect(click).toEqual({ name: 'click', description: AGENT_TOOLS[1].function.description, input_schema: AGENT_TOOLS[1].function.parameters });
  });
  it('keeps the history append-only: raw assistant content replayed, tool results grouped, errors flagged', () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'click', input: { ref: 'e1' } }];
    const messages: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'click', args: { ref: 'e1' } }], raw },
      { role: 'tool', tool_call_id: 't1', content: 'OK', status: 'success' },
      { role: 'tool', tool_call_id: 't2', content: 'ERROR: ignored', status: 'error' },
      { role: 'assistant', content: 'hi', tool_calls: [{ id: 't3', name: 'look', args: {} }] },
      { role: 'tool', tool_call_id: 't3', content: 'page' },
      { role: 'user', content: 'nudge' },
    ];
    expect(toAnthropicMessages(messages)).toEqual({
      system: 'S',
      messages: [
        { role: 'user', content: 'U' },
        { role: 'assistant', content: raw },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'OK' }, { type: 'tool_result', tool_use_id: 't2', content: 'ERROR: ignored', is_error: true }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't3', name: 'look', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'page' }] },
        { role: 'user', content: 'nudge' },
      ],
    });
  });
  it('maps responses: tool calls, text, usage with cache tokens, raw content, and refusals', () => {
    const content = [{ type: 'text', text: 'Opening it.' }, { type: 'tool_use', id: 'toolu_1', name: 'click', input: { ref: 'e4' } }];
    expect(fromAnthropicResponse(message(content))).toEqual({
      content: 'Opening it.', tool_calls: [{ id: 'toolu_1', name: 'click', args: { ref: 'e4' } }],
      usage_metadata: { input_tokens: 135, output_tokens: 20 }, raw: content,
    });
    const refused = fromAnthropicResponse(message([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } }));
    expect(refused).toMatchObject({ content: 'The model declined (cyber).', tool_calls: [] });
  });
  it('sends one request per invoke with the documented parameters and the abort signal', async () => {
    const { client, calls } = fakeClient([message([{ type: 'tool_use', id: 'toolu_1', name: 'look', input: {} }])]);
    const bound = anthropicChatModel({ client }).bindTools(AGENT_TOOLS);
    const ac = new AbortController();
    const res = await bound.invoke([{ role: 'system', content: 'rules' }, { role: 'user', content: 'go' }], { signal: ac.signal });
    expect(res.tool_calls).toEqual([{ id: 'toolu_1', name: 'look', args: {} }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options?.signal).toBe(ac.signal);
    expect(calls[0].body).toMatchObject({
      model: 'claude-sonnet-5-5', max_tokens: 16000, system: 'rules',
      tool_choice: { type: 'auto', disable_parallel_tool_use: true }, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go', cache_control: { type: 'ephemeral' } }] }],
    });
    expect(calls[0].body.tools).toHaveLength(AGENT_TOOLS.length);
    const other = fakeClient([message([])]);
    await anthropicChatModel({ client: other.client, model: 'claude-opus-5-5', effort: 'high' }).bindTools([]).invoke([{ role: 'user', content: 'x' }]);
    expect(other.calls[0].body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'high' } });
  });
  it('puts an explicit cache breakpoint on the last block of the first user message only', async () => {
    const { client, calls } = fakeClient([message([])]);
    await anthropicChatModel({ client }).bindTools([]).invoke([
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', name: 'look', args: {} }] },
      { role: 'tool', content: 'result', tool_call_id: 't1' },
    ]);
    const msgs = calls[0].body.messages;
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'goal', cache_control: { type: 'ephemeral' } }]);
    expect(JSON.stringify(msgs.slice(1))).not.toContain('cache_control');
  });
  it('returns no tool calls for a refusal that carries a partial tool_use', () => {
    const res = fromAnthropicResponse(message([{ type: 'tool_use', id: 't', name: 'click', input: {} }], { stop_reason: 'refusal', stop_details: { category: 'cyber' } }));
    expect(res.tool_calls ?? []).toEqual([]);
    expect(res.content).toBe('The model declined (cyber).');
  });
  it('drops tool_use on max_tokens and says the reply was cut off', () => {
    const res = fromAnthropicResponse(message([{ type: 'text', text: 'Clicking' }, { type: 'tool_use', id: 't', name: 'click', input: { re: 'e' } }], { stop_reason: 'max_tokens' }));
    expect(res.tool_calls ?? []).toEqual([]);
    expect(res.content).toMatch(/^Clicking .*cut off at the token limit/);
  });
  it.each(['refusal', 'max_tokens'])('never replays a dropped tool_use after a %s stop', (stop) => {
    const res = fromAnthropicResponse(message([{ type: 'text', text: 'Clicking' }, { type: 'tool_use', id: 't', name: 'click', input: {} }], { stop_reason: stop, stop_details: { category: 'cyber' } }));
    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: res.content, tool_calls: res.tool_calls, raw: res.raw },
      { role: 'user', content: 'continue' },
    ];
    expect(JSON.stringify(toAnthropicMessages(history).messages)).not.toContain('tool_use');
  });
  it('rebuilds from content when a refusal has only a tool_use block', () => {
    const res = fromAnthropicResponse(message([{ type: 'tool_use', id: 't', name: 'click', input: {} }], { stop_reason: 'refusal' }));
    const out = toAnthropicMessages([{ role: 'assistant', content: res.content, tool_calls: res.tool_calls, raw: res.raw }, { role: 'user', content: 'continue' }]);
    expect(JSON.stringify(out.messages)).not.toContain('tool_use');
  });
});
