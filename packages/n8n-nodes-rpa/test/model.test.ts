import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatResponse, ToolDef } from 'n8n-rpa-engine';
import { isChatModel, lazyChatModel } from '../nodes/Playwright/model.js';

const TOOLS: ToolDef[] = [{ type: 'function', function: { name: 'look', description: 'Look at the page', parameters: { type: 'object', properties: {} } } }];
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

/** The shape of a LangChain chat model as n8n's model sub-nodes supply it. */
function langChainLike() {
  const seen: { tools?: ToolDef[]; messages?: ChatMessage[]; signal?: AbortSignal } = {};
  return {
    seen,
    bindTools(tools: ToolDef[]) {
      seen.tools = tools;
      return {
        async invoke(messages: ChatMessage[], options?: { signal?: AbortSignal }): Promise<ChatResponse> {
          seen.messages = messages;
          seen.signal = options?.signal;
          return { content: '', tool_calls: [{ id: 't1', name: 'look', args: {} }], usage_metadata: { input_tokens: 10, output_tokens: 2 } };
        },
      };
    },
  };
}

describe('isChatModel', () => {
  it('accepts anything with bindTools and nothing else', () => {
    expect(isChatModel(langChainLike())).toBe(true);
    expect(isChatModel({ invoke: () => undefined })).toBe(false);
    expect(isChatModel(undefined)).toBe(false);
  });
});

describe('lazyChatModel', () => {
  it('never asks n8n for the model until the agent calls it', () => {
    let asked = 0;
    const m = lazyChatModel(async () => { asked++; return langChainLike(); });
    m.bindTools(TOOLS);
    expect(asked).toBe(0);
    expect(m.resolved).toBe(false);
  });
  it('forwards tools, messages and the abort signal to the connected model, and resolves it once', async () => {
    let asked = 0;
    const inner = langChainLike();
    const m = lazyChatModel(async () => { asked++; return inner; });
    const signal = new AbortController().signal;
    const bound = m.bindTools(TOOLS);
    const res = await bound.invoke(MESSAGES, { signal });
    await bound.invoke(MESSAGES);
    expect(res.tool_calls).toEqual([{ id: 't1', name: 'look', args: {} }]);
    expect(inner.seen).toMatchObject({ tools: TOOLS, messages: MESSAGES });
    expect(asked).toBe(1);
    expect(m.resolved).toBe(true);
  });
  it('fails clearly when the connected model cannot call tools', async () => {
    const m = lazyChatModel(async () => ({ invoke: async () => ({ content: 'no tools here' }) }));
    await expect(m.bindTools(TOOLS).invoke(MESSAGES)).rejects.toThrow(/does not support tool calling/);
  });
  it('says so when no model is connected, or several are', async () => {
    await expect(lazyChatModel(async () => undefined).bindTools(TOOLS).invoke(MESSAGES)).rejects.toThrow(/no chat model is connected/);
    await expect(lazyChatModel(async () => [langChainLike(), langChainLike()]).bindTools(TOOLS).invoke(MESSAGES)).rejects.toThrow(/expected one chat model, got 2/);
  });
});
