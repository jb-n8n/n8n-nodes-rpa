// The import entry point: one source in, drafts and a report out. Every source goes the same way: its
// parser's events, then stripSecrets, then buildDraft. It never throws: anything that goes wrong is a report error.
import { chromeEvents, readChromeJson } from './chrome.js';
import { buildDraft } from './draft.js';
import { playwrightEvents, readPlaywrightCode } from './playwright.js';
import { stripSecrets } from './secrets.js';
import type { ImportOptions, ImportReport, ImportResult, ImportSource } from './types.js';
import { importUiPath } from './uipath.js';

const failed = (report: ImportReport, reason: string): ImportResult => {
  report.items.push({ at: '', kind: 'error', what: 'Import', reason });
  return { drafts: [], report };
};

/** Events through stripSecrets and buildDraft into one draft named opts.name, unless the parser already reported an error. */
function draftFrom(parse: (report: ImportReport) => ReturnType<typeof chromeEvents>, opts: ImportOptions, report: ImportReport): ImportResult {
  const events = parse(report);
  if (report.items.some((i) => i.kind === 'error')) return { drafts: [], report };
  const draft = buildDraft(stripSecrets(events, opts, report), opts, report, opts.name);
  return { drafts: draft ? [draft] : [], report };
}

/**
 * Imports a recording, code or project (`data`: the file's bytes or its text) as drafts for adoption, with a report of
 * what was not translated. Never throws, and returns a report even when there is no draft.
 */
export function importSource(source: ImportSource, data: Buffer | Uint8Array | string, opts: ImportOptions): ImportResult {
  const report: ImportReport = { source, steps: 0, items: [] };
  try {
    switch (source) {
      case 'chrome':
        return draftFrom((r) => {
          const json = readChromeJson(data, r);
          return json ? chromeEvents(json.value, r) : [];
        }, opts, report);
      case 'playwright':
        return draftFrom((r) => {
          const code = readPlaywrightCode(data, r);
          return code === undefined ? [] : playwrightEvents(code, r);
        }, opts, report);
      case 'uipath': // one draft per browser sequence, plus the flow around them
        return importUiPath(data, opts, report);
      default:
        return failed(report, 'the source must be chrome, playwright or uipath');
    }
  } catch {
    // The error's text may quote the input, so only the fact is reported.
    return failed({ source, steps: 0, items: [] }, 'the import failed on an unexpected input: nothing was imported');
  }
}
