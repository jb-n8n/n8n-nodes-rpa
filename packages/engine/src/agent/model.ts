import type { ToolCall, ToolDef } from './tools.js';

/** Plain chat message, shaped like LangChain message-like objects. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Tool results only: 'error' when the tool refused or failed. */
  status?: 'success' | 'error';
  /** Assistant turns only: the provider's own content, replayed unchanged on the next call. */
  raw?: unknown;
}
export interface ChatResponse {
  content: string | unknown;
  tool_calls?: ToolCall[];
  usage_metadata?: { input_tokens: number; output_tokens: number };
  raw?: unknown;
}
export interface BoundChatModel {
  invoke(messages: ChatMessage[], options?: { signal?: AbortSignal }): Promise<ChatResponse>;
}
/** Any chat model with LangChain's bindTools/invoke shape. The engine never imports an LLM SDK. */
export interface ChatModel {
  bindTools(tools: ToolDef[]): BoundChatModel;
}

/** Text of a response's content: a string, or the text parts of a content-block array. */
export function responseText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
    .join('');
}
