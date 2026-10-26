import type { BoundChatModel, ChatModel, ToolDef } from 'n8n-rpa-engine';

/** Duck type check: n8n's model sub-nodes supply LangChain chat models, which have bindTools. Nothing is imported from LangChain. */
export function isChatModel(value: unknown): value is ChatModel {
  return typeof value === 'object' && value !== null && typeof (value as { bindTools?: unknown }).bindTools === 'function';
}

/**
 * A ChatModel that asks n8n for the connected model only when the agent first calls it, so a run that passes
 * on the script lane never executes the model sub-node (n8n's log then shows zero model calls).
 */
export function lazyChatModel(resolve: () => Promise<unknown>): ChatModel & { readonly resolved: boolean } {
  let model: Promise<ChatModel> | undefined;
  let resolved = false;
  const get = (): Promise<ChatModel> =>
    (model ??= resolve().then((value) => {
      resolved = true;
      if (value === null || value === undefined) throw new Error('no chat model is connected to the Chat Model input');
      if (Array.isArray(value)) throw new Error(`expected one chat model, got ${value.length}`);
      if (!isChatModel(value)) throw new Error('the connected chat model does not support tool calling (it has no bindTools method)');
      return value;
    }));
  return {
    get resolved() {
      return resolved;
    },
    bindTools(tools: ToolDef[]): BoundChatModel {
      let bound: Promise<BoundChatModel> | undefined;
      return {
        invoke: async (messages, options) => (await (bound ??= get().then((m) => m.bindTools(tools)))).invoke(messages, options),
      };
    },
  };
}
