// Shared types for the engine. Every module imports from here.

export interface LocatorCommon {
  /** Scope the match inside another element (e.g. the navigation landmark). */
  within?: Locator;
  /** CSS selector of an iframe to search inside. */
  frame?: string;
  /** Tried in order when the primary candidate has no unique visible match. Each fallback is a complete locator: it does not inherit this locator's within/frame. */
  fallbacks?: Locator[];
}
export type Locator =
  | (LocatorCommon & { role: string; name?: string; exact?: boolean })
  | (LocatorCommon & { label: string; exact?: boolean })
  | (LocatorCommon & { text: string; exact?: boolean })
  | (LocatorCommon & { testId: string })
  | (LocatorCommon & { css: string });

export interface Expect {
  url?: string;
  heading?: string;
  visible?: Locator;
}

export interface StepBase {
  intent: string;
  optional?: boolean;
  when?: { visible: Locator };
  expect?: Expect;
  checkpoint?: boolean;
  timeoutMs?: number;
}

export type FieldAttribute = 'text' | 'href' | 'src' | 'title' | 'alt' | 'aria-label';
export interface FieldSpec {
  locator?: Locator;
  pattern?: string;
  /** What to read from the element the locator finds inside the item (default text). href/src become absolute URLs. */
  attribute?: FieldAttribute;
}
export interface ExtractSpec {
  scope: Locator;
  /** Required when there is no idPattern: each match is one row. */
  item?: Locator;
  fields?: Record<string, FieldSpec>;
  /** Optional: when set, rows need an ID matching it, are de-duplicated by ID and carry `id`. */
  idPattern?: string;
  textMode?: 'text' | 'textContent';
}
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';
export interface SignInSpec {
  username: Locator;
  /**
   * A two-page (identity-first) sign-in: the button that moves from the username page to the password page. The
   * password field is looked up only after it is clicked, and every login-page check is re-run on the second page.
   */
  next?: Locator;
  password: Locator;
  submit: Locator;
  totp?: {
    field: Locator;
    submit: Locator;
    /**
     * Where the code comes from. 'seed' (default): generated from the Site Login's TOTP secret. 'workflow': asked of the
     * run's codeProvider (in n8n, a sub-workflow) once the code field shows; no TOTP secret is needed.
     */
    source?: 'seed' | 'workflow';
  };
}

/** What a run tells the code provider when it asks for a one-time code. */
export interface CodeRequest {
  /** When the code field showed and the code was asked for (ISO 8601). */
  requestedAt: string;
}
/**
 * Supplies the one-time code for a signIn whose totp.source is 'workflow'. Resolves to 6 to 10 digits (spaces allowed,
 * they are removed). Its error message is shown in the run's failure, so it must never contain the code.
 */
export type CodeProvider = (req: CodeRequest) => Promise<string>;
/** How long a run waits for the code provider by default. */
export const DEFAULT_CODE_TIMEOUT_MS = 120_000;
export interface SubmitTarget {
  path: string;
  host?: string;
  method?: string;
}

export type Step = StepBase &
  (
    | { goto: string; waitUntil?: WaitUntil }
    | { signIn: SignInSpec }
    | { click: Locator }
    | { fill: { field: Locator; value: string } }
    | { select: { field: Locator; value: string } }
    | { check: { field: Locator; checked?: boolean } }
    | { clickAll: { target: Locator; max: number } }
    | {
        waitFor: {
          target?: Locator;
          state?: 'visible' | 'hidden' | 'attached';
          hasText?: string;
          minCount?: number;
          response?: { urlContains: string };
        };
      }
    | { paginate: { next: Locator; until: 'absent' | 'disabled'; max: number; nextWaitMs?: number; each: Step[] } }
    | { extract: ExtractSpec }
    | { submit: SubmitTarget & { button: Locator } }
    | { download: { trigger: Locator; via?: SubmitTarget; maxBytes?: number; mime?: string[]; check?: FileCheck } }
    | { popup: { trigger: Locator } }
    | { detect: { name: string; checks: Record<string, Locator>; require?: string } }
    | { screenshot: { capture: 'full' | 'viewport' | 'element'; element?: Locator } }
    | { pdf: { paper?: 'A4' | 'Letter'; background?: boolean } }
    | { read: { what: 'text' | 'html' | 'title' | 'url' } }
    | { extractTable: { table: Locator; idPattern?: string } }
  );

export const STEP_VERBS = [
  'goto', 'signIn', 'click', 'fill', 'select', 'check', 'clickAll', 'waitFor',
  'paginate', 'extract', 'submit', 'download', 'popup', 'detect',
  'screenshot', 'pdf', 'read', 'extractTable',
] as const;
export type StepVerb = (typeof STEP_VERBS)[number];

export interface Interrupt {
  target: Locator;
  click: Locator;
}
export interface Script {
  /** Absent or "browser": a desktop step set is a DesktopScript, which parseScript refuses. */
  surface?: 'browser';
  name?: string;
  version?: number;
  /** Always set after parseScript: the document's startUrl, else its first absolute goto, else the default. */
  startUrl: string;
  interrupts?: Interrupt[];
  steps: Step[];
}

/** Security configuration: from the Site Login credential, or derived from the URL by the node's policyFor. */
export interface PortalPolicy {
  startUrl: string;
  navHosts: string[];
  /** Hosts sub-resources may load from, or '*' for any http(s) host: reads only, never private addresses, ignored in Local Browser mode. */
  subresourceHosts: string[] | '*';
  /** Hosts that sub-frames (iframes) may load from and talk to, e.g. a CAPTCHA widget. Never navigation or goto targets. */
  frameHosts?: string[];
  login: { host: string; path: string }[];
  /** Forms the steps may post: each passes only while the submit or download step that declares it runs (Session.armSubmit). */
  allowedSubmits: { host: string; path: string; method: string }[];
  /** POSTs that only read (Site Login 'Requests That Only Read'): admitted in every run, never counted as writes; `*` in `path` matches within one segment. */
  readPosts?: { host: string; path: string }[];
  /** Sub-frame writes between frame hosts (e.g. a CAPTCHA widget). Default true; false (noWritePolicy) leaves only declared login POSTs. */
  frameHostWrites?: boolean;
  /** 'fatal' (default): a disallowed write ends the run. 'block': sub-resource writes are aborted and logged in blockedRequests. */
  writeMode?: 'fatal' | 'block';
  /** Admit private addresses (loopback, RFC 1918, …) for navigation hosts only. Default false. */
  allowPrivateNetwork?: boolean;
  /**
   * Fill and Submit only: while the click at top-level step `step` runs, up to `maxPosts` (3) main-frame POST requests to
   * `hosts` pass the write rules. Never present in agent or prove sessions (noWritePolicy drops it).
   */
  writeWindow?: { step: number; maxPosts: 3; hosts: string[] };
  /** Run Steps without a Site Login: declared submit / download.via targets on a navigation host become allowedSubmits (effectivePolicy). */
  submitsFromSteps?: boolean;
  /**
   * Agent and prove sessions only (noWritePolicy): a main-frame navigation whose decoded path or query names a
   * destructive action (policy/destructive.ts) is a fatal violation. The start URL and the login pages are exempt.
   */
  refuseDestructiveNavigation?: boolean;
}
/** A blocked or allowed write, as reported to the user. Host and path are masked; no query string. */
export interface RequestRecord {
  method: string;
  host: string;
  path: string;
}
export interface PortalSecrets {
  username: string;
  password: string;
  totpSecret?: string;
}

/** Row checks, run only after an extract step. Each check runs only when configured. */
export interface OutputSpec {
  idPattern?: string;
  requiredFields?: string[];
  totalPattern?: string;
  /** Case-insensitive regex for the page's own "nothing here" text. Zero rows pass only when evidence matches it. */
  emptyPattern?: string;
}

/** One extracted row. `id` is present only when an ID Pattern is set. */
export type Row = Record<string, string>;
export const MAX_ROWS = 10_000;
/** The page a run ended on: final URL (masked, query kept), title (masked) and the main document's HTTP status. */
export interface PageInfo {
  url: string;
  title: string;
  status: number | null;
}
export interface Evidence {
  url: string;
  text: string;
}
/** What a download step requires of the file it receives; a miss is drift. Part of the signed step document. */
export interface FileCheck { name?: string; minBytes?: number; columns?: string[]; minRows?: number }
/** Header columns and data-row count read from a file; null where the type has none. */
export interface FileFacts { columns: string[] | null; rows: number | null }

export interface DownloadedFile {
  fileName: string;
  mimeType: string;
  data: Buffer;
  /** Binary property name for the node: file_<topLevelStepIndex>, file_<i>_2 for a repeat (paginate). */
  binaryName: string;
  /** Read from the file when the step declared a check. Header text is masked. */
  facts?: FileFacts;
}
/** What a screenshot, pdf or read step produced. Strings are masked; text/html are capped at MAX_TEXT_BYTES. */
export interface StepOutput {
  index: number;
  verb: 'screenshot' | 'pdf' | 'read';
  /** A desktop read step's `as`: the name its text goes by in the run outputs. Absent for browser steps. */
  as?: string;
  binary?: { name: string; fileName: string; mimeType: string; data: Buffer };
  text?: string;
  html?: string;
  title?: string;
  url?: string;
  truncated?: boolean;
}
export interface StepLogEntry {
  index: number;
  intent: string;
  status: 'ok' | 'skipped' | 'failed';
  ms: number;
  candidate?: number;
  note?: string;
  /** What the step produced: read values, or the binary name (the Buffer lives only in RunState.outputs / downloads). */
  output?: { text?: string; html?: string; title?: string; url?: string; binary?: string; truncated?: boolean };
}
export interface StepFailure {
  index: number;
  intent: string;
  message: string;
}
/**
 * Mutable state of one run, shared by all steps. `detected` maps detect-step names to the check that matched;
 * `lastCheckpoint` is the index of the last top-level checkpoint step that passed (-1 if none);
 * `credentialsSubmitted` becomes true when signIn starts typing credentials (one submission per run);
 * `submitClicked` becomes true once signIn has clicked the submit button (a failure before that is not a rejected login);
 * a two-page signIn's `next` click does not set it, since the password has not been submitted yet.
 */
export interface RunState {
  rows: Row[];
  evidence: Evidence[];
  downloads: DownloadedFile[];
  outputs: StepOutput[];
  detected: Record<string, string>;
  lastCheckpoint: number;
  log: StepLogEntry[];
  credentialsSubmitted: boolean;
  submitClicked: boolean;
  /** True once an extract (or extractTable) step ran: only then are rows verified. */
  extractRan: boolean;
  /** Field names read from an attribute (href, src, title, alt, aria-label): DOM values, never in the text evidence. */
  attributeFields: string[];
  /** True once a write left the browser: a window POST, a submit click or a download through a form. */
  submitted: boolean;
  /**
   * Set when the top-level download step `index` clicked its trigger (no `via`) but no download came: the click still
   * happened (it may have opened a format dialog). A repair that resumes from that step replays the click (compile
   * keepTriggerClick). Cleared when the next top-level step starts and when a download arrives.
   */
  clickedTrigger?: { index: number };
}
export type StepsResult =
  | { ok: true; state: RunState }
  | { ok: false; state: RunState; failure: StepFailure };

/** fatal=true violations end the run as policy_violation; non-fatal ones were blocked and logged. */
export interface Violation {
  kind: 'host' | 'write' | 'websocket' | 'signin' | 'private' | 'secret';
  url: string;
  /** The host the violation is about (private-address and off-list violations). */
  host?: string;
  method?: string;
  fatal: boolean;
}

export type ErrorCode =
  | 'login_failed' | 'account_locked' | 'auth_blocked' | 'site_down' | 'browser_unavailable'
  | 'drift_detected' | 'not_found' | 'incomplete' | 'script_untrusted' | 'policy_violation'
  | 'locked_out' | 'busy'
  /** Desktop runs: the desktop runner could not be reached, refused the token or certificate, or its desktop is locked or signed out. */
  | 'runner_unavailable';

export interface BrowserEndpoint {
  mode: 'local' | 'playwright' | 'cdp';
  wsUrl?: string;
  token?: string;
  headless?: boolean;
  /** Private Network Endpoint: allow plain ws:// to a private-network host, only together with a token. */
  privateNetwork?: boolean;
  /** Slow Motion: milliseconds Playwright waits before each browser action, to watch a run in a live view. 0 or absent: off. */
  slowMo?: number;
  /**
   * Browser Server mode only: how long to wait for a free session while the browser service's gate answers 503 busy or
   * draining, in milliseconds. Absent: SESSION_WAIT_MS (60 s). 0: fail at the first refusal. The run budget caps it.
   */
  sessionWaitMs?: number;
}

// Desktop step sets (`surface: "desktop"`): they drive a Windows app through the desktop runner (desktop/), never a browser.

/** Which window a target is in. Every given field must match; `exe` is the file name, case-insensitive. */
export interface WindowSel { exe?: string; title?: string; titlePattern?: string; automationId?: string; className?: string }
/** One UI Automation condition. `index` picks among siblings that match the rest (0-based). */
export interface UiaCond { controlType?: string; automationId?: string; name?: string; className?: string; index?: number }
/** A UI Automation target: `path` is matched as descendants in order, each condition below the previous match. */
export interface UiaTarget { window?: WindowSel; path: UiaCond[] }
/** A desktop locator: a primary UI Automation target and up to five fallbacks, tried in order like a browser locator's. */
export interface DesktopLocator { uia: UiaTarget; fallbacks?: { uia: UiaTarget }[] }
/** The app a desktop step set launches. */
export interface DesktopApp { exe: string; args?: string[] }

export interface DesktopStepBase {
  intent: string;
  optional?: boolean;
  when?: { visible: DesktopLocator };
  expect?: { visible?: DesktopLocator };
  checkpoint?: boolean;
  timeoutMs?: number;
  /**
   * The owner declares this step a write (signed with the steps): the runner then accepts it on a declared write
   * control or a gated key. Only on click, fill, select, check and key.
   */
  write?: boolean;
}
export type DesktopStep = DesktopStepBase &
  (
    | { click: DesktopLocator }
    /** `value` may hold {{$exportDir}}, the run's export directory, filled in by the runner. */
    | { fill: { field: DesktopLocator; value: string } }
    | { select: { field: DesktopLocator; option: string } }
    | { check: { field: DesktopLocator; checked?: boolean } }
    | { waitFor: { target: DesktopLocator; state?: 'visible' | 'hidden' } }
    | { read: { target: DesktopLocator; as: string } }
    | { key: { key: string; target?: DesktopLocator } }
    | { expectFile: { pattern: string; check?: FileCheck; maxBytes?: number; mime?: string[] } }
  );

export const DESKTOP_VERBS = ['click', 'fill', 'select', 'check', 'waitFor', 'read', 'key', 'expectFile'] as const;
export type DesktopVerb = (typeof DESKTOP_VERBS)[number];

export interface DesktopScript {
  surface: 'desktop';
  name?: string;
  version?: number;
  app: DesktopApp;
  steps: DesktopStep[];
}
