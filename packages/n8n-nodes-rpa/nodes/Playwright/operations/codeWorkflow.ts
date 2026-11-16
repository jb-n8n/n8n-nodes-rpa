// Options → One-Time Code Workflow: how Run Steps and Import Steps read it, and the engine's code provider that runs it.
import type { CodeProvider } from 'n8n-rpa-engine';
import type { NodeContext } from '../context.js';
import { ConfigError } from '../config.js';
import { asNumber, asString, clamp, errorMessage, isObject } from './common.js';

/**
 * Options → One-Time Code Workflow as saved: the workflow picker's value ({ __rl: true, mode, value }), or the plain ID a
 * workflow saved before the picker holds. undefined for anything else.
 */
function workflowIdOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (isObject(raw) && raw.__rl === true && (raw.value === undefined || raw.value === null || typeof raw.value === 'string')) return asString(raw.value);
  return undefined;
}

/** A workflow ID as n8n gives one: letters, digits, "-" and "_", at most 64 characters. */
const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** An expression that did not give a workflow ID. Names no value: the value comes from item data. */
export const CODE_WORKFLOW_NOT_AN_ID = 'One-Time Code Workflow is not a workflow ID: it must give letters, digits, - and _ only, or nothing.';

/**
 * Options → One-Time Code Workflow and Code Timeout (Seconds), read the same way by Run Steps and Import Steps, for the
 * item. The workflow may be an expression, so one workflow can pick the code workflow per item (per account): what it
 * picks can only return a one-time code, which the sign-in types into the declared code field of a listed login page
 * like any other code, and n8n runs it only when that workflow's own settings let this one call it. Nothing signed or
 * checked by the trust gate depends on it. What the expression gives must be a workflow ID, or empty (no workflow).
 */
export function codeWorkflowOptions(_ctx: NodeContext, opt: (name: string) => unknown): { codeWorkflowId: string; codeTimeoutMs: number } {
  const id = workflowIdOf(opt('codeWorkflowId'))?.trim();
  if (id === undefined || (id !== '' && !WORKFLOW_ID.test(id))) throw new ConfigError(CODE_WORKFLOW_NOT_AN_ID);
  return {
    codeWorkflowId: id,
    codeTimeoutMs: clamp(Math.floor(asNumber(opt('codeTimeout'), 120)), 1, 300) * 1000,
  };
}

/** A one-time code as the engine takes it once its spaces are removed: 6 to 10 digits (the engine's WORKFLOW_CODE). */
export const ONE_TIME_CODE = /^[0-9]{6,10}$/;
const NOT_ONE_ITEM = (n: number) => `it returned ${n} items; it must return exactly one item with a code field`;
const NO_CODE_FIELD = 'its item has no code field of 6 to 10 digits';
/** n8n's refusal to run a workflow that is not published (n8n 2.x still says "Workflow is not active"). */
const NOT_PUBLISHED = /workflow is not active/i;
const notPublished = (n8nWords: string) =>
  `it is not published: open the workflow set in Options → One-Time Code Workflow and click Publish (${n8nWords.slice(0, 90)})`;

/**
 * The engine's codeProvider for Options → One-Time Code Workflow: runs that workflow with one item { requestedAt } and
 * takes json.code from its single output item. Everything else it returns is dropped. Its errors never carry the code:
 * a returned value is never repeated, and a failing workflow's message keeps only its first line, with numbers of four or
 * more digits removed, spaces between the digits included ("123 456"); a workflow n8n refuses as "not active" is named as
 * not published, with n8n's words in brackets. The engine shows these errors after "the one-time code workflow failed: ".
 */
export function codeProviderFor(ctx: Pick<NodeContext, 'executeWorkflow'>, workflowId: string): CodeProvider {
  return async ({ requestedAt }) => {
    let result: Awaited<ReturnType<NodeContext['executeWorkflow']>> | undefined;
    let failed: unknown;
    try {
      result = await ctx.executeWorkflow({ id: workflowId }, [{ json: { requestedAt } }]);
    } catch (error) {
      failed = error;
    }
    // Thrown outside the catch block (as parseJson does): the message is rebuilt, never the workflow's error as is.
    if (!result) {
      const first = errorMessage(failed).split('\n')[0].replace(/\d[\d ]{2,}\d/g, '[number]');
      throw new Error(NOT_PUBLISHED.test(first) ? notPublished(first) : `it stopped with an error: ${first.slice(0, 200)}`);
    }
    const items = (result.data?.[0] ?? []).filter((item) => item !== null && item !== undefined);
    if (items.length !== 1) throw new Error(NOT_ONE_ITEM(items.length));
    const code: unknown = items[0].json?.code;
    const text = typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 ? String(code) : code;
    if (typeof text !== 'string' || !ONE_TIME_CODE.test(text.replace(/ /g, ''))) throw new Error(NO_CODE_FIELD);
    return text;
  };
}

/** The engine's code settings for a run: the code provider and its timeout when a One-Time Code Workflow is set, else none. */
export function codeSettingsFor(
  ctx: Pick<NodeContext, 'executeWorkflow'>, o: { codeWorkflowId: string; codeTimeoutMs: number },
): { codeProvider?: CodeProvider; codeTimeoutMs?: number } {
  return o.codeWorkflowId ? { codeProvider: codeProviderFor(ctx, o.codeWorkflowId), codeTimeoutMs: o.codeTimeoutMs } : {};
}
