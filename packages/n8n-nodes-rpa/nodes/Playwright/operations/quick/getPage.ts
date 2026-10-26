import type { IDataObject } from 'n8n-workflow';
import type { Step } from 'n8n-rpa-engine';
import { quickEnvelope } from '../../output.js';
import { choice, type QuickCompiler, type QuickOutput } from './shared.js';

const CONTENT = ['text', 'html', 'titleUrl'] as const;
export const PAGE_CONTENT_INVALID = 'Return must be Text, HTML or Title and URL Only';

/** Get Page: Return Text (default) / HTML / Title and URL Only. Title and URL come from the envelope. */
export const compileGetPage: QuickCompiler = (params) => {
  const what = choice(params.pageContent, CONTENT, 'text', PAGE_CONTENT_INVALID);
  const steps: Step[] =
    what === 'text' ? [{ intent: 'Read the page text', read: { what: 'text' } }]
    : what === 'html' ? [{ intent: 'Read the page HTML', read: { what: 'html' } }]
    : [];
  return { script: { steps }, vars: {} };
};

/** The envelope plus `text` or `html` (masked and capped at 5 MiB by the engine), and `truncated: true` when capped. */
export const getPageOutput: QuickOutput = async (_ctx, run) => {
  const what = choice(run.params.pageContent, CONTENT, 'text', PAGE_CONTENT_INVALID);
  const fields: IDataObject = {};
  if (what !== 'titleUrl') {
    const out = run.result.outputs.find((o) => o.verb === 'read');
    const value = what === 'text' ? out?.text : out?.html;
    if (value === undefined) throw new Error(`the run finished without the page ${what === 'text' ? 'text' : 'HTML'}`);
    fields[what] = value;
    if (out?.truncated) fields.truncated = true;
  }
  return [{ json: quickEnvelope(run.result, run.compiled, fields) }];
};
