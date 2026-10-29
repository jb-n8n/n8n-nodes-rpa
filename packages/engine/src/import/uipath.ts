// UiPath projects: a zipped project folder (project.json, its .xaml workflows and the Object
// Repository under .objects/) or a single .xaml. Activities are mapped by a fixed table, by local name with any namespace
// prefix ignored. Browser activities become neutral import events, grouped into sequences (one draft each); everything
// else becomes the flow around them, or a report item. Expressions are kept as text and never evaluated,
// and no typed value, SecureText or credential asset is ever imported beyond the asset's name as a slot.
import { IMPORT_EMPTY } from '../messages.js';
import { createMasker } from '../secrets/mask.js';
import { readZipEntries, type ZipCaps } from '../steps/zip.js';
import { buildDraft, cleanLabel, describeEvent, MIN_SECRET_LENGTH } from './draft.js';
import { stripSecrets, TOTP_OUTPUT_HINT } from './secrets.js';
import type { Candidate, DesktopDraft, Draft, FlowNode, ImportEvent, ImportItem, ImportOptions, ImportReport, ImportResult, UiPathFlow } from './types.js';
import { buildDesktopDraft, type DesktopEvent, type DesktopSequence } from './uipath-desktop.js';
import { readDesktopSelector, type DesktopSelectorRead } from './uipath-desktop-selector.js';
import { readSelector } from './uipath-selector.js';
import type { UiaTarget, WindowSel } from '../types.js';
import { parseXml, type XmlNode } from './xml.js';

/** An upload larger than this is refused before anything is read. */
export const MAX_UIPATH_BYTES = 20 * 1024 * 1024;
/** Zip caps for a project: entries, bytes per accepted entry, bytes of all accepted entries. */
export const UIPATH_ZIP_CAPS: ZipCaps = { maxEntries: 2_000, perEntry: 4 * 1024 * 1024, total: 32 * 1024 * 1024 };
/** InvokeWorkflowFile is followed this many levels deep. */
export const MAX_INVOKE_DEPTH = 10;
/** Activities walked in all, invoked workflows counted each time they are invoked: a project with more is refused. */
export const MAX_UIPATH_ACTIVITIES = 200_000;
/**
 * Work the walk may do, in element visits: each time a workflow is walked (the main one, and every invoke of another)
 * its element count plus one unit per 32 bytes of its text is charged, so invoking a large file many times is bounded.
 */
export const MAX_WALK = 2_000_000;
/** Elements parsed in the whole project (workflows and Object Repository elements together); each file is also capped at 200,000. */
export const MAX_PROJECT_ELEMENTS = 1_000_000;
const MAX_FILE_ELEMENTS = 200_000;
/** Element nesting across invoked workflows (each file is capped at 200 by the XML reader). */
const MAX_NESTING = 600;
/**
 * The report keeps at most this many items, then one summary item: a project of 190,000 untranslated activities would
 * otherwise put tens of MiB on the Data item. Errors, secrets and project-wide items (no location) are kept first.
 */
export const MAX_REPORT_ITEMS = 500;

const WHAT = 'UiPath project';
const DESKTOP_NOTE = "rebuild in SAP's web GUI";
const DESKTOP_HEADING_REASON = "the bot drives SAP GUI for Windows (or another desktop application), which the browser cannot: rebuild these in SAP's web GUI, in this order";
const DATA_NOTE = 'reading a value or rows needs an extract step with an ID Pattern and a field mapping, which this release does not infer: add an extract step';
/** Marks where one browser sequence ends and the next begins while stripSecrets runs over all of them at once. */
const BOUNDARY = 'urn:n8n-rpa:uipath-sequence-boundary';

type Json = Record<string, unknown>;
type Typed = Extract<ImportEvent, { kind: 'fill' | 'select' }>;

/** What the walk produces, in order: browser events, flow nodes, and the structure that holds more of both. */
type Item =
  | { t: 'event'; event: ImportEvent; card: string; cardId?: number; url?: string }
  /** A desktop activity (a UI Automation app, never SAP GUI): `scope` is the window scope's display name. */
  | { t: 'desktop'; event: DesktopEvent; scope: string }
  | { t: 'node'; node: FlowNode }
  | { t: 'if'; expression: string; displayName: string; then: Item[]; else: Item[] }
  | { t: 'forEach'; expression: string; displayName: string; body: Item[] };

interface Ctx {
  /** The workflow file's path in the project, for report locations. */
  file: string;
  /** Normalised paths of the workflows being walked, outermost first (cycle detection). */
  stack: string[];
  /** Display paths, matching stack. */
  chain: string[];
  /** Element nesting so far, across invoked workflows. */
  nesting: number;
  /** Inside a browser card: its id (one per card walked), display name and address, to reopen it when a sequence is split. */
  card?: { id: number; name: string; url?: string };
  /** The workflow's x:Name index, for Flowchart references. */
  names: Map<string, XmlNode>;
  /** The workflow's expressions are C# (project.json expressionLanguage, or the file's own editor attribute). */
  csharp: boolean;
  desktop: boolean;
  /** Inside an Open Application, Attach Window or Use Application scope on a UI Automation app (not SAP GUI). */
  app?: { window?: WindowSel; exe?: string; name: string };
  aws: boolean;
  excelPath?: string;
}

/** A target the Object Repository holds: its selector and element type. */
interface RepoTarget { selector?: string; elementType?: string }

interface Project {
  name?: string;
  /** Normalised path → { display path, text }. */
  files: Map<string, { path: string; text: string }>;
  main?: string;
  objects: Map<string, RepoTarget>;
  /** True for a single .xaml: invoked workflows are not available. */
  single: boolean;
  /** project.json says CSharp. */
  csharp: boolean;
  /** Elements the project may still parse (MAX_PROJECT_ELEMENTS). */
  budget: { left: number };
}

/** A parsed file: its root, element count, x:Name index. */
interface Parsed { root: XmlNode; elements: number; names: Map<string, XmlNode> }

/**
 * Parses within the project's element budget and counts what it parsed. `over` when the budget, not the file, was the
 * limit: the caller reports it against the project.
 */
function parseCounted(text: string, budget: { left: number }): Parsed | { error: string; over: boolean } {
  const cap = Math.min(MAX_FILE_ELEMENTS, budget.left);
  const doc = parseXml(text, { maxElements: cap });
  if ('error' in doc) return { error: doc.error, over: cap < MAX_FILE_ELEMENTS && doc.error.includes('elements') };
  let elements = 0;
  const names = new Map<string, XmlNode>();
  const stack: XmlNode[] = [doc];
  while (stack.length) {
    const el = stack.pop()!;
    elements++;
    const n = el.attrs['x:Name'];
    if (n !== undefined && !names.has(n)) names.set(n, el);
    for (const c of el.children) stack.push(c);
  }
  budget.left -= elements;
  return { root: doc, elements, names };
}
const OVER_BUDGET = (file: string) => `the project's workflows and Object Repository have more than ${MAX_PROJECT_ELEMENTS.toLocaleString('en-US')} elements in all: ${file} was not read`;

/** A value as the XAML holds it: a literal, an expression (kept as text), or nothing. */
type Val = { literal: string } | { expr: string } | undefined;

const local = (name: string): string => { const i = name.indexOf(':'); return i < 0 ? name : name.slice(i + 1); };
const isProperty = (el: XmlNode): boolean => local(el.name).includes('.');
const propertyName = (el: XmlNode): string => { const l = local(el.name); return l.slice(l.lastIndexOf('.') + 1); };
const prefixOf = (name: string): string => { const i = name.indexOf(':'); return i < 0 ? '' : name.slice(0, i); };

/** A project path, normalised: forward slashes, no `.` segments, `..` resolved, lower case (Windows paths ignore case). */
function normPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/').toLowerCase();
}

/** A VB (`"a ""b"""`) or C# (`"a \"b\""`, `@"a ""b"""`) string literal's value; undefined when the text is anything else. */
function stringLiteral(text: string, csharp: boolean): string | undefined {
  let s = text.trim();
  let verbatim = !csharp;
  if (csharp && s.startsWith('@"')) { s = s.slice(1); verbatim = true; }
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return undefined;
  let out = '';
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c === '"') {
      if (verbatim && s[i + 1] === '"' && i + 1 < s.length - 1) { out += '"'; i++; continue; }
      return undefined;
    }
    if (!verbatim && c === '\\') {
      const n = s[i + 1];
      if (i + 1 >= s.length - 1) return undefined;
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '0' ? '\0' : n;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** An attribute value: `[expr]` is a VB expression (a lone string literal is its value), `{x:Null}` is nothing, `{}{…}` escapes a brace. */
function attrValue(raw: string | undefined, csharp = false): Val {
  if (raw === undefined) return undefined;
  if (raw.startsWith('{}')) return { literal: raw.slice(2) };
  if (raw.startsWith('{')) return undefined;
  if (raw.length >= 2 && raw.startsWith('[') && raw.endsWith(']')) {
    const expr = raw.slice(1, -1);
    const lit = stringLiteral(expr, csharp);
    return lit !== undefined ? { literal: lit } : { expr: expr.trim() };
  }
  return { literal: raw };
}

/** The first non-property child, skipping ActivityAction-like wrappers' properties. */
const content = (el: XmlNode): XmlNode[] => el.children.filter((c) => !isProperty(c));

/** A property's value written as an element: `<X.Text><InArgument>[expr]</InArgument></X.Text>`, CSharpValue, VisualBasicValue or Literal. */
function elementValue(prop: XmlNode, csharp: boolean): Val {
  const inner = content(prop)[0];
  if (!inner) return attrValue(prop.text.trim() || undefined, csharp);
  const name = local(inner.name);
  if (name === 'CSharpValue' || name === 'CSharpReference') {
    const text = inner.text.trim();
    const lit = stringLiteral(text, true);
    return lit !== undefined ? { literal: lit } : { expr: text };
  }
  if (name === 'VisualBasicValue' || name === 'VisualBasicReference') {
    const text = (inner.attrs.ExpressionText ?? inner.text).trim();
    const lit = stringLiteral(text, false);
    return lit !== undefined ? { literal: lit } : { expr: text };
  }
  if (name === 'Literal') return inner.attrs.Value !== undefined ? { literal: inner.attrs.Value } : undefined;
  if (content(inner).length) return elementValue(inner, csharp);
  const text = inner.text.trim();
  return text ? attrValue(text, csharp) : undefined;
}

/** An activity argument: the attribute, else the `<Activity.Name>` property element. */
function argOf(el: XmlNode, key: string, csharp = false): Val {
  if (el.attrs[key] !== undefined) return attrValue(el.attrs[key], csharp);
  const prop = el.children.find((c) => isProperty(c) && propertyName(c) === key && local(c.name).split('.').length === 2);
  return prop ? elementValue(prop, csharp) : undefined;
}
const literalOf = (el: XmlNode, key: string, csharp = false): string | undefined => { const v = argOf(el, key, csharp); return v && 'literal' in v && v.literal !== '' ? v.literal : undefined; };
const textOf = (v: Val): string => (v === undefined ? '' : 'literal' in v ? v.literal : v.expr);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * A one-time code activity (a TOTP package's Generate TOTP, Get OTP, Generate One-Time Password), by the
 * words of its name. It is never a step: the sign-in types a fresh code from the Site Login's authenticator secret.
 */
const TOTP_ACTIVITY = /(^|[a-z])(Totp|TOTP|Otp|OTP|OneTimePassword)([A-Z]|$)/;
/** A TOTP activity's inputs (its secret), never its output. */
const TOTP_INPUT = /secret|key|seed/i;
const VERBS = ['type secure text', 'type into', 'select item', 'check/uncheck', 'double click', 'click', 'check', 'uncheck', 'get text', 'hover'];
const QUOTES: Record<string, string> = { "'": "'", '"': '"', '‘': '’', '“': '”' };

/** The label an intent shows for a UiPath DisplayName: the default verb and quotes removed (`Click 'Log On'` → `Log On`, classic `'BUTTON  Find'` → `Find`). */
function intentLabel(displayName: string): string {
  let s = displayName.slice(0, 400).trim();
  const lower = s.toLowerCase();
  const verb = VERBS.find((v) => lower.startsWith(v) && (s.length === v.length || s[v.length] === ' '));
  if (verb) s = s.slice(verb.length).trim();
  const close = QUOTES[s[0] ?? ''];
  if (close && s.length >= 2 && s.endsWith(close)) s = s.slice(1, -1);
  // Classic display names start with the element's tag and two spaces.
  let k = 0;
  while (k < s.length && k < 12 && ((s.charCodeAt(k) >= 65 && s.charCodeAt(k) <= 90) || (k > 0 && s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57))) k++;
  if (k > 0 && s.startsWith('  ', k)) s = s.slice(k).trim();
  return cleanLabel(s);
}

/** The display name of an activity, cleaned; its local name when it has none. */
const displayOf = (el: XmlNode): string => cleanLabel((el.attrs.DisplayName ?? '').slice(0, 1_000)) || local(el.name);

/** Duration `hh:mm:ss(.fff)` (or `d.hh:mm:ss`) in seconds; undefined for anything else. */
function seconds(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(?:(\d{1,4})\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/.exec(v.trim());
  if (!m) return undefined;
  const total = Number(m[1] ?? 0) * 86_400 + Number(m[2]) * 3_600 + Number(m[3]) * 60 + Number(m[4]) + (m[5] ? Number(`0.${m[5]}`) : 0);
  return Number.isFinite(total) ? total : undefined;
}

const isHttpUrl = (u: string): boolean => {
  if (!URL.canParse(u)) return false;
  const p = new URL(u).protocol;
  return p === 'http:' || p === 'https:';
};

class Aborted extends Error {}

/**
 * Reads a UiPath project zip or a single .xaml into browser sequences (neutral events, one draft each) and the flow
 * around them, adding what it cannot translate to `report`. Follows InvokeWorkflowFile up to MAX_INVOKE_DEPTH levels and
 * refuses cycles; every problem, a malformed workflow included, is a report item. Never throws.
 */
export function uipathImport(data: Buffer | Uint8Array | string, opts: ImportOptions, report: ImportReport): { sequences: UiPathSequence[]; flow: UiPathFlow } {
  const { sequences, flow } = walkUiPath(data, opts, report);
  return { sequences, flow };
}

/** uipathImport with the desktop sequences and the literal secrets desktop steps would have typed. Never throws. */
function walkUiPath(data: Buffer | Uint8Array | string, opts: ImportOptions, report: ImportReport): WalkResult {
  const empty = (): WalkResult => ({ sequences: [], desktop: [], typedSecrets: [], flow: { name: cleanLabel(opts.name), nodes: [] } });
  try {
    const project = loadProject(data, report);
    if (!project) return empty();
    return new Walker(project, opts, report).run();
  } catch (e) {
    if (!(e instanceof Aborted)) report.items.push({ at: '', kind: 'error', what: WHAT, reason: 'the project could not be read: nothing was imported' });
    return empty();
  }
}

/**
 * The import result for a UiPath project: one draft per browser sequence (through stripSecrets and buildDraft, named
 * `<name>-<n>`), the flow, and the report. Never throws.
 */
export function importUiPath(data: Buffer | Uint8Array | string, opts: ImportOptions, report: ImportReport): ImportResult {
  const { sequences, desktop, typedSecrets: desktopSecrets, flow } = walkUiPath(data, opts, report);
  const drafts: Draft[] = [];
  const typedSecrets: string[] = desktopSecrets.filter((v) => v.trim().length >= MIN_SECRET_LENGTH);
  const missing = new Set<number>();
  if (sequences.length) {
    // The explicit download's sequence gets the Expected File; failing that, the last with an export-like click,
    // then the last with any click. Only one draft downloads.
    const clicks = (s: { events: ImportEvent[] }) => s.events.filter((e): e is Extract<ImportEvent, { kind: 'click' }> => e.kind === 'click');
    const lastIndex = (pred: (s: { events: ImportEvent[] }) => boolean) => sequences.reduce((acc, s, i) => (pred(s) ? i : acc), -1);
    let dl = lastIndex((s) => clicks(s).some((c) => c.download));
    if (dl < 0) dl = lastIndex((s) => clicks(s).some((c) => EXPORT_NAME.test([c.label, ...c.target.map(nameOfCandidate)].join(' '))));
    if (dl < 0) dl = lastIndex((s) => clicks(s).length > 0);

    // One stripSecrets pass over every sequence, so a value typed into a credential field in one is a secret in all.
    // A boundary goto between sequences also ends any sign-in grouping, as a page change does.
    const all: ImportEvent[] = [];
    sequences.forEach((s, i) => {
      if (i > 0) all.push({ at: '', kind: 'goto', url: BOUNDARY });
      append(all, s.events);
    });
    const before = report.items.length;
    const stripped = stripSecrets(all, opts, report);
    const secretAt = new Set(report.items.slice(before).filter((i) => i.kind === 'secret').map((i) => i.at));
    for (const e of all) if ((e.kind === 'fill' || e.kind === 'select') && secretAt.has(e.at) && e.value.trim().length >= MIN_SECRET_LENGTH) typedSecrets.push(e.value);
    const parts: ImportEvent[][] = [[]];
    for (const e of stripped) {
      if (e.kind === 'goto' && e.url === BOUNDARY) parts.push([]);
      else parts[parts.length - 1].push(e);
    }
    // A later part of a card runs in its own browser: it gets a copy of the card's sign-in (locators only) after its
    // goto, so a split never loses the session. What the earlier part typed or opened is not replayed.
    const signInOf = new Map<number, ImportEvent>();
    parts.forEach((events, i) => {
      const card = sequences[i]?.card;
      if (card === undefined) return;
      const own = events.find((e) => e.kind === 'signIn');
      if (own) {
        if (!signInOf.has(card)) signInOf.set(card, own);
      } else if (sequences[i].continued && signInOf.has(card)) {
        const copy = structuredClone(signInOf.get(card)!);
        const where = events[0]?.kind === 'goto' ? 1 : 0;
        const at = events[0]?.at ?? copy.at;
        events.splice(where, 0, { ...copy, at });
        report.items.push({ at, kind: 'converted', what: 'Sign in', reason: 'this part runs in its own browser, so it signs in again with the first part\'s sign-in fields; fields typed and pages opened in the earlier part are not replayed: add them to this part if it needs them' });
      }
    });
    parts.forEach((events, i) => {
      const kept = events.filter((e) => {
        const reason = unresolvedReason(e);
        if (reason !== undefined) report.items.push({ at: e.at, kind: 'untranslated', what: describeEvent(e), reason });
        return reason === undefined;
      });
      const seqOpts: ImportOptions = { ...opts, download: i === dl ? opts.download : undefined, idPattern: i === 0 ? opts.idPattern : undefined, startUrl: i === 0 ? opts.startUrl : undefined };
      const number = sequences[i]?.number ?? i + 1;
      const draft = buildDraft(kept, seqOpts, report, `${opts.name}-${number}`);
      if (draft) drafts.push(draft);
      else missing.add(number);
    });
  } else if (desktop.length) {
    // Desktop drafts only: the report says so where the browser branch would say there are no browser steps.
  } else if (flow.nodes.length) {
    report.items.push({ at: '', kind: 'untranslated', what: 'Browser steps', reason: 'the project has no browser activities, so there are no steps to adopt: only the workflow around them' });
  } else if (!report.items.some((i) => i.kind === 'error')) {
    report.items.push({ at: '', kind: 'error', what: WHAT, reason: IMPORT_EMPTY });
  }

  // Defence in depth for the desktop drafts: none names a Site Login secret or a value typed into a credential field.
  const slAll = opts.hasSiteLogin ? [opts.secrets?.username, opts.secrets?.password, opts.secrets?.totpSecret] : [];
  const draftMasker = createMasker([...slAll.filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH), ...typedSecrets]);
  const shortSecrets = slAll.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length < MIN_SECRET_LENGTH).map((s) => s.trim().toLowerCase());
  const desktopDrafts: DesktopDraft[] = [];
  for (const seq of desktop) {
    const draft = buildDesktopDraft(seq, report);
    const typed = draft ? draft.script.steps.flatMap((s) => ('fill' in s ? [s.fill.value] : 'select' in s ? [s.select.option] : [])) : [];
    if (draft && (draftMasker.containsSecret(JSON.stringify(draft.script)) || typed.some((v) => shortSecrets.includes(v.trim().toLowerCase())))) {
      report.steps -= draft.script.steps.length;
      report.items.push({ at: '', kind: 'error', what: seq.name, reason: 'the desktop draft still named a sign-in value, so it was not returned' });
      missing.add(seq.number);
      continue;
    }
    if (draft) desktopDrafts.push(draft);
    else missing.add(seq.number);
  }

  // A sequence that built no draft is shown in the flow as untranslated, so the workflow never names a missing draft.
  const mark = (nodes: FlowNode[]): FlowNode[] => nodes.map((n) => {
    if (n.kind === 'browser' && missing.has(n.sequence)) return { kind: 'untranslated', activity: 'Browser steps', displayName: n.displayName, note: 'no step could be built from these browser activities: see the report' };
    if (n.kind === 'desktop' && missing.has(n.sequence)) return { kind: 'untranslated', activity: 'Desktop steps', displayName: n.displayName, note: 'no step could be built from these desktop activities: see the report' };
    if (n.kind === 'if') return { ...n, then: mark(n.then), else: mark(n.else) };
    if (n.kind === 'forEach') return { ...n, body: mark(n.body) };
    return n;
  });

  // Defence in depth: nothing the flow or the report carries names a Site Login secret or a value typed into a credential field.
  const sl = opts.hasSiteLogin ? opts.secrets : undefined;
  const slValues = [sl?.username, sl?.password, sl?.totpSecret].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const masker = createMasker([...slValues.filter((s) => s.length >= MIN_SECRET_LENGTH), ...typedSecrets]);
  const short = slValues.filter((s) => s.length < MIN_SECRET_LENGTH).map((s) => s.trim().toLowerCase());
  const secretMask = (t: string) => (short.includes(t.trim().toLowerCase()) ? '[secret]' : masker.mask(t));
  // A credential asset's name appears only as its slot (the credential node's `asset`), never in a name or the report.
  const assets = new Set<string>();
  const collect = (nodes: FlowNode[]) => nodes.forEach((n) => {
    if (n.kind === 'credential' && n.asset.length >= MIN_SECRET_LENGTH) assets.add(n.asset);
    if (n.kind === 'if') { collect(n.then); collect(n.else); }
    if (n.kind === 'forEach') collect(n.body);
  });
  collect(flow.nodes);
  const assetMask = (t: string) => { let out = t; for (const a of assets) out = replaceIgnoringCase(out, a, 'the credential'); return out; };
  const mask = (t: string) => assetMask(secretMask(t));
  capReport(report);
  for (const item of report.items) { item.at = mask(item.at); item.what = mask(item.what); item.reason = mask(item.reason); }
  const finalFlow = maskStrings<UiPathFlow>({ name: flow.name, nodes: mark(flow.nodes) }, mask, (key, v) => (key === 'asset' ? secretMask(v) : undefined));
  return { drafts, ...(desktopDrafts.length ? { desktopDrafts } : {}), report, ...(finalFlow.nodes.length ? { flow: finalFlow } : {}) };
}

/**
 * Cuts the report to MAX_REPORT_ITEMS items plus one summary item saying how many more there are. Errors, secrets and
 * project-wide items (no location) are kept first, then the rest in order; the kept items keep their order.
 */
function capReport(report: ImportReport): void {
  const items = report.items;
  if (items.length <= MAX_REPORT_ITEMS) return;
  const first = (i: ImportItem) => i.kind === 'error' || i.kind === 'secret' || i.at === '';
  let firstRoom = Math.min(MAX_REPORT_ITEMS, items.reduce((n, i) => n + (first(i) ? 1 : 0), 0));
  let restRoom = MAX_REPORT_ITEMS - firstRoom;
  const kept: ImportItem[] = [];
  for (const i of items) {
    if (first(i) ? firstRoom-- > 0 : restRoom-- > 0) kept.push(i);
  }
  const more = (items.length - kept.length).toLocaleString('en-US');
  kept.push({
    at: '', kind: 'untranslated', what: `…and ${more} more not translated`,
    reason: `the report lists ${MAX_REPORT_ITEMS} items (errors first): ${more} more activities were not translated, dropped or converted; see the UiPath project for them`,
  });
  report.items = kept;
}

/** Every string in a JSON value through `mask`; `byKey` may mask a property's string its own way (undefined: the default). */
function maskStrings<T>(value: T, mask: (s: string) => string, byKey?: (key: string, v: string) => string | undefined): T {
  if (typeof value === 'string') return mask(value) as T;
  if (Array.isArray(value)) return value.map((v) => maskStrings(v, mask, byKey)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'string' && byKey?.(k, v) !== undefined ? byKey(k, v) : maskStrings(v, mask, byKey)])) as T;
  }
  return value;
}

/** `text` with every case-insensitive occurrence of `needle` replaced. One scan. */
function replaceIgnoringCase(text: string, needle: string, by: string): string {
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  if (lower.length !== text.length || n.length !== needle.length) return text.replaceAll(needle, by);
  let out = '';
  let from = 0;
  for (let at = lower.indexOf(n); at >= 0; at = lower.indexOf(n, from)) {
    out += text.slice(from, at) + by;
    from = at + n.length;
  }
  return out + text.slice(from);
}

const EXPORT_NAME = /export|download|csv|xlsx|spreadsheet/i;
const nameOfCandidate = (c: Candidate): string => ('role' in c ? c.name ?? '' : 'label' in c ? c.label : 'text' in c ? c.text : '');

/**
 * Marks a fill or select whose typed text is an expression the import does not map (its value is ''): the hint carries
 * the report reason through stripSecrets, which keeps hints, and the event is dropped after it. Hints never reach steps.
 */
const UNRESOLVED = '\u0000uipath-unresolved\u0000';
const unresolvedReason = (e: ImportEvent): string | undefined =>
  (e.kind === 'fill' || e.kind === 'select') && e.value === '' ? e.hints.find((h) => h.startsWith(UNRESOLVED))?.slice(UNRESOLVED.length) : undefined;
/** Appends without spreading, so a list of any length is safe. */
function append<T>(out: T[], items: readonly T[]): T[] {
  for (const it of items) out.push(it);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The project

function loadProject(data: Buffer | Uint8Array | string, report: ImportReport): Project | undefined {
  const fail = (reason: string, at = ''): undefined => { report.items.push({ at, kind: 'error', what: WHAT, reason }); return undefined; };
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) return fail('the project must be a .zip of the project folder or a .xaml file');
  const size = typeof data === 'string' ? (data.length > MAX_UIPATH_BYTES ? Infinity : Buffer.byteLength(data, 'utf8')) : data.byteLength;
  if (size > MAX_UIPATH_BYTES) return fail('the file is larger than 20 MiB, so it was not read');
  const bytes = typeof data === 'string' ? undefined : Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

  if (bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return loadZip(bytes, report, fail);
  if (bytes && bytes.length > UIPATH_ZIP_CAPS.perEntry) return fail(`the workflow is larger than ${UIPATH_ZIP_CAPS.perEntry / 1024 / 1024} MiB, so it was not read`);
  if (typeof data === 'string' && data.length > UIPATH_ZIP_CAPS.perEntry) return fail(`the workflow is larger than ${UIPATH_ZIP_CAPS.perEntry / 1024 / 1024} MiB, so it was not read`);
  const text = typeof data === 'string' ? data : new TextDecoder('utf-8').decode(bytes);
  if (!text.trim()) return fail('the file is empty: import a .zip of the project folder or a .xaml file');
  return { files: new Map([['main.xaml', { path: 'Main.xaml', text }]]), main: 'main.xaml', objects: new Map(), single: true, csharp: false, budget: { left: MAX_PROJECT_ELEMENTS } };
}

function loadZip(bytes: Buffer, report: ImportReport, fail: (reason: string, at?: string) => undefined): Project | undefined {
  const accept = (name: string): boolean => {
    if (name.startsWith('__MACOSX/') || name.endsWith('/')) return false;
    const lower = name.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    return base === 'project.json' || (lower.endsWith('.xaml') && !lower.includes('/.local/') && !lower.startsWith('.local/'))
      || (base === '.content' && (lower.startsWith('.objects/') || lower.includes('/.objects/')));
  };
  const entries = readZipEntries(bytes, accept, UIPATH_ZIP_CAPS);
  if ('error' in entries) {
    return fail(entries.error === 'too-large' ? `the project archive is too large: ${entries.detail}` : `the project archive cannot be read: ${entries.detail}`);
  }
  const names = [...entries.keys()];
  // The project folder: where the shallowest project.json is; without one, a single top folder all workflows share.
  const projectJson = names.filter((n) => n.toLowerCase().endsWith('project.json') && (n.length === 12 || n[n.length - 13] === '/')).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  let root = '';
  if (projectJson) root = projectJson.slice(0, projectJson.length - 'project.json'.length);
  else {
    const tops = new Set(names.map((n) => (n.includes('/') ? n.slice(0, n.indexOf('/') + 1) : '')));
    if (tops.size === 1) root = [...tops][0];
  }
  const files = new Map<string, { path: string; text: string }>();
  const contents: { path: string; text: string }[] = [];
  const decoder = new TextDecoder('utf-8');
  for (const [name, buf] of entries) {
    if (!name.startsWith(root)) continue;
    const path = name.slice(root.length);
    const lower = path.toLowerCase();
    if (lower.endsWith('.xaml')) files.set(normPath(path), { path, text: decoder.decode(buf) });
    else if (lower.endsWith('/.content') && (lower.startsWith('.objects/'))) contents.push({ path, text: decoder.decode(buf) });
  }
  let name: string | undefined;
  let main: string | undefined;
  let csharp = false;
  if (projectJson) {
    let json: unknown;
    try { json = JSON.parse(decoder.decode(entries.get(projectJson)!).replace(/^﻿/, '')); } catch { /* reported below */ }
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const j = json as Json;
      if (typeof j.name === 'string') name = j.name;
      csharp = typeof j.expressionLanguage === 'string' && j.expressionLanguage.toLowerCase() === 'csharp';
      main = typeof j.main === 'string' && j.main ? j.main : 'Main.xaml';
    } else {
      report.items.push({ at: 'project.json', kind: 'untranslated', what: 'project.json', reason: 'project.json is not valid JSON: the import starts at Main.xaml' });
      main = 'Main.xaml';
    }
  }
  if (files.size === 0) return fail('the archive has no UiPath workflow (.xaml): zip the project folder');
  if (!main) {
    if (files.has('main.xaml')) main = 'Main.xaml';
    else if (files.size === 1) main = [...files.values()][0].path;
    else return fail('the archive has no project.json and no Main.xaml, so the import does not know where the bot starts');
  }
  if (!files.has(normPath(main))) return fail(`the main workflow ${main.slice(0, 200)} is not in the project`, 'project.json');
  const budget = { left: MAX_PROJECT_ELEMENTS };
  return { name, files, main: normPath(main), objects: indexObjects(contents, report, budget), single: false, csharp, budget };
}

/** The Object Repository: each element's `.content` by its Reference, and by its folder name (the element id). */
function indexObjects(contents: { path: string; text: string }[], report: ImportReport, budget: { left: number }): Map<string, RepoTarget> {
  const out = new Map<string, RepoTarget>();
  for (const { path, text } of contents) {
    const parsed = parseCounted(text, budget);
    if ('error' in parsed) {
      if (parsed.over) report.items.push({ at: path, kind: 'error', what: WHAT, reason: OVER_BUDGET(path) });
      else report.items.push({ at: path, kind: 'untranslated', what: 'Object Repository', reason: `an Object Repository element cannot be read (${parsed.error})` });
      continue;
    }
    const doc = parsed.root;
    let reference = doc.attrs.Reference;
    let found: RepoTarget | undefined;
    const stack: XmlNode[] = [doc];
    while (stack.length && !found) {
      const el = stack.pop()!;
      if (!reference && el.attrs.Reference) reference = el.attrs.Reference;
      const sel = el.attrs.FullSelectorArgument ?? el.attrs.Selector;
      if (sel !== undefined && !sel.startsWith('[') && !sel.startsWith('{')) found = { selector: sel, elementType: el.attrs.ElementType };
      for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
    }
    if (!found) continue;
    const parts = path.split('/');
    const folder = parts[parts.length - 2];
    if (reference) out.set(reference, found);
    if (folder && !out.has(`#${folder}`)) out.set(`#${folder}`, found);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The walk

const BODY_PROPS = new Set(['Body', 'ActivityBody', 'Action', 'Handler']);
const DROPPED: Record<string, string> = {
  LogMessage: 'logging is not a step: the run\'s own record and n8n\'s executions show what happened',
  WriteLine: 'logging is not a step: the run\'s own record and n8n\'s executions show what happened',
  Comment: 'a comment is not a step',
  CommentOut: 'the activities inside are commented out, so they were not imported',
  Assign: 'an assignment computes a value inside the bot: n8n expressions do that',
  MultipleAssign: 'an assignment computes a value inside the bot: n8n expressions do that',
};
const TAG_OF_TYPE: Record<string, string> = { button: 'BUTTON', inputbox: 'INPUT', input: 'INPUT', text: '', dropdown: 'SELECT', combobox: 'SELECT', listbox: 'SELECT', checkbox: 'INPUT', radiobutton: 'INPUT', link: 'A', hyperlink: 'A' };
const READ_RANGE = new Set(['ReadRange', 'ExcelReadRange', 'ReadRangeX']);
const WRITE_RANGE = new Set(['WriteRange', 'ExcelWriteRange', 'WriteRangeX']);
const EXCEL_SCOPE = new Set(['ExcelApplicationScope', 'ExcelProcessScopeX', 'ExcelApplicationCard']);

/**
 * A browser sequence: its events, and the card it belongs to; `continued` when an earlier sequence used the same card.
 * `number`: its place among all sequences, browser and desktop (the draft is `<name>-<number>`).
 */
export interface UiPathSequence { name: string; number: number; events: ImportEvent[]; card?: number; continued?: boolean }
/** What the walk returns: browser sequences, desktop sequences, literal secrets typed in desktop steps (never imported), and the flow. */
export interface WalkResult { sequences: UiPathSequence[]; desktop: DesktopSequence[]; typedSecrets: string[]; flow: UiPathFlow }

class Walker {
  private visited = 0;
  private work = 0;
  private cards = 0;
  private readonly parsed = new Map<string, Parsed | null>();
  private readonly selectors = new Map<string, ReturnType<typeof readSelector>>();
  private readonly cardsWithSequence = new Set<number>();
  private readonly desktop: ImportItem[] = [];
  private readonly sequences: UiPathSequence[] = [];
  private readonly desktopSequences: DesktopSequence[] = [];
  /** Sequences numbered so far, browser and desktop together. */
  private numbered = 0;
  /** Variables (lower case) that hold a password or another secret: a credential's password output, a secure value. */
  private readonly secretVars = new Set<string>();
  /** The names the steps type secrets as (their spelling in the steps). */
  private readonly secretVarNames = new Set<string>();
  /** Literal values a desktop step would have typed into a password field: never imported, masked out of everything. */
  private readonly desktopTypedSecrets: string[] = [];
  /** Each credential lookup's report item and its outputs (lower case), reworded at the end when desktop steps type them. */
  private readonly credentialItems: { item: ImportItem; outputs: string[] }[] = [];
  private readonly xmlns: Map<string, string>[] = [];
  /** The variables TOTP activities write their code to, lower case. */
  private readonly totpOutputs = new Set<string>();

  constructor(private readonly project: Project, private readonly opts: ImportOptions, private readonly report: ImportReport) {}

  run(): WalkResult {
    const main = this.project.files.get(this.project.main!)!;
    const parsed = this.parse(this.project.main!);
    const name = cleanLabel(this.project.name ?? '') || (parsed ? cleanLabel(parsed.root.attrs['x:Class'] ?? '') : '') || cleanLabel(this.opts.name);
    if (!parsed) return { sequences: [], desktop: [], typedSecrets: [], flow: { name, nodes: [] } };
    const ctx: Ctx = { file: main.path, stack: [this.project.main!], chain: [main.path], nesting: 0, desktop: false, aws: false, names: parsed.names, csharp: this.project.csharp };
    const items = this.workflow(this.project.main!, parsed, ctx);
    const nodes = this.finish(items);
    if (this.desktop.length) {
      this.report.items.push({ at: '', kind: 'untranslated', what: `SAP desktop activities (${this.desktop.length})`, reason: DESKTOP_HEADING_REASON });
      this.desktop.forEach((d, i) => this.report.items.push({ ...d, what: `${i + 1}. ${d.what}` }));
    }
    for (const seq of this.desktopSequences) seq.secretVariables = [...this.secretVarNames];
    // A credential whose password desktop steps type is supplied as run variables there, never by a Site Login.
    const desktopVars = new Set(this.desktopSequences.flatMap((q) => q.events.flatMap((e) => (e.kind === 'fill' || e.kind === 'select'
      ? [...(e.kind === 'fill' ? e.value : e.option).matchAll(/\{\{var\.([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1].toLowerCase()) : []))));
    for (const { item, outputs } of this.credentialItems) {
      if (outputs.some((o) => desktopVars.has(o))) {
        item.reason = 'a UiPath credential is never imported: desktop steps type its user name and password from run variables (see the secret items); browser steps use an RPA Site Login on the Run steps node';
      }
    }
    return { sequences: this.sequences, desktop: this.desktopSequences, typedSecrets: this.desktopTypedSecrets, flow: { name, nodes } };
  }

  /** A workflow file, parsed once within the project's element budget; null (and an error item) when it cannot be read. */
  private parse(key: string): Parsed | null {
    if (this.parsed.has(key)) return this.parsed.get(key)!;
    const file = this.project.files.get(key)!;
    const doc = parseCounted(file.text, this.project.budget);
    let parsed: Parsed | null = null;
    if ('error' in doc) {
      const where = this.project.single ? 'the workflow' : file.path;
      const at = this.project.single ? '' : file.path;
      this.report.items.push({ at, kind: 'error', what: WHAT, reason: doc.over ? OVER_BUDGET(where) : `${where} cannot be read: ${doc.error}` });
    } else parsed = doc;
    this.parsed.set(key, parsed);
    return parsed;
  }

  /** Charges one walk of a workflow file (its elements, and its text in 32-byte units) against MAX_WALK. */
  private charge(key: string, parsed: Parsed): void {
    this.work += parsed.elements + Math.ceil(this.project.files.get(key)!.text.length / 32);
    if (this.work > MAX_WALK) {
      this.add('', 'error', WHAT, `the project needs more work than an import does (over ${MAX_WALK.toLocaleString('en-US')} element visits once invoked workflows are followed), so it was not imported`);
      throw new Aborted();
    }
  }

  /** readSelector, once per selector string. */
  private selector(selector: string, tagHint?: string): ReturnType<typeof readSelector> {
    const key = `${tagHint ?? ''}\u0000${selector}`;
    let read = this.selectors.get(key);
    if (!read) {
      read = readSelector(selector, tagHint);
      this.selectors.set(key, read);
    }
    return read;
  }
  private arg(el: XmlNode, key: string, ctx: Ctx): Val { return argOf(el, key, ctx.csharp); }
  private lit(el: XmlNode, key: string, ctx: Ctx): string | undefined { return literalOf(el, key, ctx.csharp); }

  private add(at: string, kind: ImportItem['kind'], what: string, reason: string): void {
    this.report.items.push({ at, kind, what, reason });
  }

  private count(): void {
    if (++this.visited > MAX_UIPATH_ACTIVITIES) {
      this.add('', 'error', WHAT, `the project has more than ${MAX_UIPATH_ACTIVITIES.toLocaleString('en-US')} activities once invoked workflows are followed, so it was not imported`);
      throw new Aborted();
    }
  }

  /** The root Activity's activities (members, settings and namespaces are not activities). */
  private workflow(key: string, parsed: Parsed, ctx0: Ctx): Item[] {
    this.charge(key, parsed);
    const root = parsed.root;
    const editor = root.attrs['sap2010:ExpressionActivityEditor.ExpressionActivityEditor'];
    const ctx: Ctx = { ...ctx0, names: parsed.names, csharp: editor === 'C#' ? true : editor === 'VB' ? false : ctx0.csharp };
    const kids = content(root).filter((c) => prefixOf(c.name) !== 'x' && prefixOf(c.name) !== 'mc');
    const ns = new Map<string, string>();
    for (const [k, v] of Object.entries(root.attrs)) if (k === 'xmlns' || k.startsWith('xmlns:')) ns.set(k === 'xmlns' ? '' : k.slice(6), v);
    this.xmlns.push(ns);
    try {
      return this.list(local(root.name) === 'Activity' ? kids : [root], ctx);
    } finally {
      this.xmlns.pop();
    }
  }

  private list(els: XmlNode[], ctx: Ctx): Item[] {
    const out: Item[] = [];
    for (const el of els) append(out, this.activity(el, ctx));
    return out;
  }

  /** The activities inside a body: properties named Body/ActivityBody/… and ActivityAction wrappers, unwrapped. */
  private body(el: XmlNode, props: Set<string> = BODY_PROPS): XmlNode[] {
    const out: XmlNode[] = [];
    const unwrap = (els: XmlNode[]) => {
      for (const c of els) {
        if (local(c.name) === 'ActivityAction') unwrap(content(c));
        else out.push(c);
      }
    };
    for (const c of el.children) {
      if (isProperty(c)) { if (props.has(propertyName(c)) && local(c.name).split('.').length === 2) unwrap(content(c)); }
      else if (local(c.name) === 'ActivityAction') unwrap(content(c));
    }
    return out;
  }

  private at(el: XmlNode, ctx: Ctx): string {
    const id = el.attrs['sap2010:WorkflowViewState.IdRef'];
    return `${ctx.file}: ${id ? cleanLabel(id) : local(el.name)}`;
  }

  private untranslated(el: XmlNode, ctx: Ctx, note: string, activity = local(el.name)): Item[] {
    const displayName = displayOf(el);
    this.add(this.at(el, ctx), 'untranslated', displayName, `${activity}: ${note}`);
    return [{ t: 'node', node: { kind: 'untranslated', activity, displayName, note } }];
  }

  private desktopActivity(el: XmlNode, ctx: Ctx): Item[] {
    const displayName = displayOf(el);
    const activity = local(el.name);
    this.desktop.push({ at: this.at(el, ctx), kind: 'untranslated', what: displayName, reason: `${activity}: ${DESKTOP_NOTE}` });
    return [{ t: 'node', node: { kind: 'untranslated', activity, displayName, note: DESKTOP_NOTE } }];
  }

  private activity(el: XmlNode, ctx0: Ctx): Item[] {
    if (isProperty(el)) return [];
    this.count();
    const ctx = { ...ctx0, nesting: ctx0.nesting + 1 };
    if (ctx.nesting > MAX_NESTING) {
      this.add(this.at(el, ctx), 'error', WHAT, `the workflows are nested deeper than ${MAX_NESTING} elements once invoked workflows are followed: the rest of this branch was not imported`);
      return [];
    }
    const name = local(el.name);
    const displayName = displayOf(el);
    const at = this.at(el, ctx);

    if (name in DROPPED) {
      this.add(at, 'dropped', displayName, DROPPED[name]);
      return [];
    }
    if (TOTP_ACTIVITY.test(name)) return this.totpActivity(el, ctx);
    switch (name) {
      case 'Sequence':
        return this.list(content(el), ctx);
      case 'If': {
        const cond = this.arg(el, 'Condition', ctx);
        const branch = (prop: string) => this.list(this.body(el, new Set([prop])), ctx);
        return [{ t: 'if', expression: textOf(cond), displayName, then: branch('Then'), else: branch('Else') }];
      }
      case 'ForEach':
      case 'ForEachRow': {
        const values = this.arg(el, name === 'ForEach' ? 'Values' : 'DataTable', ctx);
        return [{ t: 'forEach', expression: textOf(values), displayName, body: this.list(this.body(el), ctx) }];
      }
      case 'TryCatch': {
        const out = this.list(this.body(el, new Set(['Try'])), ctx);
        const catches = el.children.find((c) => isProperty(c) && propertyName(c) === 'Catches');
        for (const c of catches ? content(catches) : []) {
          const type = c.attrs['x:TypeArguments'] ?? 'Exception';
          this.add(at, 'untranslated', `Catch ${local(type)}`, 'the catch branch was not imported: give the n8n node an error output or the workflow an error workflow');
        }
        append(out, this.list(this.body(el, new Set(['Finally'])), ctx));
        return out;
      }
      case 'Flowchart':
        return this.flowchart(el, ctx);
      case 'InvokeWorkflowFile':
        return this.invoke(el, ctx);
      case 'GetRobotCredential':
      case 'GetCredential': {
        const asset = textOf(this.arg(el, 'AssetName', ctx));
        // Its password output is a secret wherever a desktop step types it (desktop steps type it from a run variable).
        const password = this.arg(el, 'Password', ctx);
        if (password && 'expr' in password && IDENT.test(password.expr)) this.secretVars.add(password.expr.toLowerCase());
        const outputs = ['Password', 'Username'].map((k) => this.arg(el, k, ctx)).flatMap((v) => (v && 'expr' in v && IDENT.test(v.expr) ? [v.expr.toLowerCase()] : []));
        this.add(at, 'converted', displayName, 'a UiPath credential is never imported: attach an RPA Site Login to the Run steps node instead');
        this.credentialItems.push({ item: this.report.items[this.report.items.length - 1], outputs });
        return [{ t: 'node', node: { kind: 'credential', asset: cleanLabel(asset), displayName } }];
      }
      case 'GetAsset':
        return this.untranslated(el, ctx, 'an Orchestrator asset: set its value in n8n (a variable, or a credential when it is secret)');
      case 'HttpClient': {
        const method = this.lit(el, 'Method', ctx);
        const url = this.lit(el, 'EndPoint', ctx);
        return [{ t: 'node', node: { kind: 'http', ...(method ? { method: method.toUpperCase() } : {}), ...(url ? { url } : {}), displayName } }];
      }
      case 'SendSMTPMailMessage':
      case 'SendOutlookMailMessage': {
        const to = this.lit(el, 'To', ctx);
        const subject = this.lit(el, 'Subject', ctx);
        return [{ t: 'node', node: { kind: 'email', ...(to ? { to } : {}), ...(subject ? { subject } : {}), displayName } }];
      }
      case 'Delay': {
        if ((ctx.card && !ctx.desktop) || ctx.app) {
          this.add(at, 'converted', displayName, 'a wait inside the browser is not a step: steps wait for their elements; set timeoutMs on the next step if the page is slow');
          return [];
        }
        const s = seconds(this.lit(el, 'Duration', ctx));
        return [{ t: 'node', node: { kind: 'wait', ...(s !== undefined ? { seconds: s } : {}), displayName } }];
      }
    }
    if (EXCEL_SCOPE.has(name)) {
      const path = this.lit(el, 'WorkbookPath', ctx) ?? ctx.excelPath;
      return this.list(this.body(el), { ...ctx, excelPath: path });
    }
    if (READ_RANGE.has(name) || WRITE_RANGE.has(name)) {
      const path = this.lit(el, 'WorkbookPath', ctx) ?? ctx.excelPath;
      const sheet = this.lit(el, 'SheetName', ctx);
      return [{ t: 'node', node: { kind: READ_RANGE.has(name) ? 'readSpreadsheet' : 'writeSpreadsheet', ...(path ? { path } : {}), ...(sheet ? { sheet } : {}), displayName } }];
    }
    if (this.isAwsScope(el)) return this.list(this.body(el), { ...ctx, aws: true });
    if (name === 'UploadFile') {
      if (!ctx.aws) return this.untranslated(el, ctx, 'an upload outside an Amazon Web Services scope is not one this release knows (the Amazon S3 activity names are unverified): add the upload in n8n');
      const bucket = this.lit(el, 'BucketName', ctx) ?? this.lit(el, 'Bucket', ctx);
      const key = this.lit(el, 'KeyName', ctx) ?? this.lit(el, 'Key', ctx) ?? this.lit(el, 'ObjectKey', ctx);
      return [{ t: 'node', node: { kind: 's3Upload', ...(bucket ? { bucket } : {}), ...(key ? { key } : {}), displayName } }];
    }
    if (ctx.aws) return this.untranslated(el, ctx, 'this Amazon Web Services activity is not one this release knows (the Amazon S3 activity names are unverified): add it in n8n');

    // Browser cards and desktop applications.
    if (name === 'NApplicationCard' || name === 'OpenBrowser' || name === 'AttachBrowser' || name === 'BrowserScope') return this.card(el, ctx);
    if (/^N?SAP/.test(name) || ctx.desktop) return this.desktopActivity(el, ctx);
    if (name === 'OpenApplication' || name === 'WindowScope') return this.desktopScope(el, ctx);
    if (ctx.app) return this.desktopUi(el, ctx);
    return this.browserActivity(el, ctx);
  }

  /** An AWS or Amazon scope: by its local name or its namespace (the activity names are unverified). */
  private isAwsScope(el: XmlNode): boolean {
    const name = local(el.name);
    if (!name.endsWith('Scope')) return false;
    if (/amazon|aws/i.test(name)) return true;
    const prefix = prefixOf(el.name);
    for (let i = this.xmlns.length - 1; i >= 0; i--) {
      const uri = this.xmlns[i].get(prefix);
      if (uri !== undefined) return /amazon|aws/i.test(uri);
    }
    return /amazon|aws/i.test(el.attrs[prefix ? `xmlns:${prefix}` : 'xmlns'] ?? '');
  }

  private card(el: XmlNode, ctx: Ctx): Item[] {
    const name = local(el.name);
    const displayName = displayOf(el);
    const app = el.children.find((c) => isProperty(c) && propertyName(c) === 'TargetApp');
    const appEl = app ? content(app)[0] : undefined;
    const url = this.arg(el, 'Url', ctx) ?? (appEl ? this.arg(appEl, 'Url', ctx) : undefined);
    const selector = el.attrs.Selector ?? appEl?.attrs.Selector ?? '';
    const filePath = (appEl?.attrs.FilePath ?? '').toLowerCase();
    const desktop = ctx.desktop || (url === undefined && (this.selector(selector).desktop || (filePath.endsWith('.exe') && !/chrome|msedge|firefox|iexplore/.test(filePath))));
    // A UI Automation app (not SAP GUI): its activities become desktop steps.
    if (desktop && !ctx.desktop && !this.isSap(selector, filePath)) {
      const openMode = (el.attrs.OpenMode ?? '').toLowerCase();
      return this.desktopScope(el, ctx, { selector, filePath: appEl ? this.arg(appEl, 'FilePath', ctx) : undefined, args: appEl ? this.arg(appEl, 'Arguments', ctx) : undefined, launch: openMode !== 'never' });
    }
    if (desktop) {
      const out = this.desktopActivity(el, ctx);
      append(out, this.list(this.body(el), { ...ctx, desktop: true, card: undefined }));
      return out;
    }
    const out: Item[] = [];
    const address = url && 'literal' in url ? url.literal : undefined;
    const card = { id: ++this.cards, name: displayName, ...(address && isHttpUrl(address) ? { url: address } : {}) };
    if (address !== undefined && isHttpUrl(address)) out.push({ t: 'event', event: { at: this.at(el, ctx), kind: 'goto', url: address }, card: displayName, cardId: card.id, url: address });
    else if (url !== undefined) this.add(this.at(el, ctx), 'untranslated', displayName, `${name}: the address is ${'expr' in url ? `the expression ${url.expr.slice(0, 200)}` : 'not an http(s) address'}: add a goto step with the address`);
    append(out, this.list(this.body(el), { ...ctx, card }));
    return out;
  }

  private event(event: ImportEvent, ctx: Ctx): Item {
    return { t: 'event', event, card: ctx.card?.name ?? 'Browser steps', ...(ctx.card ? { cardId: ctx.card.id } : {}), ...(ctx.card?.url ? { url: ctx.card.url } : {}) };
  }

  /** The activity's target: its selector (from the Object Repository when it is a Reference), or why there is none. */
  private target(el: XmlNode, ctx: Ctx): { candidates: Candidate[]; hints: string[]; desktop: boolean; problem?: string; issues: string[] } {
    const prop = el.children.find((c) => isProperty(c) && propertyName(c) === 'Target');
    const t = prop ? content(prop)[0] : undefined;
    const none = (problem: string) => ({ candidates: [], hints: [], desktop: false, problem, issues: [] });
    if (!t) {
      const sel = attrValue(el.attrs.Selector);
      if (sel && 'literal' in sel) return this.fromSelector(sel.literal, undefined, '');
      return none('the activity has no target the import can read');
    }
    const scope = t.attrs.ScopeSelectorArgument ?? '';
    let full = this.arg(t, 'FullSelectorArgument', ctx) ?? this.arg(t, 'Selector', ctx);
    let elementType: string | undefined = t.attrs.ElementType;
    if (full === undefined && t.attrs.Reference) {
      const ref = t.attrs.Reference;
      const found = this.project.objects.get(ref) ?? this.project.objects.get(`#${ref.slice(ref.lastIndexOf('/') + 1)}`);
      if (!found?.selector) return none(`its Object Repository element (${ref.slice(0, 120)}) is not in the project's .objects folder`);
      full = { literal: found.selector };
      elementType ??= found.elementType;
    }
    if (full === undefined) {
      const steps = (t.attrs.SearchSteps ?? '').toLowerCase();
      if (steps.includes('image') || steps.includes('cv') || t.attrs.CVScreenId || t.attrs.ImageBase64) return none('the target is found by image or computer vision, which the import cannot read');
      if (t.attrs.FuzzySelectorArgument) return none('the target has only a fuzzy selector, which the import does not read');
      return none('the target has no selector');
    }
    if ('expr' in full) return none(`the selector is the expression ${full.expr.slice(0, 200)}, which is not evaluated`);
    const tagHint = elementType ? TAG_OF_TYPE[elementType.toLowerCase()] : undefined;
    return this.fromSelector(full.literal, tagHint || undefined, scope);
  }

  private fromSelector(selector: string, tagHint: string | undefined, scope: string) {
    const read = this.selector(selector, tagHint);
    const desktop = read.desktop || (scope !== '' && this.selector(scope).desktop);
    return { candidates: read.candidates, hints: [selector, ...read.hints], desktop, issues: read.issues, ...(read.candidates.length ? {} : { problem: read.issues[0] ?? 'the selector names no web element' }) };
  }

  private browserActivity(el: XmlNode, ctx: Ctx): Item[] {
    const name = local(el.name);
    const displayName = displayOf(el);
    const at = this.at(el, ctx);
    const label = intentLabel(el.attrs.DisplayName ?? '');
    // A UI Automation app's element outside a window scope (a full <wnd> selector): a desktop step. SAP GUI stays below.
    if (this.desktopKind(el, ctx) === 'desktop') return this.desktopUi(el, ctx);

    if (name === 'NGoToUrl' || name === 'NNavigateTo' || name === 'NavigateTo') {
      const url = this.arg(el, 'Url', ctx);
      if (url && 'literal' in url && isHttpUrl(url.literal)) return [this.event({ at, kind: 'goto', url: url.literal }, ctx)];
      return this.untranslated(el, ctx, url && 'expr' in url ? `the address is the expression ${url.expr.slice(0, 200)}, which is not evaluated: add a goto step` : 'the address is not an http(s) address');
    }
    if (name === 'WaitForDownload' || name === 'NWaitForDownload') {
      const inner = this.list(this.body(el), ctx);
      const lastClick = [...inner].reverse().find((i): i is Extract<Item, { t: 'event' }> => i.t === 'event' && i.event.kind === 'click');
      if (lastClick && lastClick.event.kind === 'click') lastClick.event.download = true;
      else this.add(at, 'untranslated', displayName, `${name}: no click inside starts the download`);
      return inner;
    }
    if (name === 'NGetText' || name === 'GetText' || name === 'NExtractData' || name === 'ExtractData') return this.untranslated(el, ctx, DATA_NOTE);

    const isClick = name === 'NClick' || name === 'Click';
    const isType = name === 'NTypeInto' || name === 'TypeInto' || name === 'TypeSecureText';
    const isSelect = name === 'NSelectItem' || name === 'SelectItem';
    const isCheck = name === 'NCheck' || name === 'Check';
    const isHotkey = name === 'SendHotkey';
    if (!isClick && !isType && !isSelect && !isCheck && !isHotkey) {
      const inner = this.body(el).length;
      return this.untranslated(el, ctx, `this activity has no step equivalent in this release${inner ? `: the ${inner === 1 ? '1 activity' : `${inner} activities`} inside ${inner === 1 ? 'was' : 'were'} not imported` : ''}`);
    }
    if (isHotkey) {
      const key = (this.lit(el, 'Key', ctx) ?? '').toLowerCase();
      if (key === 'enter' || key === 'return') return [this.event({ at, kind: 'enter', label }, ctx)];
      return this.untranslated(el, ctx, 'a keyboard shortcut is not a step: add a click on what it does');
    }

    const target = this.target(el, ctx);
    if (target.desktop) return this.desktopActivity(el, ctx);
    const what = (e: ImportEvent) => describeEvent(e);
    for (const issue of target.issues) if (target.candidates.length) this.add(at, 'converted', label || displayName, issue);
    const secure = isType && (name === 'TypeSecureText' || el.attrs.SecureText !== undefined || el.children.some((c) => isProperty(c) && propertyName(c) === 'SecureText'));
    const shape = isClick ? ({ kind: 'click' } as const) : isCheck ? ({ kind: 'check' } as const) : ({ kind: isSelect ? 'select' : 'fill' } as const);
    if (!target.candidates.length) {
      // The value is never read for the report: only the step's kind and label.
      const e = shape.kind === 'click' ? { at, kind: 'click' as const, target: [], label }
        : shape.kind === 'check' ? { at, kind: 'check' as const, target: [], label, checked: true }
          : { at, kind: shape.kind, target: [], label, value: '', hints: [] };
      this.add(at, 'dropped', what(e), `${name}: ${target.problem ?? 'no usable target'}`);
      return [];
    }

    if (isClick) return [this.event({ at, kind: 'click', target: target.candidates, label }, ctx)];
    if (isCheck) {
      const action = (this.lit(el, 'Action', ctx) ?? 'Check').toLowerCase();
      if (action === 'toggle') this.add(at, 'converted', label || displayName, 'Toggle became Check: change the step to unchecked if the box should be cleared');
      return [this.event({ at, kind: 'check', target: target.candidates, label, checked: action !== 'uncheck' }, ctx)];
    }
    const hints = [...target.hints, displayName];
    if (secure) {
      const e: Typed = { at, kind: 'fill', target: target.candidates, label, value: '', secure: true, hints };
      return [this.event(e, ctx)];
    }
    const val = this.arg(el, isSelect ? 'Item' : 'Text', ctx);
    const out: Item[] = [];
    const e: Typed = { at, kind: isSelect ? 'select' : 'fill', target: target.candidates, label, value: '', hints };
    if (val && 'literal' in val) {
      const { text, enter } = isSelect ? { text: val.literal, enter: false } : specialKeys(val.literal);
      e.value = text;
      if (text !== val.literal) this.add(at, 'converted', what(e), 'special keys typed with the text ([k(…)]) were removed from it');
      out.push(this.event(e, ctx));
      if (enter) out.push(this.event({ at, kind: 'enter', label }, ctx));
      return out;
    }
    if (val && 'expr' in val) {
      hints.push(val.expr);
      const code = IDENT.test(val.expr) && this.totpOutputs.has(val.expr.toLowerCase());
      if (code) hints.push(TOTP_OUTPUT_HINT);
      const key = IDENT.test(val.expr) ? varKey(val.expr, this.opts.vars) : undefined;
      if (key) {
        e.value = `{{var.${key}}}`;
        return [this.event(e, ctx)];
      }
      hints.push(code
        ? `${UNRESOLVED}the typed text is a one-time code from a TOTP activity (${val.expr.slice(0, 200)}): only a code typed right after the sign-in's submit becomes the sign-in's code, so add it to the signIn step by hand`
        : `${UNRESOLVED}the typed text is the expression ${val.expr.slice(0, 200)}, which is not evaluated: map it with Variables (or type the value into the step)`);
      return [this.event(e, ctx)];
    }
    hints.push(`${UNRESOLVED}the activity types no text`);
    return [this.event(e, ctx)];
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Desktop applications driven through UI Automation (anything but SAP GUI, which keeps the SAP report branch)

  /** readDesktopSelector, once per selector string. */
  private readonly desktopReads = new Map<string, DesktopSelectorRead>();
  private desktopRead(selector: string): DesktopSelectorRead {
    let read = this.desktopReads.get(selector);
    if (!read) {
      read = readDesktopSelector(selector);
      this.desktopReads.set(selector, read);
    }
    return read;
  }

  /** SAP GUI for Windows: by its selector (<sap>, saplogon.exe, SAP_FRONTEND_SESSION) or its executable. */
  private isSap(selector: string, filePath = ''): boolean {
    return this.desktopRead(selector).kind === 'sap' || /(^|[\\/])(saplogon|sapgui|saplgpad)\.exe$/i.test(filePath.trim());
  }

  /** The activity's selectors: its full selector, its scope selector, or why there is none it can read. */
  private desktopSelectors(el: XmlNode, ctx: Ctx): { full?: string; scope?: string; problem?: string } {
    const prop = el.children.find((c) => isProperty(c) && propertyName(c) === 'Target');
    const t = prop ? content(prop)[0] : undefined;
    if (!t) {
      const sel = attrValue(el.attrs.Selector, ctx.csharp);
      if (sel && 'literal' in sel) return { full: sel.literal };
      return sel ? { problem: `the selector is the expression ${sel.expr.slice(0, 200)}, which is not evaluated` } : {};
    }
    const scope = t.attrs.ScopeSelectorArgument;
    let full = this.arg(t, 'FullSelectorArgument', ctx) ?? this.arg(t, 'Selector', ctx);
    if (full === undefined && t.attrs.Reference) {
      const ref = t.attrs.Reference;
      const found = this.project.objects.get(ref) ?? this.project.objects.get(`#${ref.slice(ref.lastIndexOf('/') + 1)}`);
      if (!found?.selector) return { problem: `its Object Repository element (${ref.slice(0, 120)}) is not in the project's .objects folder` };
      full = { literal: found.selector };
    }
    if (full === undefined) {
      const steps = (t.attrs.SearchSteps ?? '').toLowerCase();
      if (steps.includes('image') || steps.includes('cv') || t.attrs.CVScreenId || t.attrs.ImageBase64) return { scope, problem: 'the target is found by image or computer vision, which UI Automation cannot read: rebuild this step on the app\'s elements' };
      return { scope, problem: 'the target has no selector' };
    }
    if ('expr' in full) return { scope, problem: `the selector is the expression ${full.expr.slice(0, 200)}, which is not evaluated` };
    return { full: full.literal, ...(scope !== undefined ? { scope } : {}) };
  }

  /** 'desktop' when the activity's target is a desktop selector of a UI Automation app (not SAP GUI, not a web page). */
  private desktopKind(el: XmlNode, ctx: Ctx): 'desktop' | undefined {
    const { full, scope } = this.desktopSelectors(el, ctx);
    const kinds = [full, scope].filter((s): s is string => s !== undefined).map((s) => this.desktopRead(s).kind);
    if (kinds.includes('sap') || kinds.length === 0) return undefined;
    return kinds.some((k) => k !== 'none') ? 'desktop' : undefined;
  }

  /**
   * Open Application, Attach Window or a Use Application card on a UI Automation app: a launch (unless it only attaches)
   * and a window scope, then its body as desktop activities in that window.
   */
  private desktopScope(el: XmlNode, ctx: Ctx, card?: { selector: string; filePath?: Val; args?: Val; launch: boolean }): Item[] {
    const name = local(el.name);
    const displayName = displayOf(el);
    const at = this.at(el, ctx);
    let selector = card?.selector ?? '';
    if (!card) {
      const sel = this.arg(el, 'Selector', ctx) ?? (() => {
        const prop = el.children.find((c) => isProperty(c) && propertyName(c) === 'Target');
        const t = prop ? content(prop)[0] : undefined;
        return t ? this.arg(t, 'Selector', ctx) : undefined;
      })();
      if (sel && 'literal' in sel) selector = sel.literal;
      else if (sel) this.add(at, 'converted', displayName, `${name}: the window selector is the expression ${sel.expr.slice(0, 200)}, which is not evaluated: the steps find their elements in any window of the app`);
    }
    if (this.isSap(selector)) return this.desktopActivity(el, ctx);
    const read = this.desktopRead(selector);
    if (read.kind === 'untranslated') {
      this.add(at, 'untranslated', displayName, `${name}: ${read.reason}`);
      return [];
    }
    const window = read.kind === 'uia' || read.kind === 'window' ? read.window : undefined;
    if (read.kind === 'uia' || read.kind === 'window') for (const issue of read.issues) this.add(at, 'converted', displayName, issue);
    const fileVal = card ? card.filePath : this.arg(el, 'FileName', ctx);
    const argsVal = card ? card.args : this.arg(el, 'Arguments', ctx);
    const launch = card ? card.launch : name === 'OpenApplication';
    let exe = window?.exe;
    if (fileVal && 'literal' in fileVal) {
      const file = fileVal.literal.trim().replace(/^"|"$/g, '');
      const base = file.split(/[\\/]/).pop() ?? '';
      if (/\.exe$/i.test(base)) {
        exe = base;
        if (launch && base !== file) this.add(at, 'converted', displayName, `the app opens as ${base}: the desktop runner's policy names the path it runs (${file.slice(0, 200)})`);
      }
    } else if (fileVal && launch) {
      this.add(at, 'converted', displayName, `${name}: the app's path is the expression ${fileVal.expr.slice(0, 200)}, which is not evaluated: the steps open ${exe ?? 'the app the window selector names'}`);
    }
    const out: Item[] = [];
    const scopeName = displayName;
    if (launch && exe) {
      const args = argsVal && 'literal' in argsVal && argsVal.literal.trim() ? [argsVal.literal.trim()] : undefined;
      if (args) this.add(at, 'converted', displayName, 'the app\'s arguments became one argument (app.args): check them, and list them in the runner\'s policy (allowedArgs)');
      else if (argsVal && 'expr' in argsVal) this.add(at, 'untranslated', displayName, `the app's arguments are the expression ${argsVal.expr.slice(0, 200)}, which is not evaluated: add them to app.args by hand`);
      out.push({ t: 'desktop', event: { at, kind: 'launch', exe, ...(args ? { args } : {}), ...(window ? { window } : {}), label: displayName }, scope: scopeName });
    }
    if (window) out.push({ t: 'desktop', event: { at, kind: 'scope', window, label: displayName }, scope: scopeName });
    append(out, this.list(this.body(el), { ...ctx, app: { ...(window ? { window } : {}), ...(exe ? { exe } : {}), name: scopeName }, card: undefined }));
    return out;
  }

  /** The activity's UI Automation target: its selector's path in its own window, else the scope's; or why there is none. */
  private desktopTarget(el: XmlNode, ctx: Ctx): { target?: UiaTarget; problem?: string; sap?: true; issues: string[]; hints: string[] } {
    const { full, scope, problem } = this.desktopSelectors(el, ctx);
    if (problem) return { problem, issues: [], hints: [] };
    const read: DesktopSelectorRead = full !== undefined ? this.desktopRead(full) : { kind: 'none' };
    const scopeRead: DesktopSelectorRead = scope !== undefined ? this.desktopRead(scope) : { kind: 'none' };
    if (read.kind === 'sap' || scopeRead.kind === 'sap') return { sap: true, issues: [], hints: [] };
    if (read.kind === 'untranslated') return { problem: read.reason, issues: [], hints: read.hints };
    if (read.kind === 'none') return { problem: full === undefined ? 'the activity has no target the import can read' : 'the selector names no desktop element (it is not a <wnd>, <uia> or <ctrl> selector)', issues: [], hints: [] };
    if (read.kind === 'window') return { problem: 'the selector names only a window, not an element in it', issues: read.issues, hints: read.hints };
    const scopeWindow = scopeRead.kind === 'uia' || scopeRead.kind === 'window' ? scopeRead.window : undefined;
    const window = read.window ?? scopeWindow ?? ctx.app?.window;
    return { target: { ...(window ? { window: { ...window } } : {}), path: read.path }, issues: read.issues, hints: read.hints };
  }

  /** The run variable an expression names (`[in_Company]` → in_Company), or undefined when it is not a plain variable. */
  private desktopVar(expr: string): string | undefined {
    if (!IDENT.test(expr)) return undefined;
    return varKey(expr, this.opts.vars) ?? expr;
  }

  /**
   * One desktop activity (Click, Type Into, Type Secure Text, Select Item, Check, Send Hotkey, Get Text) as a desktop
   * event. Anything it cannot translate is a report item and no step, so the desktop sequence around it stays whole.
   */
  private desktopUi(el: XmlNode, ctx: Ctx): Item[] {
    const name = local(el.name);
    const displayName = displayOf(el);
    const at = this.at(el, ctx);
    const label = intentLabel(el.attrs.DisplayName ?? '');
    const scope = ctx.app?.name ?? displayName;
    const item = (event: DesktopEvent): Item => ({ t: 'desktop', event, scope });
    const skip = (kind: ImportItem['kind'], reason: string): Item[] => { this.add(at, kind, displayName, `${name}: ${reason}`); return []; };

    if (/^(CV|N?Image|Ocr|N?FindImage|ClickImage|ClickText|ClickOCRText|HoverImage)/.test(name) || /Image$|OCR/.test(name)) {
      return skip('untranslated', 'the target is found by image, OCR or computer vision, which UI Automation cannot read: rebuild this step on the app\'s elements');
    }
    const isClick = name === 'NClick' || name === 'Click' || name === 'DoubleClick';
    const isType = name === 'NTypeInto' || name === 'TypeInto' || name === 'TypeSecureText' || name === 'SetText' || name === 'NSetText';
    const isSelect = name === 'NSelectItem' || name === 'SelectItem';
    const isCheck = name === 'NCheck' || name === 'Check';
    const isHotkey = name === 'SendHotkey';
    const isRead = name === 'NGetText' || name === 'GetText' || name === 'GetValue' || name === 'GetFullText' || name === 'GetVisibleText';
    if (!isClick && !isType && !isSelect && !isCheck && !isHotkey && !isRead) {
      const inner = this.body(el).length;
      return skip('untranslated', `this activity has no desktop step equivalent in this release${inner ? `: the ${inner === 1 ? '1 activity' : `${inner} activities`} inside ${inner === 1 ? 'was' : 'were'} not imported` : ''}`);
    }
    const hasTarget = el.children.some((c) => isProperty(c) && propertyName(c) === 'Target') || el.attrs.Selector !== undefined;
    const t = isHotkey && !hasTarget ? { issues: [], hints: [] as string[] } : this.desktopTarget(el, ctx);
    if ('sap' in t && t.sap) return this.desktopActivity(el, ctx);
    if ('problem' in t && t.problem) return skip(/image|computer vision|Java|remote desktop|mixes/.test(t.problem) ? 'untranslated' : 'dropped', t.problem);
    for (const issue of t.issues) this.add(at, 'converted', label || displayName, issue);
    const target = 'target' in t ? t.target : undefined;

    if (isHotkey) {
      const chord = canonicalChord(this.lit(el, 'Key', ctx) ?? '', this.lit(el, 'KeyModifiers', ctx) ?? '');
      if ('error' in chord) return skip('untranslated', chord.error);
      return [item({ at, kind: 'key', ...(target ? { target } : {}), label: '', chord: chord.chord })];
    }
    if (!target) return skip('dropped', 'the activity has no target the import can read');
    if (isClick) {
      if (name === 'DoubleClick' || (this.lit(el, 'ClickType', ctx) ?? '').toLowerCase().includes('double')) this.add(at, 'converted', label || displayName, 'a double click became a click: desktop steps click once');
      return [item({ at, kind: 'click', target, label })];
    }
    if (isCheck) {
      const action = (this.lit(el, 'Action', ctx) ?? 'Check').toLowerCase();
      if (action === 'toggle') this.add(at, 'converted', label || displayName, 'Toggle became Check: change the step to unchecked if the box should be cleared');
      return [item({ at, kind: 'check', target, label, checked: action !== 'uncheck' })];
    }
    if (isRead) {
      const out = ['Value', 'Text', 'TextString', 'Result'].map((k) => this.arg(el, k, ctx)).find((v) => v && 'expr' in v && IDENT.test(v.expr));
      const as = out && 'expr' in out ? out.expr : '';
      return [item({ at, kind: 'read', target, label, as })];
    }
    if (isSelect) {
      const v = this.arg(el, 'Item', ctx);
      if (v && 'literal' in v && v.literal !== '') return [item({ at, kind: 'select', target, label, option: v.literal })];
      const varName = v && 'expr' in v ? this.desktopVar(v.expr) : undefined;
      if (varName) {
        this.add(at, 'converted', label || displayName, `the item is the UiPath variable ${varName}: the step chooses {{var.${varName}}}; set ${varName} in Run steps → Variables`);
        return [item({ at, kind: 'select', target, label, option: `{{var.${varName}}}` })];
      }
      return skip('untranslated', v && 'expr' in v ? `the item is the expression ${v.expr.slice(0, 200)}, which is not evaluated: choose the item in the step by hand` : 'the activity chooses no item');
    }

    // Typing. A secure value, a credential's password or a password-like field never carries a value: a run variable.
    const fieldHints = [...t.hints, displayName].join(' ');
    const passwordField = PASSWORD_FIELD.test(fieldHints);
    const secureProp = name === 'TypeSecureText' || el.attrs.SecureText !== undefined || el.children.some((c) => isProperty(c) && propertyName(c) === 'SecureText');
    const secret = (varName: string, source: string): Item[] => {
      this.secretVars.add(varName.toLowerCase());
      this.secretVarNames.add(varName);
      this.add(at, 'secret', label || displayName,
        `${source} is never imported: the step types the run variable {{var.${varName}}}. Supply ${varName} in Run steps → Options → Variables from a secret source (an n8n external secret, or a node that reads your vault), never as plain text in the workflow; the run masks typed values in its messages and logs, and the runner never returns a password field's value`);
      return [item({ at, kind: 'fill', target, label, value: `{{var.${varName}}}` })];
    };
    if (secureProp) {
      const v = this.arg(el, 'SecureText', ctx);
      const varName = (v && 'expr' in v ? this.desktopVar(v.expr) : undefined) ?? 'password';
      return secret(varName, v && 'expr' in v && IDENT.test(v.expr) ? `the secure text (${v.expr.slice(0, 80)})` : 'the secure text');
    }
    const val = this.arg(el, 'Text', ctx);
    if (val && 'literal' in val) {
      const { text, enter } = specialKeys(val.literal);
      if (text !== val.literal) this.add(at, 'converted', label || displayName, 'special keys typed with the text ([k(…)]) were removed from it');
      const out: Item[] = [];
      if (passwordField && text !== '') {
        if (text.trim()) this.desktopTypedSecrets.push(text);
        append(out, secret('password', 'a value typed into a password field'));
      } else if (isSaveField(target)) {
        const file = text.split(/[\\/]/).pop() ?? '';
        if (!file.trim()) return skip('untranslated', 'the typed save path names no file: type {{$exportDir}}\\<file> by hand and add an expectFile step');
        this.add(at, 'converted', label || displayName, `the save path became {{$exportDir}}\\${file}: the app saves into the run's export folder, and the file comes back to n8n`);
        out.push(item({ at, kind: 'fill', target, label, value: `{{$exportDir}}\\${file}`, exportFile: file }));
      } else {
        out.push(item({ at, kind: 'fill', target, label, value: text }));
      }
      if (enter) out.push(item({ at, kind: 'key', target, label: '', chord: 'Enter' }));
      return out;
    }
    if (val && 'expr' in val) {
      if (isSaveField(target)) {
        const file = savePathFile(val.expr, ctx.csharp);
        if (!file) return skip('untranslated', `the save path is the expression ${val.expr.slice(0, 200)}, which the import cannot split into a folder and a literal file name: type {{$exportDir}}\\<file> into the field by hand and add an expectFile step`);
        this.add(at, 'converted', label || displayName, `the save path ${val.expr.slice(0, 200)} became {{$exportDir}}\\${file}: the app saves into the run's export folder instead of the folder variable, and the file comes back to n8n`);
        return [item({ at, kind: 'fill', target, label, value: `{{$exportDir}}\\${file}`, exportFile: file })];
      }
      const varName = this.desktopVar(val.expr);
      if (varName && (this.secretVars.has(val.expr.toLowerCase()) || passwordField || PASSWORD_NAME.test(varName))) return secret(varName, `the password (${val.expr.slice(0, 80)})`);
      if (varName) {
        this.add(at, 'converted', label || displayName, `the typed text is the UiPath variable ${varName}: the step types {{var.${varName}}}; set ${varName} in Run steps → Variables`);
        return [item({ at, kind: 'fill', target, label, value: `{{var.${varName}}}` })];
      }
      return skip('untranslated', `the typed text is the expression ${val.expr.slice(0, 200)}, which is not evaluated: map it to a variable in the step by hand`);
    }
    return skip('dropped', 'the activity types no text');
  }

  /**
   * A TOTP activity is no step and no flow node (it never splits the browser steps around it). The variables it
   * writes (its arguments that are a bare variable, other than its secret) mark the fills typed from them as codes.
   */
  private totpActivity(el: XmlNode, ctx: Ctx): Item[] {
    const keys = new Set([...Object.keys(el.attrs), ...el.children.filter(isProperty).map(propertyName)]);
    for (const key of keys) {
      if (key.includes(':') || key.includes('.') || TOTP_INPUT.test(key)) continue;
      const v = this.arg(el, key, ctx);
      if (v && 'expr' in v && IDENT.test(v.expr)) this.totpOutputs.add(v.expr.toLowerCase());
    }
    this.add(this.at(el, ctx), 'converted', displayOf(el), `${local(el.name)}: a one-time code is never imported: the sign-in types a fresh code from the RPA Site Login's authenticator secret (TOTP)`);
    return [];
  }

  private invoke(el: XmlNode, ctx: Ctx): Item[] {
    const file = this.arg(el, 'WorkflowFileName', ctx);
    if (!file || 'expr' in file) return this.untranslated(el, ctx, file ? `the workflow file is the expression ${file.expr.slice(0, 200)}, which is not evaluated` : 'it names no workflow file');
    const wanted = normPath(file.literal);
    const shown = wanted ? file.literal.replace(/\\/g, '/').replace(/^(\.\/)+/, '') : file.literal;
    if (this.project.single) return this.untranslated(el, ctx, `${shown} is not in the import: import the project folder as a zip`);
    const dir = normPath(ctx.file).split('/').slice(0, -1).join('/');
    const key = this.project.files.has(wanted) ? wanted : dir && this.project.files.has(normPath(`${dir}/${file.literal}`)) ? normPath(`${dir}/${file.literal}`) : undefined;
    if (!key) return this.untranslated(el, ctx, `${shown} is not in the project archive`);
    const target = this.project.files.get(key)!;
    if (ctx.stack.includes(key)) {
      const chain = [...ctx.chain, target.path].join(' → ');
      this.add(this.at(el, ctx), 'error', WHAT, `the workflows invoke each other in a cycle (${chain}): the repeated invoke was not followed`);
      return this.untranslated(el, ctx, `the invoke would repeat a workflow already running (a cycle): ${chain}`);
    }
    if (ctx.stack.length > MAX_INVOKE_DEPTH) {
      this.add(this.at(el, ctx), 'error', WHAT, `invoked workflows are nested deeper than ${MAX_INVOKE_DEPTH} levels (${target.path}): it was not followed`);
      return this.untranslated(el, ctx, `invoked workflows are nested deeper than ${MAX_INVOKE_DEPTH} levels`);
    }
    const parsed = this.parse(key);
    if (!parsed) return this.untranslated(el, ctx, `${target.path} cannot be read: see the report`);
    return this.workflow(key, parsed, { ...ctx, file: target.path, stack: [...ctx.stack, key], chain: [...ctx.chain, target.path] });
  }

  /** A Flowchart, followed from its start node while it is linear; a decision or switch ends it with a report. */
  private flowchart(el: XmlNode, ctx: Ctx): Item[] {
    // x:Name is unique in a workflow file, so the file's index (built once at parse) serves every Flowchart in it.
    const named = ctx.names;
    const resolve = (holder: XmlNode | undefined): XmlNode | undefined => {
      const node = holder ? content(holder)[0] : undefined;
      if (!node) return undefined;
      if (local(node.name) === 'Reference' && prefixOf(node.name) === 'x') return named.get(node.text.trim()) ?? named.get(node.attrs.Name ?? '');
      return node;
    };
    const out: Item[] = [];
    const seen = new Set<XmlNode>();
    let node = resolve(el.children.find((c) => isProperty(c) && propertyName(c) === 'StartNode'));
    while (node) {
      if (seen.has(node)) {
        append(out, this.untranslated(node, ctx, 'the Flowchart loops back to an earlier step: rebuild the loop in n8n', 'Flowchart'));
        break;
      }
      seen.add(node);
      const kind = local(node.name);
      if (kind !== 'FlowStep') {
        append(out, this.untranslated(node, ctx, 'a Flowchart branch is not imported (only a linear Flowchart is): rebuild it with an If', kind));
        break;
      }
      append(out, this.list(content(node), ctx));
      node = resolve(node.children.find((c) => isProperty(c) && propertyName(c) === 'Next'));
    }
    return out;
  }

  /**
   * Turns walked items into flow nodes: each run of browser events is one sequence (a `browser` node), and any other
   * node ends it. A sequence that continues a card after another node opens the card's address again (its own browser).
   */
  private finish(items: Item[]): FlowNode[] {
    const nodes: FlowNode[] = [];
    let current: UiPathSequence | undefined;
    let desktop: DesktopSequence | undefined;
    for (const it of items) {
      if (it.t === 'desktop') {
        current = undefined;
        if (!desktop) {
          const number = ++this.numbered;
          desktop = { number, name: `${this.opts.name}-${number}`, displayName: it.scope, events: [], secretVariables: [] };
          this.desktopSequences.push(desktop);
          nodes.push({ kind: 'desktop', sequence: number, displayName: it.scope });
        }
        desktop.events.push(it.event);
        continue;
      }
      if (it.t === 'event') {
        desktop = undefined;
        if (!current) {
          const continued = it.cardId !== undefined && this.cardsWithSequence.has(it.cardId);
          const number = ++this.numbered;
          current = { name: `${this.opts.name}-${number}`, number, events: [], ...(it.cardId !== undefined ? { card: it.cardId, continued } : {}) };
          this.sequences.push(current);
          if (it.cardId !== undefined) this.cardsWithSequence.add(it.cardId);
          nodes.push({ kind: 'browser', sequence: number, displayName: it.card });
          if (continued && it.event.kind !== 'goto' && it.url) {
            const goto: ImportEvent = { at: it.event.at, kind: 'goto', url: it.url };
            current.events.push(goto);
            this.add(it.event.at, 'converted', describeEvent(goto), 'these browser activities continue after a step that is not in the browser: each part runs in its own browser, so this one opens the address again');
          }
        }
        current.events.push(it.event);
        continue;
      }
      current = undefined;
      desktop = undefined;
      if (it.t === 'node') nodes.push(it.node);
      else if (it.t === 'if') nodes.push({ kind: 'if', expression: it.expression, then: this.finish(it.then), else: this.finish(it.else), displayName: it.displayName });
      else nodes.push({ kind: 'forEach', expression: it.expression, body: this.finish(it.body), displayName: it.displayName });
    }
    return nodes;
  }
}

/** A variable name the import's Variables map (exactly, else ignoring case when only one matches). */
function varKey(name: string, vars: Record<string, string> | undefined): string | undefined {
  if (!vars) return undefined;
  if (Object.hasOwn(vars, name)) return name;
  const hits = Object.keys(vars).filter((k) => k.toLowerCase() === name.toLowerCase());
  return hits.length === 1 ? hits[0] : undefined;
}

/** Text without UiPath's special-key tokens (`[k(enter)]`, `[d(ctrl)]`, `[u(ctrl)]`); `enter` when it ends by pressing Enter. One scan. */
function specialKeys(text: string): { text: string; enter: boolean } {
  if (!text.includes('[k(') && !text.includes('[d(') && !text.includes('[u(')) return { text, enter: false };
  let out = '';
  let enter = false;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '[' && (text.startsWith('[k(', i) || text.startsWith('[d(', i) || text.startsWith('[u(', i))) {
      const close = text.indexOf(')]', i + 3);
      if (close > 0 && close - i < 40) {
        const key = text.slice(i + 3, close).toLowerCase();
        enter = text[i + 1] === 'k' && (key === 'enter' || key === 'return') && close + 2 === text.length;
        i = close + 2;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return { text: out, enter };
}

/** A field whose selector or display name reads like a password, PIN or secret: what is typed there is never imported. */
const PASSWORD_FIELD = /pass(word|wort|code)?\b|passwd|pwd|\bpin\b|secret|kennwort|mot de passe/i;
/** A variable whose name reads like a password. */
const PASSWORD_NAME = /pass(word|wd)?|pwd|secret|\bpin\b/i;

/**
 * A Windows Save or Export dialog's file name field: automation id 1001 (the common file dialog's edit box) or the name
 * "File name:", in a dialog window (class #32770) or a window whose title says save or export, or with no window known.
 */
function isSaveField(t: UiaTarget): boolean {
  const last = t.path[t.path.length - 1];
  const field = last.automationId === '1001' || /^file ?name:?$/i.test(last.name ?? '');
  if (!field) return false;
  const w = t.window;
  return !w || w.className === '#32770' || /save|export|speichern|enregistrer/i.test(w.title ?? w.titlePattern ?? '') || (w.title === undefined && w.titlePattern === undefined);
}

/**
 * The file name a save-path expression ends in, when the import can split it: `folder + "\\file.csv"` (or `&`),
 * `Path.Combine(folder, "file.csv")`, with any folder expression before it. undefined when the file part is not a
 * string literal or names no file.
 */
function savePathFile(expr: string, csharp: boolean): string | undefined {
  const e = expr.trim();
  let lit: string | undefined;
  const combine = /^(?:System\.IO\.)?Path\.Combine\((.+),\s*(@?"(?:[^"\\]|""|\\.)*")\s*\)$/s.exec(e);
  if (combine) lit = stringLiteral(combine[2], csharp);
  else {
    const concat = /[+&]\s*(@?"(?:[^"\\]|""|\\.)*")\s*$/s.exec(e);
    if (concat && concat.index > 0) lit = stringLiteral(concat[1], csharp);
  }
  if (lit === undefined) return undefined;
  const file = lit.split(/[\\/]/).pop() ?? '';
  return file.trim() && !file.includes('{') ? file : undefined;
}

const KEY_NAMES: Record<string, string> = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', space: 'Space', back: 'Backspace', backspace: 'Backspace',
  del: 'Delete', delete: 'Delete', ins: 'Insert', insert: 'Insert', home: 'Home', end: 'End', pgup: 'PageUp', pageup: 'PageUp', prior: 'PageUp',
  pgdn: 'PageDown', pagedown: 'PageDown', next: 'PageDown', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
};

/**
 * A Send Hotkey's key and modifiers (`Key="enter" KeyModifiers="Ctrl, Shift"`) as the step format's canonical chord:
 * modifiers Ctrl, Alt, Shift in that order, then the key (`Ctrl+Shift+S`, `Enter`, `F5`). Win chords are refused.
 */
export function canonicalChord(key: string, modifiers: string): { chord: string } | { error: string } {
  const k = key.trim().toLowerCase();
  let name = KEY_NAMES[k];
  if (!name && /^f([1-9]|1[0-9]|2[0-4])$/.test(k)) name = k.toUpperCase();
  if (!name && /^[a-z0-9]$/.test(k)) name = k.toUpperCase();
  if (!name) return { error: `the key ${key.slice(0, 40) || '(none)'} is not one desktop steps can press (Enter, Tab, Escape, arrows, F1 to F24, letters and digits)` };
  const mods = new Set<string>();
  for (const m of modifiers.split(/[\s,+|]+/).map((x) => x.toLowerCase()).filter(Boolean)) {
    if (m === 'none') continue;
    if (m === 'ctrl' || m === 'control') mods.add('Ctrl');
    else if (m === 'alt') mods.add('Alt');
    else if (m === 'shift') mods.add('Shift');
    else if (m === 'win' || m === 'windows' || m === 'lwin' || m === 'rwin') return { error: 'a Windows-key shortcut drives the Windows shell, not the app: desktop steps never send one' };
    else return { error: `the modifier ${m.slice(0, 20)} is not one desktop steps know (Ctrl, Alt, Shift)` };
  }
  return { chord: [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), name].join('+') };
}
