import type { FieldAttribute, FieldSpec, Step } from 'n8n-rpa-engine';
import { ConfigError } from '../../config.js';
import { extractItems, type ExtractOutputMode } from '../../output.js';
import { asNumber, asString, field, rowCheckPatterns, rowChecks, splitList } from '../common.js';
import { choice, locatorValue, PROTOTYPE_KEYS, toLocator, type QuickCompiler, type QuickOutput, type QuickParams } from './shared.js';

export type { ExtractOutputMode } from '../../output.js';

export const SHAPE_INVALID = 'Shape must be Table or List of Items';
export const OUTPUT_MODE_INVALID = 'Output must be One Item per Row or All Rows in One Item';
export const MAX_PAGES_RANGE = 'Max Pages must be a whole number from 1 to 100';
export const ATTRIBUTE_INVALID = 'Attribute must be one of text, href, src, title, alt or aria-label';
export const fieldNeedsName = (n: number): string => `Field ${n} needs a name`;
export const fieldNameReserved = (name: string): string => `Field name "${name}" is reserved`;
export const fieldNameTwice = (name: string): string => `Field name "${name}" is used twice`;
export const requiredNotAField = (name: string): string => `Required Fields lists "${name}", which is not one of the Fields`;

const SHAPES = ['table', 'list'] as const;
const OUTPUT_MODES = ['rowPerItem', 'allInOne'] as const;
const ATTRIBUTES = ['text', 'href', 'src', 'title', 'alt', 'aria-label'] as const;
/** With no Fields, each row is the item's own visible text. */
const ITEM_TEXT: FieldSpec = { pattern: '[\\s\\S]+' };
/**
 * Field names that are configuration errors: `_meta` holds the page facts; `id`
 * always, because the engine de-duplicates on any row.id, with or without an ID Pattern; `__proto__`, `constructor` and
 * `prototype` would reach Object.prototype through the fields record.
 */
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(['_meta', 'id', ...PROTOTYPE_KEYS]);

function maxPages(raw: unknown): number {
  const n = raw === undefined || raw === null || raw === '' ? 10 : asNumber(raw, Number.NaN);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new ConfigError(MAX_PAGES_RANGE);
  return n;
}

/** The Fields collection → engine field specs (resolved inside each item). */
function readFields(raw: unknown): Record<string, FieldSpec> {
  const entries = field(raw, 'field');
  if (!Array.isArray(entries) || entries.length === 0) return { text: ITEM_TEXT };
  const fields: Record<string, FieldSpec> = {};
  entries.forEach((entry: unknown, k: number) => {
    const name = asString(field(entry, 'name')).trim();
    if (!name) throw new ConfigError(fieldNeedsName(k + 1));
    if (RESERVED_FIELD_NAMES.has(name)) throw new ConfigError(fieldNameReserved(name));
    if (Object.hasOwn(fields, name)) throw new ConfigError(fieldNameTwice(name));
    const attribute = choice(field(entry, 'attribute'), ATTRIBUTES, 'text', ATTRIBUTE_INVALID);
    const label = `Field "${name}"`;
    fields[name] = { locator: toLocator(locatorValue(entry), label), ...(attribute === 'text' ? {} : { attribute: attribute as FieldAttribute }) };
  });
  return fields;
}

/** Options → Output: One Item per Row (default) or All Rows in One Item. */
function extractOutputMode(params: QuickParams): ExtractOutputMode {
  return choice(params.options.outputMode, OUTPUT_MODES, 'rowPerItem', OUTPUT_MODE_INVALID);
}

/** Extract Data → one extractTable or extract step, wrapped in paginate when Next Page is set. */
export const compileExtract: QuickCompiler = (params) => {
  const shape = choice(params.shape, SHAPES, 'table', SHAPE_INVALID);
  extractOutputMode(params); // an invalid Output is a configuration error before the browser opens
  const patterns = rowCheckPatterns((name) => params.options[name]);
  const { idPattern } = patterns;

  let read: Step;
  let requiredFields: string[] = [];
  if (shape === 'table') {
    read = { intent: 'Read the table', extractTable: { table: toLocator(locatorValue(params.table), 'Table'), ...(idPattern ? { idPattern } : {}) } };
  } else {
    const fields = readFields(params.fields);
    requiredFields = splitList(asString(params.options.requiredFields));
    for (const name of requiredFields) if (!Object.hasOwn(fields, name)) throw new ConfigError(requiredNotAField(name));
    read = {
      intent: 'Read the list',
      extract: { scope: { css: 'body' }, item: toLocator(locatorValue(params.item), 'Item'), fields, ...(idPattern ? { idPattern } : {}) },
    };
  }

  const next = locatorValue(params.options.nextPage);
  const steps: Step[] = next
    ? [{ intent: 'Read every page', paginate: { next: toLocator(next, 'Next Page'), until: 'absent', max: maxPages(params.options.maxPages), each: [read] } }]
    : [read];
  const output = rowChecks(patterns, requiredFields);
  return { script: { steps }, ...(output ? { output } : {}), vars: {} };
};

/** One item per row (default) or one item with every row. executeQuickOp pairs them and puts a kept trace on the first. */
export const extractOutput: QuickOutput = async (_ctx, run) => extractItems(run.result, run.compiled, extractOutputMode(run.params));
