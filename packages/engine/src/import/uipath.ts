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
import type { Candidate, Draft, FlowNode, ImportEvent, ImportItem, ImportOptions, ImportReport, ImportResult, UiPathFlow } from './types.js';
import { readSelector } from './uipath-selector.js';
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
  const empty = () => ({ sequences: [], flow: { name: cleanLabel(opts.name), nodes: [] } });
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
  const { sequences, flow } = uipathImport(data, opts, report);
  const drafts: Draft[] = [];
  const typedSecrets: string[] = [];
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
      const draft = buildDraft(kept, seqOpts, report, `${opts.name}-${i + 1}`);
      if (draft) drafts.push(draft);
      else missing.add(i + 1);
    });
  } else if (flow.nodes.length) {
    report.items.push({ at: '', kind: 'untranslated', what: 'Browser steps', reason: 'the project has no browser activities, so there are no steps to adopt: only the workflow around them' });
  } else if (!report.items.some((i) => i.kind === 'error')) {
    report.items.push({ at: '', kind: 'error', what: WHAT, reason: IMPORT_EMPTY });
  }

  // A sequence that built no draft is shown in the flow as untranslated, so the workflow never names a missing draft.
  const mark = (nodes: FlowNode[]): FlowNode[] => nodes.map((n) => {
    if (n.kind === 'browser' && missing.has(n.sequence)) return { kind: 'untranslated', activity: 'Browser steps', displayName: n.displayName, note: 'no step could be built from these browser activities: see the report' };
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
  return { drafts, report, ...(finalFlow.nodes.length ? { flow: finalFlow } : {}) };
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

/** A browser sequence: its events, and the card it belongs to; `continued` when an earlier sequence used the same card. */
export interface UiPathSequence { name: string; events: ImportEvent[]; card?: number; continued?: boolean }

class Walker {
  private visited = 0;
  private work = 0;
  private cards = 0;
  private readonly parsed = new Map<string, Parsed | null>();
  private readonly selectors = new Map<string, ReturnType<typeof readSelector>>();
  private readonly cardsWithSequence = new Set<number>();
  private readonly desktop: ImportItem[] = [];
  private readonly sequences: UiPathSequence[] = [];
  private readonly xmlns: Map<string, string>[] = [];
  /** The variables TOTP activities write their code to, lower case. */
  private readonly totpOutputs = new Set<string>();

  constructor(private readonly project: Project, private readonly opts: ImportOptions, private readonly report: ImportReport) {}

  run(): { sequences: UiPathSequence[]; flow: UiPathFlow } {
    const main = this.project.files.get(this.project.main!)!;
    const parsed = this.parse(this.project.main!);
    const name = cleanLabel(this.project.name ?? '') || (parsed ? cleanLabel(parsed.root.attrs['x:Class'] ?? '') : '') || cleanLabel(this.opts.name);
    if (!parsed) return { sequences: [], flow: { name, nodes: [] } };
    const ctx: Ctx = { file: main.path, stack: [this.project.main!], chain: [main.path], nesting: 0, desktop: false, aws: false, names: parsed.names, csharp: this.project.csharp };
    const items = this.workflow(this.project.main!, parsed, ctx);
    const nodes = this.finish(items);
    if (this.desktop.length) {
      this.report.items.push({ at: '', kind: 'untranslated', what: `SAP desktop activities (${this.desktop.length})`, reason: DESKTOP_HEADING_REASON });
      this.desktop.forEach((d, i) => this.report.items.push({ ...d, what: `${i + 1}. ${d.what}` }));
    }
    return { sequences: this.sequences, flow: { name, nodes } };
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
        this.add(at, 'converted', displayName, 'a UiPath credential is never imported: attach an RPA Site Login to the Run steps node instead');
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
        if (ctx.card && !ctx.desktop) {
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
    for (const it of items) {
      if (it.t === 'event') {
        if (!current) {
          const continued = it.cardId !== undefined && this.cardsWithSequence.has(it.cardId);
          current = { name: `${this.opts.name}-${this.sequences.length + 1}`, events: [], ...(it.cardId !== undefined ? { card: it.cardId, continued } : {}) };
          this.sequences.push(current);
          if (it.cardId !== undefined) this.cardsWithSequence.add(it.cardId);
          nodes.push({ kind: 'browser', sequence: this.sequences.length, displayName: it.card });
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
