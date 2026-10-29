// The neutral shapes every importer shares: a parser turns its source into events, stripSecrets removes every
// typed secret and folds the sign-in into one event, and buildDraft turns the events into a step document and a report.
import type { DownloadTemplate } from '../steps/file-check.js';
import type { DesktopScript, Locator, PortalSecrets, Script } from '../types.js';

export type ImportSource = 'chrome' | 'playwright' | 'uipath';
/** One way to find an element, as the source recorded it. A target lists them best first: the first is the primary locator. */
export type Candidate = Locator;
/** `at` says where in the source the event came from (a step number, a line, an activity), for the report. */
export type ImportEvent =
  | { at: string; kind: 'goto'; url: string }
  | { at: string; kind: 'click'; target: Candidate[]; label: string; download?: true; popup?: true }
  /** `secure`: the source marked the typed text secret (UiPath SecureText). `hints`: selector, name, id, aria and type text the source saw, for credential detection only; never copied into steps. */
  | { at: string; kind: 'fill' | 'select'; target: Candidate[]; label: string; value: string; secure?: true; hints: string[] }
  | { at: string; kind: 'check'; target: Candidate[]; label: string; checked: boolean }
  | { at: string; kind: 'enter'; label: string }
  | { at: string; kind: 'waitFor'; target: Candidate[]; label: string }
  | { at: string; kind: 'expectUrl'; path: string }
  | { at: string; kind: 'report'; item: ImportItem }
  /**
   * Built by stripSecrets only: the recorded username, password and submit (and code) fields, without anything typed.
   * `next`: the click that took an identity-first sign-in from the username page to the password page. Parsers never emit it.
   */
  | { at: string; kind: 'signIn'; username: Candidate[]; next?: Candidate[]; password: Candidate[]; submit: Candidate[]; totp?: { field: Candidate[]; submit: Candidate[] } };

/** `candidateWrite`: a desktop step that may save, post or submit; the owner decides at approval (it is never declared by the import). */
export interface ImportItem { at: string; kind: 'untranslated' | 'dropped' | 'converted' | 'secret' | 'error' | 'candidateWrite'; what: string; reason: string }
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
}
/** Version 1, unsigned, accepted by parseScript. */
export interface Draft { name: string; script: Script }
/**
 * A desktop draft (UiPath desktop sequences): version 1, unsigned, accepted by parseDesktopScript. Never replayed at
 * import; it goes to approval as written. `writeCandidates`: steps (1-based) that may write, for the owner to confirm.
 * `variables`: the run variables its steps type; `secretVariables`: those that hold a password or another secret.
 */
export interface DesktopDraft { name: string; script: DesktopScript; writeCandidates: number[]; variables: string[]; secretVariables: string[] }
/** `desktopDrafts`: UiPath desktop sequences, apart from the browser drafts (present only when there are any). */
export interface ImportResult { drafts: Draft[]; desktopDrafts?: DesktopDraft[]; report: ImportReport; flow?: UiPathFlow }

/** A UiPath workflow's shape outside the browser (the UiPath importer fills it). Literal attribute values only; expressions stay text. */
export interface UiPathFlow { name: string; nodes: FlowNode[] }
export type FlowNode =
  | { kind: 'browser'; sequence: number; displayName: string }
  /** A desktop sequence: the desktop draft `<name>-<sequence>`. Browser and desktop sequences share one numbering. */
  | { kind: 'desktop'; sequence: number; displayName: string }
  | { kind: 's3Upload'; bucket?: string; key?: string; displayName: string }
  | { kind: 'readSpreadsheet' | 'writeSpreadsheet'; path?: string; sheet?: string; displayName: string }
  | { kind: 'http'; method?: string; url?: string; displayName: string }
  | { kind: 'email'; to?: string; subject?: string; displayName: string }
  | { kind: 'wait'; seconds?: number; displayName: string }
  | { kind: 'if'; expression: string; then: FlowNode[]; else: FlowNode[]; displayName: string }
  | { kind: 'forEach'; expression: string; body: FlowNode[]; displayName: string }
  | { kind: 'credential'; asset: string; displayName: string }
  | { kind: 'untranslated'; activity: string; displayName: string; note: string };
