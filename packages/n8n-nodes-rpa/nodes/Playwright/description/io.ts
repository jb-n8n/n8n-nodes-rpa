import type { ExpressionString } from 'n8n-workflow';

/*
 * The node's dynamic connections. n8n evaluates INPUTS_EXPRESSION and OUTPUTS_EXPRESSION, in the editor and
 * at run time, with Function.prototype.toString() of the two functions below. So they are plain JavaScript once compiled:
 * no imports, no helpers, no closures over module state.
 *
 * AI Repair counts as on when its raw value is `true` or any string. A string is an expression (the data-feed template sets
 * one) and it is never resolved here. `$parameter` would resolve it, which fails while n8n computes connections (no
 * execution data) and makes n8n drop every connection; `$rawParameter` hands over the "={{ … }}" text instead.
 *
 * Import Steps: AI Repair defaults to on, so a missing value counts as on; only a literal `false` turns the
 * Model input off. It always has the Repaired Steps output: a clean import is proved without a model and still comes
 * out there for approval.
 */
export function nodeInputs(operation: unknown, aiRepair: unknown): Array<{ type: string; displayName: string; maxConnections?: number; required?: boolean }> {
  const main = { type: 'main', displayName: '' };
  const model = { type: 'ai_languageModel', displayName: 'Model', maxConnections: 1, required: false };
  if (operation === 'runSteps' && (aiRepair === true || typeof aiRepair === 'string')) return [main, model];
  if (operation === 'importSteps' && aiRepair !== false) return [main, model];
  return [main];
}

export function nodeOutputs(operation: unknown, aiRepair: unknown): Array<{ type: string; displayName: string }> {
  const data = { type: 'main', displayName: 'Data' };
  const repaired = { type: 'main', displayName: 'Repaired Steps' };
  if (operation === 'runSteps' && (aiRepair === true || typeof aiRepair === 'string')) return [data, repaired];
  if (operation === 'importSteps') return [data, repaired];
  return [data];
}

export const INPUTS_EXPRESSION: ExpressionString = `={{(${nodeInputs.toString()})($rawParameter.operation, $rawParameter.aiRepair)}}`;
export const OUTPUTS_EXPRESSION: ExpressionString = `={{(${nodeOutputs.toString()})($rawParameter.operation, $rawParameter.aiRepair)}}`;
