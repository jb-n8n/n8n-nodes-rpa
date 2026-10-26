// Deterministic drivers for the agent loop: each turn returns the next scripted tool call(s).
import type { ChatMessage, ChatModel, ChatResponse } from '../src/agent/model.js';
import type { ToolDef } from '../src/agent/tools.js';

/** The ref of the element with this exact name (or matching this pattern) in the latest snapshot inside `text`. */
export function refByName(text: string, name: string | RegExp): string {
  const page = text.slice(text.lastIndexOf('<page_content>'));
  const names: string[] = [];
  let found: string | undefined;
  for (const m of page.matchAll(/^\[(e\d+)\] \S+ ("(?:[^"\\]|\\.)*")/gm)) {
    const n = JSON.parse(m[2]) as string;
    names.push(n);
    if (typeof name === 'string' ? n === name : name.test(n)) found = m[1];
  }
  if (!found) throw new Error(`no element named ${String(name)} on the page; elements: ${names.join(' | ')}`);
  return found;
}

/** The text the model last observed: the latest tool result, or the first user message. */
export function lastObservation(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'tool' || messages[i].role === 'user') return messages[i].content;
  return '';
}

export type FakeCall = { name: string; args?: Record<string, unknown> };
export type FakeTurn = (lastText: string, messages: ChatMessage[]) => FakeCall | FakeCall[] | null;
export interface FakeModel extends ChatModel {
  readonly invocations: ChatMessage[][];
  readonly texts: string[];
  readonly tools: ToolDef[];
}

export function fakeModel(turns: FakeTurn[], opts: { tokensPerCall?: number } = {}): FakeModel {
  const invocations: ChatMessage[][] = [];
  const texts: string[] = [];
  let tools: ToolDef[] = [];
  let turn = 0;
  return {
    invocations,
    texts,
    get tools() { return tools; },
    bindTools(defs: ToolDef[]) {
      tools = defs;
      return {
        async invoke(messages: ChatMessage[]): Promise<ChatResponse> {
          invocations.push(structuredClone(messages));
          const last = lastObservation(messages);
          texts.push(last);
          const next = turns[turn++];
          const out = next ? next(last, messages) : null;
          const list = out === null ? [] : Array.isArray(out) ? out : [out];
          return {
            content: list.length ? '' : 'nothing more to do',
            tool_calls: list.map((c, i) => ({ id: `call_${turn}_${i}`, name: c.name, args: c.args ?? {} })),
            usage_metadata: { input_tokens: opts.tokensPerCall ?? 100, output_tokens: 10 },
          };
        },
      };
    },
  };
}

export const use = (name: string, args: Record<string, unknown> = {}): FakeTurn => () => ({ name, args });
export const clickNamed = (name: string | RegExp, tool = 'click'): FakeTurn => (t) => ({ name: tool, args: { ref: refByName(t, name) } });
export const done = (outcome = 'found', note = 'done'): FakeTurn => () => ({ name: 'done', args: { outcome, note } });
