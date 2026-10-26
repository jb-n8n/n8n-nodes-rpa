import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import type { Locator, OutputSpec, Step, TaskResult, WaitUntil } from 'n8n-rpa-engine';
import { ConfigError } from '../../config.js';
import type { NodeContext } from '../../context.js';
import { isObject } from '../common.js';

/** The quick operations, in menu order. */
export type QuickOp = 'screenshot' | 'getPage' | 'pdf' | 'extract' | 'fillForm' | 'download';

/** The only success a quick operation can have: it never passes `repair`, so the agent lane never runs. */
export type LaneSuccess = Extract<TaskResult, { ok: true; lane: 'script' }>;

/** One locator as the locator UI (description/locator.ts) saves it. */
export interface LocatorParam {
  findBy: 'text' | 'label' | 'role' | 'testId' | 'css';
  text?: string; label?: string; role?: string; roleName?: string; testId?: string; css?: string; exact?: boolean;
}

/** URL, Wait Until, Wait for Element, the raw Options collection, and every field the operation's description shows. */
export interface QuickParams { url: string; waitUntil: WaitUntil; waitFor?: LocatorParam; options: IDataObject; [field: string]: unknown }

/** A compiled quick operation. `writeStep` is a top-level step index (the Fill and Submit click). */
export interface Compiled { script: { steps: Step[] }; output?: OutputSpec; vars: Record<string, string>; writeStep?: number }

/** Compiles an operation's own steps (not the open/wait steps; compileQuickOp adds those and shifts writeStep). */
export type QuickCompiler = (params: QuickParams) => Compiled;

export interface QuickRun { op: QuickOp; params: QuickParams; compiled: Compiled; result: LaneSuccess }
/** Builds the Data items of one successful run. executeQuickOp sets pairedItem and attaches the trace. */
export type QuickOutput = (ctx: NodeContext, run: QuickRun) => Promise<INodeExecutionData[]>;

const LOCATOR_TEXT_KEYS = ['text', 'label', 'role', 'roleName', 'testId', 'css'] as const;

/** The locator UI's `{ locator: { findBy, … } }` (or the inner object) as a LocatorParam; undefined when nothing was set. */
export function locatorValue(raw: unknown): LocatorParam | undefined {
  if (!isObject(raw)) return undefined;
  const inner = isObject(raw.locator) ? raw.locator : raw;
  if (Object.keys(inner).length === 0) return undefined;
  const p: LocatorParam = { findBy: (typeof inner.findBy === 'string' ? inner.findBy : 'text') as LocatorParam['findBy'] };
  for (const key of LOCATOR_TEXT_KEYS) {
    const v = inner[key];
    if (typeof v === 'string') p[key] = v;
  }
  if (inner.exact === true) p.exact = true;
  return p;
}

/** The engine locator for a locator field. Exact Match applies to Visible Text, Form Label and a role's Name only. */
export function toLocator(p: LocatorParam | undefined, label: string): Locator {
  if (!p) throw new ConfigError(`${label} needs a value`);
  const need = (v: string | undefined): string => {
    const s = (v ?? '').trim();
    if (!s) throw new ConfigError(`${label} needs a value`);
    return s;
  };
  const exact: { exact?: boolean } = p.exact === true ? { exact: true } : {};
  switch (p.findBy) {
    case 'text':
      return { text: need(p.text), ...exact };
    case 'label':
      return { label: need(p.label), ...exact };
    case 'role': {
      const role = need(p.role);
      const name = (p.roleName ?? '').trim();
      return name ? { role, name, ...exact } : { role };
    }
    case 'testId':
      return { testId: need(p.testId) };
    case 'css':
      return { css: need(p.css) };
    default:
      throw new ConfigError(`${label}: Find By must be Visible Text, Form Label, Role and Name, Test ID or CSS Selector`);
  }
}

/** A non-empty string option, trimmed, or the fallback. */
export function textOption(options: IDataObject, name: string, fallback: string): string {
  const v = options[name];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

export const OUTPUT_FIELD_TRACE = 'Put Output in Field must not be "trace": the debug trace uses that field.';
/** Keys that reach Object.prototype through a record: never a field or binary property name a user may choose. */
export const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
export const outputFieldReserved = (name: string): string => `Put Output in Field must not be "${name}": that name is reserved.`;

/**
 * An Options → Put Output in Field value (binary property name), trimmed, or the fallback. "trace" is refused: the
 * debug trace is attached under that name and would overwrite the capture; so are the prototype keys (PROTOTYPE_KEYS),
 * which would reach Object.prototype through the binary record. Compilers call it too, so the check runs
 * before any browser opens.
 */
export function outputProperty(options: IDataObject, name: string, fallback: string): string {
  const property = textOption(options, name, fallback);
  if (property === 'trace') throw new ConfigError(OUTPUT_FIELD_TRACE);
  if (PROTOTYPE_KEYS.has(property)) throw new ConfigError(outputFieldReserved(property));
  return property;
}

/** One value of an options parameter: unset (null, undefined, '') → fallback; a value outside `allowed` → ConfigError(error). */
export function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T, error: string): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(error);
}
