import type { ToolCall, ToolDef } from './tools.js';

/**
 * A picture the model sees with a message (desktop repair's masked, labelled screenshot). It goes to the model only:
 * transcripts, outputs and logs keep the message's text and never the picture.
 */
export interface ChatImage { mime: 'image/png' | 'image/jpeg'; base64: string; width: number; height: number }

/** Plain chat message, shaped like LangChain message-like objects. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** User messages only: pictures sent with the text (see ModelMessage for how they reach the model). */
  images?: ChatImage[];
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
/** A part of a message with a picture, in LangChain's (and OpenAI's) shape: n8n's chat models convert it per provider. */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
/**
 * A message as the model receives it: a ChatMessage whose pictures became content parts (a text part, then one
 * image_url part per picture, as a base64 data URL). Messages without pictures keep their string content.
 */
export type ModelMessage = Omit<ChatMessage, 'content' | 'images'> & { content: string | ContentPart[] };
export interface BoundChatModel {
  invoke(messages: ModelMessage[], options?: { signal?: AbortSignal }): Promise<ChatResponse>;
}

/** The message as the model receives it: pictures as content parts after the text. */
export function toModelMessage(m: ChatMessage): ModelMessage {
  const { images, ...rest } = m;
  if (!images?.length) return rest;
  return { ...rest, content: [{ type: 'text', text: m.content }, ...images.map((i): ContentPart => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } }))] };
}

/** The text of a message as the model receives it (the text parts of a message with pictures). */
export function modelMessageText(m: Pick<ModelMessage, 'content'>): string {
  return typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/**
 * About how many input tokens a picture costs: Anthropic's published estimate, width x height / 750 (other providers
 * count differently). Used only to say how much of a repair's reported tokens went to screenshots.
 */
export function imageTokenEstimate(i: Pick<ChatImage, 'width' | 'height'>): number {
  return Math.ceil((Math.max(0, i.width) * Math.max(0, i.height)) / 750);
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

/** The model with every invoke counted before it is sent: the count survives a throw anywhere in the agent lane. */
export function countingModel(model: ChatModel, calls: { n: number }): ChatModel {
  return {
    bindTools(defs) {
      const bound = model.bindTools(defs);
      return { invoke(messages, options) { calls.n++; return bound.invoke(messages, options); } };
    },
  };
}
