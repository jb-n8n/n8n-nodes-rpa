import type { IDataObject } from 'n8n-workflow';
import type { Step } from 'n8n-rpa-engine';
import { quickEnvelope } from '../../output.js';
import { ConfigError } from '../../config.js';
import { asString, field, isObject } from '../common.js';
import { locatorValue, toLocator, type QuickCompiler, type QuickOutput } from './shared.js';

/** A Value as text: numbers and booleans from an expression are stringified; an object or array is refused, never "[object Object]". */
function fieldValue(v: unknown, label: string): string {
  if (isObject(v) || Array.isArray(v)) throw new ConfigError(`${label} value must be text`);
  return asString(v);
}

/**
 * Fill and Submit Form → fill steps whose values are `{{var.fN}}` (never literals), the submit click at
 * `writeStep` (an index into these steps; compileQuickOp shifts it, executeQuickOp opens the write window there), then a
 * read of the page after the submit.
 */
export const compileFillForm: QuickCompiler = (params) => {
  const raw = field(params.formFields, 'field');
  const entries: unknown[] = Array.isArray(raw) ? raw : [];
  const vars: Record<string, string> = {};
  const steps: Step[] = entries.map((entry, k) => {
    const label = `Field ${k + 1}`;
    vars[`f${k}`] = fieldValue(field(entry, 'value'), label);
    return { intent: `Fill field ${k + 1}`, fill: { field: toLocator(locatorValue(entry), label), value: `{{var.f${k}}}` } };
  });
  const writeStep = steps.length;
  steps.push({ intent: 'Submit the form', click: toLocator(locatorValue(params.submitButton), 'Submit Button') });
  steps.push({ intent: 'Read the page after submit', read: { what: 'text' } });
  return { script: { steps }, vars, writeStep };
};

/**
 * The envelope plus the page text after the submit, `submitted` and `writes`. A missing read output gives
 * `text: ''` rather than an error: the form was already sent, and an error item would hide `submitted: true`.
 */
export const fillFormOutput: QuickOutput = async (_ctx, run) => {
  const read = [...run.result.outputs].reverse().find((o) => o.verb === 'read' && typeof o.text === 'string');
  const fields: IDataObject = {
    text: read?.text ?? '',
    ...(read?.truncated ? { truncated: true } : {}),
    submitted: run.result.submitted,
    writes: run.result.writes.map((w) => ({ method: w.method, host: w.host, path: w.path })),
  };
  return [{ json: quickEnvelope(run.result, run.compiled, fields) }];
};
