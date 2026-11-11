// The neutral shapes every importer shares: a parser turns its source into events, stripSecrets removes every
// typed secret and folds the sign-in into one event, and buildDraft turns the events into a step document and a report.
import type { DownloadTemplate } from '../steps/file-check.js';
import type { ClickModifier, DesktopScript, Locator, PortalSecrets, Script } from '../types.js';

/**
 * Where the steps come from: a Chrome recording, code, a UiPath project, a step document written by hand (`steps`), or
 * a desktop recording the RPA recorder saved (`recording`).
 */
export type ImportSource = 'chrome' | 'playwright' | 'uipath' | 'steps' | 'recording';
/** One way to find an element, as the source recorded it. A target lists them best first: the first is the primary locator. */
export type Candidate = Locator;
/**
 * The condition a source put around an event (a UiPath Check App State, or an If on an Element Exists): the step runs
 * only when the element shows (`visible`) or does not (`hidden`). The step's `when` is the first usable candidate.
 */
export type ImportWhen = { visible: Candidate[] } | { hidden: Candidate[] };
/** An event a condition may gate. */
interface Gated { when?: ImportWhen }
/** `at` says where in the source the event came from (a step number, a line, an activity), for the report. */
export type ImportEvent =
  | ({ at: string; kind: 'goto'; url: string } & Gated)
  /** `modifiers`: keys the source held down during the click (UiPath KeyModifiers). */
  | ({ at: string; kind: 'click'; target: Candidate[]; label: string; download?: true; popup?: true; modifiers?: ClickModifier[] } & Gated)
  | ({ at: string; kind: 'hover'; target: Candidate[]; label: string } & Gated)
  /** `secure`: the source marked the typed text secret (UiPath SecureText). `hints`: selector, name, id, aria and type text the source saw, for credential detection only; never copied into steps. */
  | ({ at: string; kind: 'fill'; target: Candidate[]; label: string; value: string; secure?: true; hints: string[] } & Gated)
  /** `value` as an array: a multi-select, exactly these options (the step's select with an array value). */
  | ({ at: string; kind: 'select'; target: Candidate[]; label: string; value: string | string[]; secure?: true; hints: string[] } & Gated)
  | ({ at: string; kind: 'check'; target: Candidate[]; label: string; checked: boolean } & Gated)
  | { at: string; kind: 'enter'; label: string }
  /**
   * One key chord a browser `press` step accepts (steps/browser-keys.ts), in its spelling (`Shift+Tab`). An empty
   * `target`: the element that has the focus. Enter alone is never one: it is `enter`, which a sign-in takes as its submit.
   */
  | ({ at: string; kind: 'press'; key: string; target: Candidate[]; label: string } & Gated)
  | ({ at: string; kind: 'waitFor'; target: Candidate[]; label: string } & Gated)
  | { at: string; kind: 'expectUrl'; path: string }
  | { at: string; kind: 'report'; item: ImportItem }
  /**
   * Built by stripSecrets only: the recorded username, password and submit (and code) fields, without anything typed.
   * `next`: the click that took an identity-first sign-in from the username page to the password page. Parsers never emit it.
   */
  | { at: string; kind: 'signIn'; username: Candidate[]; next?: Candidate[]; password: Candidate[]; submit: Candidate[]; totp?: { field: Candidate[]; submit: Candidate[] } };

/**
 * `candidateWrite`: a desktop step that may save, post or submit; the owner decides at approval (it is never declared by
 * the import). `notNeeded`: a `dropped` step whose absence changes nothing the bot does on the site (a viewport change,
 * a wait or check the steps do by themselves, a click into a field before typing, logging); the approval does not list
 * it as left out. Every other dropped step, and every untranslated one, is listed.
 */
export interface ImportItem {
  at: string; kind: 'untranslated' | 'dropped' | 'converted' | 'secret' | 'error' | 'candidateWrite'; what: string; reason: string; notNeeded?: true;
}
export interface ImportReport { source: ImportSource; steps: number; items: ImportItem[] }
export interface ImportOptions {
  name: string;
  startUrl?: string;
  vars?: Record<string, string>;
  /** The node's Expected File: with it, the export click becomes a checked download. */
  download?: DownloadTemplate;
  idPattern?: string;
  /** The attached Site Login's secrets: typed values equal to one are stripped wherever they appear. */
  secrets?: PortalSecrets;
  hasSiteLogin: boolean;
  /** Import Steps → Options → One-Time Code Workflow is set: a recorded code becomes the sign-in's totp with source 'workflow'. */
  codeFromWorkflow?: boolean;
}
/** Version 1, unsigned, accepted by parseScript. */
export interface Draft { name: string; script: Script }
/**
 * A desktop draft (a UiPath desktop sequence, a desktop step document or a desktop recording): version 1, unsigned,
 * accepted by parseDesktopScript. Never replayed at import; it goes to approval as written. `writeCandidates`: steps
 * (1-based) that may write, for the owner to confirm.
 * `variables`: the run variables its steps type; `secretVariables`: those that hold a password or another secret;
 * `startValues` (a recording): the value recorded for a variable that is not secret, for the generated workflow.
 */
export interface DesktopDraft {
  name: string; script: DesktopScript; writeCandidates: number[]; variables: string[]; secretVariables: string[]; startValues?: Record<string, string>;
}
/**
 * `desktopDrafts`: UiPath desktop sequences, a desktop step document or a desktop recording, apart from the browser
 * drafts (only when there are any). `flow`: the workflow around the drafts, for a UiPath project and for a desktop
 * recording (one desktop node, sequence 1, whose draft is `<name>`, the recording's one step list).
 */
export interface ImportResult { drafts: Draft[]; desktopDrafts?: DesktopDraft[]; report: ImportReport; flow?: UiPathFlow }

/**
 * A UiPath workflow's shape outside the browser (the UiPath importer fills it; a desktop recording gives one desktop
 * node). Literal attribute values only; expressions stay text.
 */
export interface UiPathFlow { name: string; nodes: FlowNode[] }
export type FlowNode =
  /** A browser sequence: the draft `draft` when given (a source without a flow of its own), else `<name>-<sequence>`. */
  | { kind: 'browser'; sequence: number; displayName: string; draft?: string }
  /** A desktop sequence: the desktop draft `draft` when given (a recording), else `<name>-<sequence>`. Browser and desktop sequences share one numbering. */
  | { kind: 'desktop'; sequence: number; displayName: string; draft?: string }
  | { kind: 's3Upload'; bucket?: string; key?: string; displayName: string }
  | { kind: 'readSpreadsheet' | 'writeSpreadsheet'; path?: string; sheet?: string; displayName: string }
  | { kind: 'http'; method?: string; url?: string; displayName: string }
  | { kind: 'email'; to?: string; subject?: string; displayName: string }
  | { kind: 'wait'; seconds?: number; displayName: string }
  | { kind: 'if'; expression: string; then: FlowNode[]; else: FlowNode[]; displayName: string }
  | { kind: 'forEach'; expression: string; body: FlowNode[]; displayName: string }
  | { kind: 'credential'; asset: string; displayName: string }
  | { kind: 'untranslated'; activity: string; displayName: string; note: string };
