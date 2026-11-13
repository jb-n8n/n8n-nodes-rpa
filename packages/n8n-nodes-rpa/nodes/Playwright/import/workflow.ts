// The workflow around an import's steps, delivered as JSON for n8n's "Import from file": a UiPath project's flow, an RPA
// recording's one desktop node, or, for the other sources, one browser or desktop pair per step list. It starts with a
// manual trigger and a Schedule Trigger that is switched off (set the time, then publish).
// Each browser sequence n becomes Get active steps (playwright_steps, name <name>-n) feeding Run steps with signed steps
// required and AI Repair off, so the workflow runs as generated: no Chat model credential and no approval workflow to
// pick first; the Run steps note says how to add self-repair. Each desktop sequence n becomes Get active steps feeding a Run steps on
// the RPA Desktop Runner credential, with signed steps required, AI Repair off (desktop steps
// have none yet) and the variables its steps type, empty for the user to fill in (secrets from a secret source). Everything else follows a fixed table of n8n 2.41 node types. Text from the project is
// never evaluated: it goes into literal parameters only when n8n cannot read it as an expression, and otherwise into
// notes and stickies as text. The RPA credentials the import was given are attached by id and name (opts.credentials),
// so the file needs nothing picked; without them the desktop runner is named by name only. No secret is ever written.
import type { DesktopDraft, Draft, FlowNode, UiPathFlow } from 'n8n-rpa-engine';
import { CREDENTIALS } from '../config.js';
import { RPA_NODE_TYPE } from '../node-type.js';
import { RUN_TABLE, RUN_TABLE_COLUMNS, STEPS_TABLE, STEPS_TABLE_COLUMNS } from '../rows.js';

export interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  notes?: string;
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  /** Switched off: n8n skips it (the Schedule Trigger, until a person sets the time). */
  disabled?: boolean;
  /** Run steps: its failures leave on an error output (to the run log); the log write: a failure passes the item on. */
  onError?: 'continueErrorOutput' | 'continueRegularOutput';
  /**
   * Credentials by type, in n8n's own form: the id and display name of one the import was given, or the name alone (id
   * null: n8n selects it when exactly one credential has that name). Never a secret.
   */
  credentials?: Record<string, CredentialRef | { id: null; name: string }>;
}
/** A credential by id and display name, as n8n writes it on a node: never a value of it. */
export interface CredentialRef { id: string; name: string }
export interface WorkflowConnection { node: string; type: 'main'; index: number }
export interface WorkflowJson {
  name: string;
  description: string;
  nodes: WorkflowNode[];
  connections: Record<string, { main?: WorkflowConnection[][] }>;
  settings: { executionOrder: 'v1' };
  pinData: Record<string, never>;
}
export interface BuildWorkflowOptions {
  /** The import's Name: draft n is named `<name>-n`. Used as a literal, so it must not start with "=". */
  name: string;
  /** The import's desktop drafts (ImportResult.desktopDrafts), named like the browser drafts. */
  desktopDrafts?: DesktopDraft[];
  /** The import's One-Time Code Workflow: each browser Run steps takes its code from it too. */
  codeWorkflow?: { id: string; timeoutSeconds: number };
  /**
   * The import's run options that the steps were proven with: Max Seconds (when not the default), Also Allow These Sites,
   * Allow Private Network (only when the import had it on, a literal true: Import Steps refuses an expression there) and
   * each browser step list's ID Pattern, by its name (typed, when n8n cannot read it as an expression).
   */
  run?: { maxSeconds?: number; allowedHosts?: string[]; allowPrivateNetwork?: boolean; idPatterns?: ReadonlyMap<string, string> };
  /** Where the flow came from. Only the texts that name it differ. */
  source?: ImportedFrom;
  /**
   * The RPA credentials the import was given (Import Steps' own slots), by id and name: browser Run steps get the
   * Browser, the Site Login and the Step Signing; desktop Run steps get the Desktop Runner and the Step Signing.
   */
  credentials?: PassedOn;
}
/** The credentials an import passes on to the workflow file. */
export interface PassedOn { browser?: CredentialRef; siteLogin?: CredentialRef; signing?: CredentialRef; desktopRunner?: CredentialRef }
export type ImportedFrom = 'uipath' | 'recording' | 'chrome' | 'playwright' | 'steps';
/** How the generated texts name where the steps came from. */
const FROM = {
  uipath: { steps: 'imported from UiPath', importIt: 'import the project', workflow: 'imported from UiPath', origin: 'the UiPath project', startValues: "the values the UiPath project gave them" },
  recording: { steps: 'imported from the recording', importIt: 'import the recording', workflow: 'imported from a recording', origin: 'the recording', startValues: 'the values that were recorded' },
  chrome: { steps: 'imported from the Chrome recording', importIt: 'import the recording', workflow: 'imported from a Chrome recording', origin: 'the Chrome recording', startValues: 'the values that were recorded' },
  playwright: { steps: 'imported from the Playwright code', importIt: 'import the code', workflow: 'imported from Playwright code', origin: 'the Playwright code', startValues: 'the values the code gave them' },
  steps: { steps: 'from the step document', importIt: 'import the step document', workflow: 'imported from a step document', origin: 'the step document', startValues: 'the values the step document gave them' },
} as const;
/** The default Max Seconds of Run Steps: a run option equal to it is not written. */
const DEFAULT_MAX_SECONDS = 180;
/** The credential type a run's secret variables come from. */
const SECRET_VARIABLES = '**RPA Secret Variables**';
/** The browser Run steps' note on Allow Private Network: off (the default), or on because the import had it on. */
export const PRIVATE_NETWORK_OFF = 'For a site on your own network, turn on Options → Allow Private Network here.';
export const PRIVATE_NETWORK_ON = 'Options → Allow Private Network is on because the import had it on: the steps may open addresses on your own network.';
/** Where the steps get approved by default. */
const IMPORT_FORM = 'RPA: 5 Import a bot';

/** The display name of each RPA credential a Run steps uses, as the node shows it. */
const LABEL = { browser: 'RPA Browser', siteLogin: 'RPA Site Login', signing: 'RPA Step Signing', desktopRunner: 'RPA Desktop Runner' } as const;
type Slot = keyof typeof LABEL;
/** The slots a browser Run steps uses, and a desktop one. */
const BROWSER_SLOTS: Slot[] = ['browser', 'siteLogin', 'signing'];
const DESKTOP_SLOTS: Slot[] = ['desktopRunner', 'signing'];
/** Without the import's own, a desktop Run steps names the RPA Desktop Runner by name: n8n selects it when one has that name. */
const DESKTOP_RUNNER_BY_NAME = { id: null, name: LABEL.desktopRunner } as const;
/** "A", "A and B", "A, B and C". */
const and = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
/**
 * Only a well-formed reference is passed on: an id and a name that are non-empty strings of a sane length. Anything else
 * is left for the person to pick.
 */
function cleanRef(ref: CredentialRef | undefined): CredentialRef | undefined {
  if (!ref || typeof ref.id !== 'string' || typeof ref.name !== 'string') return undefined;
  const id = ref.id.trim();
  const name = line(ref.name, 200);
  return id && id.length <= 64 && name ? { id, name } : undefined;
}

/** Node types and the versions used, each checked against n8n's nodes-base (and nodes-langchain) at tag n8n@2.41.0. */
const T = {
  manualTrigger: ['n8n-nodes-base.manualTrigger', 1],
  scheduleTrigger: ['n8n-nodes-base.scheduleTrigger', 1.2],
  sticky: ['n8n-nodes-base.stickyNote', 1],
  dataTable: ['n8n-nodes-base.dataTable', 1.1],
  rpa: [RPA_NODE_TYPE, 1],
  awsS3: ['n8n-nodes-base.awsS3', 2],
  extractFromFile: ['n8n-nodes-base.extractFromFile', 1.1],
  convertToFile: ['n8n-nodes-base.convertToFile', 1.1],
  httpRequest: ['n8n-nodes-base.httpRequest', 4.2],
  emailSend: ['n8n-nodes-base.emailSend', 2.1],
  wait: ['n8n-nodes-base.wait', 1.1],
  if: ['n8n-nodes-base.if', 2.2],
  stopAndError: ['n8n-nodes-base.stopAndError', 1],
  set: ['n8n-nodes-base.set', 3.4],
} as const satisfies Record<string, readonly [string, number]>;

const COLOUR = { green: 4, gold: 2, grey: 7 } as const;
/** Horizontal distance between columns, and the vertical distance of an If branch per level of nesting below it. */
const STEP = 240;
const BRANCH = 200;
const HTTP_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const MAX_NAME = 95;
const APPROVE_WORKFLOW = 'RPA: 3 Approve steps';
/** The nodes one browser pair draws: Get active steps and Run steps. */
const PAIR_NODES = 2;
/** The nodes one desktop pair draws: Get active steps, Run steps and the variables sticky. */
const DESKTOP_PAIR_NODES = 3;
/**
 * The flow is drawn until the workflow has this many nodes; every activity after that is counted into one grey sticky
 * pointing at the report. A project of 190,000 activities would otherwise give a workflow file of hundreds of MiB.
 */
export const MAX_WORKFLOW_NODES = 500;

/** One line: control characters become spaces, runs of space collapse, and long text is cut with an ellipsis. */
function line(s: string | undefined, max = 300): string {
  const one = (s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
/** Text for sticky markdown: characters that could make links, images, HTML, headings or emphasis are escaped. */
const md = (s: string | undefined, max = 300) => line(s, max).replace(/[\\`*_[\]<>#|~!&]/g, '\\$&');
/** Text as an inline code span, with a fence longer than any run of backticks inside it. */
function code(s: string | undefined, max = 300): string {
  const text = line(s, max);
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
/**
 * A node name as a JavaScript string inside an n8n expression: every character but letters, digits, spaces and
 * `_ . , : ( ) -` is written as a \u escape, so a quote, a backslash, a "$" or a "}}" in a name taken from the project
 * cannot end the string or the expression. An ordinary name stays as it is, so n8n's rename updates the reference.
 */
export const jsName = (name: string): string => `'${name.replace(/[^A-Za-z0-9 _.,:()-]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}'`;
/**
 * What a Run steps reads from its Get active steps row, by that node's name and not from its own input item: a node put
 * between the two (the accounts of a many-accounts bot, a spreadsheet's rows) changes the input, never the row.
 */
export const fromRow = (get: string, field: 'steps' | 'signature' | 'approvedBy' | 'version'): string =>
  field === 'steps' ? `={{ $(${jsName(get)}).first().json.steps ?? '' }}` : `={{ $(${jsName(get)}).first().json.${field} }}`;
/** A literal parameter value, unless it could be or become an expression (a leading "=", or "{{" anywhere): then none. */
const literal = (v: string | undefined): string | undefined => (v !== undefined && v !== '' && !v.startsWith('=') && !v.includes('{{') ? v : undefined);
/** A variable's name as the steps can state it ({{var.name}}). */
const PLAIN_NAME = /^[A-Za-z0-9_]+$/;
const basename = (path: string) => path.split(/[\\/]/).pop() ?? '';
/** Says why a literal from the project is not in the parameter, for the node's notes. */
function missing(what: string, v: string | undefined): string {
  if (v === undefined || v === '') return `${what}: UiPath set it with an expression, so set it here.`;
  return `${what}: UiPath's value looks like an n8n expression (a leading "=" or "{{"), so it is not used. It was: ${line(v, 500)}`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The flow nodes an If or For Each holds directly. */
const children = (n: FlowNode): FlowNode[][] => (n.kind === 'if' ? [n.then, n.else] : n.kind === 'forEach' ? [n.body] : []);
/** Activities in a flow node, the ones nested in it included. Iterative: a branch may hold a great many. */
function size(node: FlowNode): number {
  let count = 0;
  const stack: FlowNode[] = [node];
  for (let n = stack.pop(); n; n = stack.pop()) {
    count += 1;
    for (const list of children(n)) for (const c of list) stack.push(c);
  }
  return count;
}
/** The draft a browser or desktop flow node runs: its own `draft`, else `<name>-<sequence>`. */
const draftOf = (prefix: string, n: { sequence: number; draft?: string }): string => n.draft ?? `${prefix}-${n.sequence}`;
/** The run variables steps name ({{var.name}}), in order, and those a secret fill or a password change types. */
function stepVariables(steps: unknown): { all: string[]; secret: string[] } {
  const all = [...new Set([...JSON.stringify(steps ?? null).matchAll(/\{\{\s*var\.([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
  const secret = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    const fill = o.fill as { secret?: unknown; value?: unknown } | undefined;
    const change = (o.signIn as { changePassword?: { value?: unknown } } | undefined)?.changePassword;
    for (const text of [fill?.secret === true ? fill.value : undefined, change?.value]) {
      if (typeof text === 'string') for (const m of text.matchAll(/\{\{\s*var\.([A-Za-z0-9_]+)\s*\}\}/g)) secret.add(m[1]);
    }
    Object.values(o).forEach(walk);
  };
  walk(steps);
  return { all, secret: all.filter((v) => secret.has(v)) };
}
/**
 * The start values that may be shown: none for a variable that is secret under any casing (UiPath's VB names do not
 * depend on case). Applied wherever a draft's start values are handed on: the Data item, the review page, this file.
 */
export function nonSecretStart(start: Readonly<Record<string, string>> | undefined, secretVariables: readonly string[]): Record<string, string> {
  const secret = new Set(secretVariables.map((v) => v.toLowerCase()));
  return Object.fromEntries(Object.entries(start ?? {}).filter(([name]) => !secret.has(name.toLowerCase())));
}
/** What a Run steps' note says about its credentials: the ones picked for you, then the ones to pick. */
function pickText(picked: string[], missing: string[]): string {
  return [
    picked.length ? `${and(picked)} ${picked.length === 1 ? 'is' : 'are'} picked for you: check ${picked.length === 1 ? 'it' : 'them'}.` : '',
    missing.length ? `Pick ${and(missing)} here.` : '',
  ].filter(Boolean).join(' ');
}
/**
 * The run log's nodes: they are drawn once a workflow has a Run steps, and the cap keeps room for them. **Log run** and
 * **Log failed run** shape the row, **Write run row** and **Write failed run row** write it.
 */
const LOG = {
  create: 'Create run log table', run: 'Log run', write: 'Write run row', failed: 'Log failed run', writeFailed: 'Write failed run row', stop: 'Stop and Error',
} as const;
const LOG_NODES = Object.keys(LOG).length;
/** Drawn before the run log's table, first after the triggers: every Get active steps reads playwright_steps after it. */
const STEPS_CREATE = 'Create steps table';
/** n8n's Data Table insert writing the item it gets, column by column (the item holds only the table's columns). */
const autoRow = () => ({
  mappingMode: 'autoMapInputData',
  value: null,
  matchingColumns: [],
  schema: RUN_TABLE_COLUMNS.map((c) => ({ id: c.name, displayName: c.name, required: false, defaultMatch: false, display: true, type: c.type, canBeUsedToMatch: true })),
});
/**
 * A run log row as one expression: the fields, then only those the table has. n8n's Data Table refuses a row with a
 * column the table lacks, and a playwright_runs made by an earlier version lacks the newer columns: Create run log table
 * gives the table it found or made, with its columns, and a column it does not list is left out. Every value comes from
 * the item the node gets, the execution's id, and that one node of the generator's own.
 */
const rowExpression = (fields: string): string =>
  `={{ ((row, have) => (have.length ? Object.fromEntries(Object.entries(row).filter(([k]) => have.includes(k))) : row))({ ${fields} }, [].concat($('${LOG.create}').first().json.columns ?? []).map((c) => c?.name)) }}`;
/**
 * A successful run: Run steps' Data item. What was not counted is left empty (null), never false or 0: rows and their
 * check only when the steps read rows, and the file's name when the run returned one.
 */
export const LOG_RUN_ROW = rowExpression([
  "name: $json.name ?? ''", 'lane: $json.lane ?? null', 'version: $json.version ?? null', "hash: $json.hash ?? ''",
  'confirmed: Array.isArray($json.rows) ? $json.confirmed === true : null', 'rowCount: Array.isArray($json.rows) ? $json.rows.length : null',
  'durationMs: $json.durationMs ?? null', 'llmTokens: $json.llmTokens ?? null', "code: ''", 'executionId: $execution.id',
  "message: ''", "guidance: ''", "file: [].concat($json.files ?? []).map((f) => f?.fileName).filter((n) => n).join(', ')", "account: $json.account ?? ''",
].join(', '));
/**
 * The run log keeps at most this many characters of a failure's message (the rest is in Run steps' error item). Long
 * enough for the longest message that ends in a command to run (the runner's policy and connection messages).
 */
export const LOGGED_MESSAGE_CHARS = 1000;
/**
 * A failed run: Run steps' error item, its facts under details (a configuration error has no code: config_error), the
 * message as the node gives it (masked: the node error's own message without its code), cut to LOGGED_MESSAGE_CHARS
 * characters with an ellipsis, and what to do (details.guidance, the node error's description). Nothing was counted. A
 * run refused before it started (locked_out, busy: no lane) has no lane, duration or tokens.
 */
export const LOG_FAILED_ROW = rowExpression([
  "name: $json.details?.name ?? ''", 'lane: $json.details?.lane ?? null', 'version: $json.details?.version ?? null', "hash: $json.details?.hash ?? ''",
  'confirmed: null', 'rowCount: null', 'durationMs: $json.details?.lane ? ($json.details?.durationMs ?? null) : null',
  'llmTokens: $json.details?.lane ? ($json.details?.llmTokens ?? null) : null',
  "code: $json.details?.code || 'config_error'", 'executionId: $execution.id', `message: ((m) => (m.length > ${LOGGED_MESSAGE_CHARS} ? m.slice(0, ${LOGGED_MESSAGE_CHARS - 1}).join('') + '…' : m.join('')))(Array.from(String($json.message ?? '')))`, "guidance: $json.details?.guidance ?? ''",
  "file: ''", "account: $json.details?.account ?? ''",
].join(', '));
/**
 * Stop and Error's message, from the row Log failed run shaped (also when writing it failed): the code and the step
 * list's name, the message as a sentence of its own (its first letter upper case, a full stop at its end), then
 * "What to do:" and the guidance. A table made by an earlier version has no message or guidance column: then it points
 * to Run steps.
 */
export const STOP_MESSAGE =
  `={{ ((r) => 'The run failed: ' + (r.code || 'config_error') + ' on ' + (r.name || 'the steps') + '.' + (r.message ? ' ' + String(r.message).charAt(0).toUpperCase() + String(r.message).slice(1) + (/[.!?…]$/.test(String(r.message)) ? '' : '.') : '') + (r.guidance ? ' What to do: ' + r.guidance : '') + (r.message || r.guidance ? '' : ' Run steps in this execution has the message.'))($('${LOG.failed}').first().json) }}`;
const RUNS_ONCE = 'Run steps runs once for all items here, not once per item, because Get active steps has Execute Once on.';
/** The binary property Run steps gives the draft's last top-level download or expected file (file_<index>, see the engine's binaryName). */
function downloadProperty(draft: Draft | DesktopDraft): string | undefined {
  const steps = draft.script.steps as unknown as Record<string, unknown>[];
  for (let i = steps.length - 1; i >= 0; i--) {
    if (Object.prototype.hasOwnProperty.call(steps[i], 'download') || Object.prototype.hasOwnProperty.call(steps[i], 'expectFile')) return `file_${i}`;
  }
  return undefined;
}

type Tail = { node: string; output: number };
interface Walked { tails: Tail[]; x: number }

class Builder {
  readonly nodes: WorkflowNode[] = [];
  readonly connections: WorkflowJson['connections'] = {};
  private readonly names = new Set<string>();
  private ids = 0;
  /** What the stickies at the top list. */
  readonly runNodes: string[] = [];
  readonly s3Nodes: string[] = [];
  readonly emailNodes: string[] = [];
  readonly httpNodes: string[] = [];
  readonly draftNames: string[] = [];
  readonly desktopRunNodes: string[] = [];
  readonly desktopDraftNames: string[] = [];
  /** Every Run steps drawn, browser and desktop, in the order drawn: each one writes the run log. */
  readonly allRuns: string[] = [];
  /** The colours of the stickies drawn so far: the legend names only these. */
  readonly colours = new Set<number>();
  credentials = 0;
  others = 0;
  untranslated = 0;
  /**
   * The binary property the imported draft gives its download, while that Run steps' item is what flows on: set by a
   * browser pair, kept by nodes that pass items through (Wait, If, stickies), cleared by every other node.
   */
  private lastFile: string | undefined;

  /** Nodes the cap keeps free for what is drawn after the flow (the run log). */
  kept = 0;
  /** Activities not drawn because the workflow reached MAX_WORKFLOW_NODES. */
  skipped = 0;
  /** Set when the first activity does not fit: everything after it is counted too, so nothing is drawn out of order. */
  private full = false;
  /** Each If and For Each's depth and whether a browser pair is inside it, worked out once: every If above asks. */
  private readonly depths = new Map<FlowNode, number>();
  private readonly browsers = new Map<FlowNode, boolean>();

  constructor(
    private readonly prefix: string, private readonly drafts: Map<string, Draft>, private readonly desktopDrafts: Map<string, DesktopDraft> = new Map(),
    private readonly codeWorkflow?: BuildWorkflowOptions['codeWorkflow'], readonly source: ImportedFrom = 'uipath',
    private readonly run: NonNullable<BuildWorkflowOptions['run']> = {},
    private readonly passedOn: PassedOn = {},
  ) {}

  /**
   * What a Run steps carries for these slots: each credential the import passed on, by id and name, and the labels of
   * those it picked and of those the person still picks (a desktop Run steps names the RPA Desktop Runner by name then).
   */
  slots(which: Slot[]): { credentials: NonNullable<WorkflowNode['credentials']>; picked: string[]; missing: string[] } {
    const credentials: NonNullable<WorkflowNode['credentials']> = {};
    const picked: string[] = [];
    const missing: string[] = [];
    for (const slot of which) {
      const ref = cleanRef(this.passedOn[slot]);
      if (ref) {
        credentials[CREDENTIALS[slot]] = ref;
        picked.push(LABEL[slot]);
      } else {
        if (slot === 'desktopRunner') credentials[CREDENTIALS[slot]] = { ...DESKTOP_RUNNER_BY_NAME };
        missing.push(LABEL[slot]);
      }
    }
    return { credentials, picked, missing };
  }
  /** Run variables that come from the RPA Secret Variables credential, over every Run steps. */
  readonly secretVariables = new Set<string>();

  /**
   * The run options the import was proven with: Max Seconds when it is not the default, and on browser steps Also Allow
   * These Sites and Allow Private Network (written as a plain true, only when the import had it on).
   */
  private runOptions(browser: boolean): Record<string, string | number | boolean> {
    const max = this.run.maxSeconds;
    const hosts = (this.run.allowedHosts ?? []).map((h) => literal(h)).filter((h): h is string => h !== undefined);
    return {
      ...(max !== undefined && max !== DEFAULT_MAX_SECONDS ? { maxSeconds: max } : {}),
      ...(browser && hosts.length ? { allowedHosts: hosts.join(', ') } : {}),
      ...(browser && this.privateNetwork ? { allowPrivateNetwork: true } : {}),
    };
  }
  /** Options → ID Pattern: the one the step list was proven with, typed; none when n8n would read it as an expression. */
  private idPatternOption(draftName: string): { idPattern?: string } {
    const idPattern = literal(this.run.idPatterns?.get(draftName));
    return idPattern ? { idPattern } : {};
  }
  /** True only when the import ran with Allow Private Network on. */
  private get privateNetwork(): boolean {
    return this.run.allowPrivateNetwork === true;
  }
  /** Options → Variables for the steps' run variables: not secret ones, each with its start value or empty; secret ones are left out. */
  private variablesOption(all: string[], secret: Set<string>, start: Record<string, string> = {}): Record<string, unknown> {
    // Names come from {{var.name}} in the steps, so they are letters, digits and "_". Checked again here, because a name
    // is written into the node as it is: one that n8n could read as an expression stops the import.
    const odd = all.find((v) => !PLAIN_NAME.test(v));
    if (odd !== undefined) throw new Error(`A variable's name must be letters, digits and "_" only: ${JSON.stringify(odd.slice(0, 60))}`);
    const values = all.filter((v) => !secret.has(v)).map((name) => ({ name, value: literal(start[name]) ?? '' }));
    for (const v of secret) this.secretVariables.add(v);
    return values.length ? { variables: { values } } : {};
  }

  /**
   * A browser Run steps' code options: the import's One-Time Code Workflow (only as a literal, never text that n8n would
   * read as an expression), and Code Timeout when it is not the default 120 s.
   */
  private codeOptions(): Record<string, unknown> {
    const id = literal(this.codeWorkflow?.id);
    if (!this.codeWorkflow || id === undefined) return {};
    // The option is n8n's workflow picker: the workflow by its ID, in the picker's own form.
    return { codeWorkflowId: { __rl: true, mode: 'id', value: id }, ...(this.codeWorkflow.timeoutSeconds !== 120 ? { codeTimeout: this.codeWorkflow.timeoutSeconds } : {}) };
  }

  /** How deep If and For Each nest inside these lists (0 without any). */
  private depth(lists: FlowNode[][]): number {
    let d = 0;
    for (const list of lists) {
      for (const n of list) {
        if (n.kind !== 'if' && n.kind !== 'forEach') continue;
        let own = this.depths.get(n);
        if (own === undefined) {
          own = (n.kind === 'if' ? 1 : 0) + this.depth(children(n));
          this.depths.set(n, own);
        }
        d = Math.max(d, own);
      }
    }
    return d;
  }
  /** Whether a browser pair (a browser node with its draft) is in these lists, at any depth. */
  hasBrowser(lists: FlowNode[][]): boolean {
    return lists.some((list) => list.some((n) => {
      if (n.kind === 'browser') return this.drafts.has(draftOf(this.prefix, n));
      if (n.kind === 'desktop') return this.desktopDrafts.has(draftOf(this.prefix, n));
      if (n.kind !== 'if' && n.kind !== 'forEach') return false;
      let has = this.browsers.get(n);
      if (has === undefined) {
        has = this.hasBrowser(children(n));
        this.browsers.set(n, has);
      }
      return has;
    }));
  }

  /** Names only the generator gives, taken before any project node is named. */
  reserve(...names: string[]): void {
    for (const n of names) this.names.add(n);
  }

  unique(base: string): string {
    const name = line(base, MAX_NAME) || 'Node';
    let candidate = name;
    for (let n = 2; this.names.has(candidate); n++) candidate = `${name} ${n}`;
    this.names.add(candidate);
    return candidate;
  }
  /**
   * The name of a Run steps: the name of its step list, as Get active steps and the run log name it. A recording's or
   * a step document's flow names its own (`draft`, the name typed on the form). A UiPath project's sequence is named
   * after its step list too (`<name>-<n>`), never after its first activity.
   */
  private runName(n: { displayName: string; draft?: string }, draftName: string): string {
    return n.draft !== undefined ? this.nodeName(n.displayName, `Run steps (${draftName})`) : this.unique(draftName);
  }
  /** A node name from the project's display name, or the fallback when it has none or would look like an expression. */
  private nodeName(displayName: string, fallback: string): string {
    const d = line(displayName, MAX_NAME);
    return this.unique(d && !d.startsWith('=') ? d : fallback);
  }
  private id(): string {
    this.ids += 1;
    return `5a1e7c00-0000-4000-8000-${this.ids.toString(16).padStart(12, '0')}`;
  }
  add(type: readonly [string, number], name: string, position: [number, number], parameters: Record<string, unknown>, extra: Partial<WorkflowNode> = {}): string {
    this.nodes.push({ id: this.id(), name, type: type[0], typeVersion: type[1], position, parameters, ...extra });
    return name;
  }
  sticky(name: string, content: string, color: number, position: [number, number], width = 220, height = 240, reserved = false): void {
    this.colours.add(color);
    this.add(T.sticky, reserved ? name : this.unique(name), position, { content, height, width, color });
  }
  connect(tails: Tail[], to: string): void {
    for (const t of tails) {
      const outputs = ((this.connections[t.node] ??= {}).main ??= []);
      while (outputs.length <= t.output) outputs.push([]);
      outputs[t.output].push({ node: to, type: 'main', index: 0 });
    }
  }
  /** The nodes a flow node draws itself, its If or loop body aside. */
  private cost(n: FlowNode): number {
    if (n.kind === 'browser') return this.drafts.has(draftOf(this.prefix, n)) ? PAIR_NODES : 1;
    if (n.kind === 'desktop') return this.desktopDrafts.has(draftOf(this.prefix, n)) ? DESKTOP_PAIR_NODES : 1;
    return n.kind === 'if' ? 2 : 1;
  }
  /** A working node in the next column: every open end connects to it, and it is the only open end after it. */
  private step(tails: Tail[], x: number, y: number, type: readonly [string, number], name: string, parameters: Record<string, unknown>, extra: Partial<WorkflowNode> = {}): Walked {
    this.add(type, name, [x, y], parameters, extra);
    this.connect(tails, name);
    this.others += 1;
    return { tails: [{ node: name, output: 0 }], x: x + STEP };
  }
  /** A sticky in the next column, after the previous node; the open ends go past it to the next working node. */
  private inline(tails: Tail[], x: number, y: number, name: string, content: string, color: number): Walked {
    this.sticky(name, content, color, [x - 40, y - 120]);
    return { tails, x: x + STEP };
  }
  private untranslatedSticky(tails: Tail[], x: number, y: number, displayName: string, activity: string, note: string): Walked {
    this.untranslated += 1;
    const label = line(displayName, 80) || line(activity, 80) || 'activity';
    return this.inline(tails, x, y, `Not translated: ${label}`,
      `### Not translated (grey)\nNot translated: ${md(displayName || activity)} (${md(activity)}): ${md(note, 600)}`, COLOUR.grey);
  }

  /**
   * The run log after the flow: each Run steps' Data output also feeds **Log run** (a row per run), and its error output
   * feeds **Log failed run** → **Stop and Error**, so a failed run is logged and the execution still fails. One set for
   * every Run steps. A lone Run steps at the end of the flow has them right of it; otherwise they sit below the flow.
   */
  runLog(): void {
    if (!this.allRuns.length) return;
    const at = (name: string) => this.nodes.find((n) => n.name === name)?.position ?? [0, 0];
    const lone = this.allRuns.length === 1 && !(this.connections[this.allRuns[0]]?.main?.[0]?.length);
    let logAt: [number, number];
    let failAt: [number, number];
    if (lone) {
      const [rx, ry] = at(this.allRuns[0]);
      logAt = [rx + STEP, ry];
      // Clear of a desktop pair's gold variables note, which sits under its Run steps.
      failAt = [rx + STEP + 40, ry + 220];
    } else {
      let bottom = 0;
      for (const n of this.nodes) bottom = Math.max(bottom, n.position[1] + (n.type === T.sticky[0] ? Number((n.parameters as { height?: number }).height ?? 0) : 100));
      logAt = [2 * STEP, bottom + 80];
      failAt = [2 * STEP, bottom + 280];
    }
    const table = { __rl: true, mode: 'name', value: RUN_TABLE };
    const right = (at: [number, number]): [number, number] => [at[0] + STEP, at[1]];
    // Not Execute Once: a Run steps that runs once per item (one per account) writes one row per run.
    this.add(T.set, LOG.run, logAt, { mode: 'raw', jsonOutput: LOG_RUN_ROW, options: {} }, {
      notes: `The row ${LOG.write} writes to ${RUN_TABLE} for each successful run of a Run steps.`,
    });
    this.add(T.dataTable, LOG.write, right(logAt), { resource: 'row', operation: 'insert', dataTableId: table, columns: autoRow(), options: {} });
    this.add(T.set, LOG.failed, failAt, { mode: 'raw', jsonOutput: LOG_FAILED_ROW, options: {} }, {
      notes: `The row ${LOG.writeFailed} writes for each failed run: the error code, the message and what to do.`,
    });
    this.add(T.dataTable, LOG.writeFailed, right(failAt), { resource: 'row', operation: 'insert', dataTableId: table, columns: autoRow(), options: {} }, {
      onError: 'continueRegularOutput', notes: 'If the row cannot be written, the run still stops as failed.',
    });
    this.add(T.stopAndError, LOG.stop, right(right(failAt)), { errorType: 'errorMessage', errorMessage: STOP_MESSAGE }, {
      notes: 'Ends a failed run as failed, so it shows in Executions and an Error Workflow set in the workflow settings runs.',
    });
    for (const run of this.allRuns) {
      this.connect([{ node: run, output: 0 }], LOG.run);
      this.connect([{ node: run, output: 1 }], LOG.failed);
    }
    this.connect([{ node: LOG.run, output: 0 }], LOG.write);
    this.connect([{ node: LOG.failed, output: 0 }], LOG.writeFailed);
    this.connect([{ node: LOG.writeFailed, output: 0 }], LOG.stop);
  }

  /** Removes a node that has one input and one output, connecting each of `from` straight to what it fed. */
  unlink(name: string, from: string[]): void {
    const next = this.connections[name]?.main?.[0] ?? [];
    delete this.connections[name];
    for (const f of from) {
      const outputs = this.connections[f]?.main ?? [];
      outputs[0] = [...(outputs[0] ?? []).filter((c) => c.node !== name), ...next];
    }
    this.nodes.splice(this.nodes.findIndex((n) => n.name === name), 1);
  }

  /** Draws the list; once the workflow has MAX_WORKFLOW_NODES nodes, the rest is only counted (see `overflow`). */
  walk(list: FlowNode[], tails: Tail[], x: number, y: number): Walked {
    let at: Walked = { tails, x };
    for (const n of list) {
      if (!this.full && this.nodes.length + this.cost(n) > MAX_WORKFLOW_NODES - this.kept) this.full = true;
      if (this.full) this.skipped += size(n);
      else at = this.one(n, at.tails, at.x, y);
    }
    return at;
  }
  /** One grey sticky for every activity `walk` did not draw, after the last node drawn. */
  overflow(at: Walked): void {
    if (this.skipped === 0) return;
    const n = this.skipped.toLocaleString('en-US');
    const more = `${n} more ${this.skipped === 1 ? 'activity' : 'activities'}`;
    this.inline(at.tails, at.x, 0, more,
      `### ${more} (grey)\n${more}: see the report. This workflow draws only its first ${MAX_WORKFLOW_NODES} nodes: rebuild the rest by hand from the import report (\`report\` on Import steps' Data output) and the UiPath project.`, COLOUR.grey);
  }

  /** Get active steps: the newest active version of the step list `draftName` from the steps table, connected after `tails`. */
  private getActiveSteps(draftName: string, tails: Tail[], x: number, y: number): string {
    const get = this.unique(`Get active steps (${draftName})`);
    this.add(T.dataTable, get, [x, y], {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'name', value: STEPS_TABLE },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'name', condition: 'eq', keyValue: draftName }, { keyName: 'status', condition: 'eq', keyValue: 'active' }] },
      returnAll: false,
      limit: 1,
      orderBy: true,
      orderByColumn: 'version',
      orderByDirection: 'DESC',
    }, {
      alwaysOutputData: true,
      executeOnce: true,
      notes: `The newest active version of ${draftName}, or one empty item until a version is approved.`,
    });
    this.connect(tails, get);
    return get;
  }

  /**
   * A desktop sequence: Get active steps → Run steps on the RPA Desktop Runner credential (by type), signed steps
   * required, AI Repair off, the draft's variables empty for the user (secret ones noted), and a gold sticky saying what
   * to fill in and how the steps get approved. A sequence without a draft is a grey sticky.
   */
  private desktopPair(n: Extract<FlowNode, { kind: 'desktop' }>, tails: Tail[], x: number, y: number): Walked {
    const draftName = draftOf(this.prefix, n);
    const draft = this.desktopDrafts.get(draftName);
    if (!draft) {
      this.lastFile = undefined;
      return this.untranslatedSticky(tails, x, y, n.displayName, 'Desktop steps', `no step list named ${draftName} was built, so there are no steps to run`);
    }
    this.desktopDraftNames.push(draftName);
    const get = this.getActiveSteps(draftName, tails, x, y);
    const run = this.runName(n, draftName);
    const runX = x + STEP;
    const secret = new Set(draft.secretVariables);
    const start = nonSecretStart(draft.startValues, draft.secretVariables);
    /** The start values the workflow writes: those n8n would not read as an expression. */
    const plain = (values: Record<string, string>) => Object.values(values).filter((v) => literal(v) !== undefined);
    const plainVars = draft.variables.filter((v) => !secret.has(v));
    // Only what applies: a list with no variables asks for none, and one whose variables are all secret has no Variables.
    const fillIn = plain(start).length ? ` The Variables start with ${FROM[this.source].startValues}: change them here.` : plainVars.length ? ' Fill in the Variables.' : '';
    const creds = this.slots(DESKTOP_SLOTS);
    this.add(T.rpa, run, [runX, y], {
      operation: 'runSteps',
      runsOn: 'desktop',
      steps: fromRow(get, 'steps'),
      requireSignedSteps: true,
      signature: fromRow(get, 'signature'),
      approvedBy: fromRow(get, 'approvedBy'),
      aiRepair: false,
      options: { name: draftName, expectedVersion: fromRow(get, 'version'), ...this.runOptions(false), ...this.variablesOption(draft.variables, secret, start) },
    }, {
      onError: 'continueErrorOutput',
      credentials: creds.credentials,
      notes: `Runs the signed desktop steps ${draftName} on the desktop runner. ${pickText(creds.picked, creds.missing)}${fillIn}${secret.size ? ` ${[...secret].join(', ')}: put ${secret.size === 1 ? 'it' : 'them'} in an RPA Secret Variables credential and select it here.` : ''}`,
    });
    this.connect([{ node: get, output: 0 }], run);
    this.desktopRunNodes.push(run);
    this.allRuns.push(run);
    if (plainVars.length || secret.size) {
      const listedVars = plainVars.length
        ? `On **${md(run)}**, Options → Variables: ${plainVars.map((v) => (literal(start[v]) !== undefined ? `${code(v, 60)} (starts as ${code(start[v], 120)})` : code(v, 60))).join(', ')}.`
        : '';
      const secretVars = secret.size ? `Secret: ${[...secret].map((v) => code(v, 60)).join(', ')}: in an ${SECRET_VARIABLES} credential selected on **${md(run)}**, never typed here. To keep these values to this app, put ${code(String(draft.script.app?.exe ?? '').split(/[\\/]/).pop() ?? '', 120)} in that credential's May Be Typed Into.` : '';
      this.sticky(`Fill in the variables (${draftName})`,
        `### Fill in the variables (gold)\n${[listedVars, secretVars].filter(Boolean).join(' ')} Desktop steps run only once approved: ${FROM[this.source].importIt} with **${IMPORT_FORM}** and approve ${code(draftName)} on its review page.`,
        COLOUR.gold, [runX - 80, y + 160], 320, 260);
    }
    this.lastFile = downloadProperty(draft);
    return { tails: [{ node: run, output: 0 }], x: x + 2 * STEP };
  }

  private one(n: FlowNode, tails: Tail[], x: number, y: number): Walked {
    switch (n.kind) {
      case 'browser': {
        const draftName = draftOf(this.prefix, n);
        const draft = this.drafts.get(draftName);
        if (!draft) {
          this.lastFile = undefined;
          return this.untranslatedSticky(tails, x, y, n.displayName, 'Browser steps', `no step list named ${draftName} was built, so there are no steps to run`);
        }
        this.draftNames.push(draftName);
        const get = this.getActiveSteps(draftName, tails, x, y);
        const run = this.runName(n, draftName);
        const runX = x + STEP;
        const vars = stepVariables(draft.script);
        const creds = this.slots(BROWSER_SLOTS);
        // Runs as generated: no repair branch (a Chat model and an Approve steps would need a credential and a workflow
        // picked first). The note says how to add it.
        this.add(T.rpa, run, [runX, y], {
          operation: 'runSteps',
          runsOn: 'browser',
          steps: fromRow(get, 'steps'),
          requireSignedSteps: true,
          signature: fromRow(get, 'signature'),
          approvedBy: fromRow(get, 'approvedBy'),
          aiRepair: false,
          options: {
            name: draftName, expectedVersion: fromRow(get, 'version'), ...this.codeOptions(), ...this.runOptions(true), ...this.idPatternOption(draftName),
            ...this.variablesOption(vars.all, new Set(vars.secret)),
          },
        }, {
          onError: 'continueErrorOutput',
          ...(Object.keys(creds.credentials).length ? { credentials: creds.credentials } : {}),
          notes: [
            `Runs the signed steps ${draftName}. ${pickText(creds.picked, creds.missing)} ${this.privateNetwork ? PRIVATE_NETWORK_ON : PRIVATE_NETWORK_OFF}${vars.secret.length ? ` ${vars.secret.join(', ')}: put ${vars.secret.length === 1 ? 'it' : 'them'} in an RPA Secret Variables credential and select it here.` : ''}`,
            'To let it repair itself when the site changes:',
            '1. Connect a chat model to its Model input (after step 2).',
            `2. Turn on AI Repair here and write the Goal in plain words. The outputs become Data, Repaired Steps and error.`,
            `3. Connect its Repaired Steps output to an Execute Workflow node that calls ${APPROVE_WORKFLOW}, and its error output to ${LOG.failed} again.`,
          ].join('\n'),
        });
        this.connect([{ node: get, output: 0 }], run);
        this.runNodes.push(run);
        this.allRuns.push(run);
        this.lastFile = downloadProperty(draft);
        return { tails: [{ node: run, output: 0 }], x: x + 2 * STEP };
      }
      case 'desktop':
        return this.desktopPair(n, tails, x, y);
      case 's3Upload': {
        const bucket = literal(n.bucket);
        const key = literal(n.key);
        const file = this.lastFile;
        this.lastFile = undefined;
        const notes = [
          bucket ? '' : missing('Bucket', n.bucket),
          key ? '' : missing('Key (File Name)', n.key),
          file
            ? `Uploads the file Run steps downloaded: Input Binary Field reads its name from Run steps' files (${file} in the imported steps).`
            : 'No Run steps download reaches this node: set Input Binary Field to the file to upload.',
          'Pick an AWS credential.',
        ];
        const name = this.nodeName(n.displayName, 'S3 upload');
        this.s3Nodes.push(name);
        return this.step(tails, x, y, T.awsS3, name, {
          resource: 'file',
          operation: 'upload',
          bucketName: bucket ?? '',
          fileName: key ?? '',
          binaryData: true,
          // Run steps names the file itself (files[].binaryProperty); a repair that moves the download changes the name.
          binaryPropertyName: file ? `={{ $json.files?.at(-1)?.binaryProperty ?? '${file}' }}` : 'data',
          additionalFields: {},
        }, { notes: notes.filter(Boolean).join(' ') });
      }
      case 'readSpreadsheet': {
        this.lastFile = undefined;
        const sheet = literal(n.sheet);
        const notes = [
          `UiPath read the workbook ${n.path ? line(n.path, 300) : '(set with an expression)'}: bring it in as the binary field data, for example with Read/Write Files from Disk or from a Run steps download.`,
          sheet || n.sheet === undefined ? '' : missing('Sheet', n.sheet),
        ];
        return this.step(tails, x, y, T.extractFromFile, this.nodeName(n.displayName, 'Read spreadsheet'), {
          operation: 'xlsx', binaryPropertyName: 'data', options: sheet ? { sheetName: sheet } : {},
        }, { notes: notes.filter(Boolean).join(' ') });
      }
      case 'writeSpreadsheet': {
        this.lastFile = undefined;
        const sheet = literal(n.sheet);
        const fileName = n.path ? literal(basename(n.path)) : undefined;
        const options: Record<string, string> = {};
        if (fileName) options.fileName = fileName;
        if (sheet) options.sheetName = sheet;
        const notes = [
          `UiPath wrote the workbook ${n.path ? line(n.path, 300) : '(set with an expression)'}; here the file is the binary field data on the output.`,
          sheet || n.sheet === undefined ? '' : missing('Sheet', n.sheet),
        ];
        return this.step(tails, x, y, T.convertToFile, this.nodeName(n.displayName, 'Write spreadsheet'), {
          operation: 'xlsx', binaryPropertyName: 'data', options,
        }, { notes: notes.filter(Boolean).join(' ') });
      }
      case 'http': {
        this.lastFile = undefined;
        const url = literal(n.url);
        const method = n.method && HTTP_METHODS.has(n.method.toUpperCase()) ? n.method.toUpperCase() : 'GET';
        const notes = [
          url ? '' : missing('URL', n.url),
          n.method && method !== n.method.toUpperCase() ? `UiPath's method was ${line(n.method, 40)}.` : '',
          'Add authentication, headers and a body if the call needs them.',
        ];
        const name = this.nodeName(n.displayName, 'HTTP request');
        this.httpNodes.push(name);
        return this.step(tails, x, y, T.httpRequest, name, { method, url: url ?? '', options: {} }, { notes: notes.filter(Boolean).join(' ') });
      }
      case 'email': {
        this.lastFile = undefined;
        const to = literal(n.to);
        const subject = literal(n.subject);
        const notes = [
          to ? '' : missing('To', n.to),
          subject ? '' : missing('Subject', n.subject),
          'Write the From address and the text (UiPath built the body itself). Pick an SMTP credential.',
        ];
        const name = this.nodeName(n.displayName, 'Send email');
        this.emailNodes.push(name);
        return this.step(tails, x, y, T.emailSend, name, {
          resource: 'email', operation: 'send', fromEmail: '', toEmail: to ?? '', subject: subject ?? '', emailFormat: 'text', text: '', options: {},
        }, { notes: notes.filter(Boolean).join(' ') });
      }
      case 'wait': {
        const seconds = n.seconds !== undefined && Number.isFinite(n.seconds) && n.seconds >= 0 ? n.seconds : undefined;
        return this.step(tails, x, y, T.wait, this.nodeName(n.displayName, 'Wait'), { resume: 'timeInterval', amount: seconds ?? 5, unit: 'seconds' },
          seconds === undefined ? { notes: 'UiPath set the delay with an expression: set the time here.' } : {});
      }
      case 'if': {
        const name = this.nodeName(n.displayName, 'If');
        this.add(T.if, name, [x, y], {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: this.id(), leftValue: '', rightValue: '', operator: { type: 'string', operation: 'equals' } }],
            combinator: 'and',
          },
          options: {},
        }, { notes: `UiPath condition: ${line(n.expression, 1000)}` });
        this.connect(tails, name);
        this.others += 1;
        const once = this.hasBrowser([n.then, n.else]) ? ` ${RUNS_ONCE}` : '';
        this.sticky(`Fill in the condition: ${name}`,
          `### Fill in the condition (gold)\nUiPath tested ${code(n.expression)}. Write it as conditions on **${md(name)}**. Until then the condition is empty and every item goes to true.${once}`,
          COLOUR.gold, [x - 60, y + 110], 220, 220);
        const off = BRANCH * (1 + this.depth([n.then, n.else]));
        const before = this.lastFile;
        const yes = this.walk(n.then, [{ node: name, output: 0 }], x + STEP, y - off);
        const afterYes = this.lastFile;
        this.lastFile = before;
        const no = this.walk(n.else, [{ node: name, output: 1 }], x + STEP, y + off);
        // A file name is known after the If only when both branches leave the same one.
        if (this.lastFile !== afterYes) this.lastFile = undefined;
        return { tails: [...yes.tails, ...no.tails], x: Math.max(yes.x, no.x, x + STEP) };
      }
      case 'forEach': {
        const d = this.depth([n.body]);
        const body = this.walk(n.body, tails, x, y);
        const end = Math.max(body.x, x + STEP);
        this.sticky(`Loop: ${line(n.displayName, 80) || 'For Each'}`,
          `### Loop: ${md(n.displayName, 120)} (grey)\nUiPath looped over ${code(n.expression)}. n8n runs each node once per item, so the loop's body is inline here. Make sure the items that reach it are the ones to loop over.${this.hasBrowser([n.body]) ? ` ${RUNS_ONCE}` : ''}`,
          // Room below the row for a pair's labels.
          COLOUR.grey, [x - 60, y - 160 - BRANCH * d], end - x, 330 + 2 * BRANCH * d + (this.hasBrowser([n.body]) ? 270 : 0));
        return { tails: body.tails, x: end };
      }
      case 'credential': {
        this.credentials += 1;
        // Desktop steps refuse a Site Login: they type the sign-in from their Run steps' Variables.
        const pickOne = cleanRef(this.passedOn.siteLogin) ? '' : ' Pick one there.';
        if (this.desktopDrafts.size > 0) {
          const browser = this.drafts.size > 0 ? ` Browser steps: the RPA Site Login on their Run steps holds the login.${pickOne}` : '';
          return this.inline(tails, x, y, `Credential: ${line(n.asset, 80) || 'UiPath'}`,
            `### UiPath credential (green)\nUiPath credential ${code(n.asset, 120)}: n8n never copies a UiPath credential. Desktop steps type the user name and password from their Run steps' **Variables** (see the gold notes); a secret one, such as the password, comes from an ${SECRET_VARIABLES} credential selected on that Run steps, never as text in this workflow.${browser}`, COLOUR.green);
        }
        return this.inline(tails, x, y, `Credential: ${line(n.asset, 80) || 'UiPath'}`,
          `### UiPath credential (green)\nUiPath credential ${code(n.asset, 120)}: the RPA Site Login on the Run steps node(s) holds that login. n8n never copies a UiPath credential.${pickOne}`, COLOUR.green);
      }
      case 'untranslated':
        return this.untranslatedSticky(tails, x, y, n.displayName, n.activity, n.note);
    }
  }
}

/**
 * A note's size for its text, so that nothing is cut off on the canvas: about 7 px per character at the note's width,
 * 22 px per line of text and room for the heading and the margins.
 */
export function noteSize(content: string, width: number): { width: number; height: number } {
  const perLine = Math.floor((width - 40) / 7);
  let lines = 0;
  for (const l of content.split('\n')) lines += Math.max(1, Math.ceil(l.replace(/[*`\\]/g, '').length / perLine));
  return { width, height: 60 + lines * 22 };
}

/** Up to five names in bold, then how many more. */
function listed(names: string[]): string {
  const shown = names.slice(0, 5).map((n) => `**${md(n, 100)}**`).join(', ');
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}

/**
 * The n8n workflow for a UiPath import's flow, or a recording's (opts.source). `drafts` are the import's drafts, named
 * `<opts.name>-<n>`. Throws only when opts.name cannot be used as a literal name (empty, or starting with "=").
 */
export function buildWorkflow(flow: UiPathFlow, drafts: Draft[], opts: BuildWorkflowOptions): WorkflowJson {
  if (opts.name.trim() === '' || opts.name.startsWith('=')) throw new Error('The Name must not be empty or start with "="');
  // A step list's own name is written into parameters as it is (the table filter, Run steps' Name), so the same rule holds for it.
  for (const d of [...drafts, ...(opts.desktopDrafts ?? [])]) {
    if (d.name.trim() === '' || d.name.startsWith('=')) throw new Error(`The Name of a step list must not be empty or start with "=": ${JSON.stringify(d.name.slice(0, 60))}`);
  }
  const b = new Builder(opts.name, new Map(drafts.map((d) => [d.name, d])), new Map((opts.desktopDrafts ?? []).map((d) => [d.name, d])), opts.codeWorkflow, opts.source, opts.run, opts.credentials);
  const from = FROM[b.source];
  const uipath = b.source === 'uipath';
  b.add(T.manualTrigger, b.unique('Run the bot'), [0, 0], {});
  // Off until a person sets the time: n8n then runs the bot on that schedule once the workflow is published.
  b.add(T.scheduleTrigger, b.unique('On a schedule'), [0, 200], { rule: { interval: [{ field: 'days', triggerAtHour: 6 }] } }, {
    disabled: true, notes: 'Set the time, then turn this node on and publish the workflow. Until then the bot runs only when you click Execute.',
  });
  b.reserve('About this import', 'Set once');
  let start: Tail[] = [{ node: 'Run the bot', output: 0 }, { node: 'On a schedule', output: 0 }];
  // A flow with a Run steps reads the steps table and keeps a run log: both tables are made when missing, first, as the
  // templates do, so that on an n8n without them Get active steps finds nothing (Run steps then says so) and the log is written.
  const logged = b.hasBrowser([flow.nodes]);
  if (logged) {
    b.reserve(STEPS_CREATE, ...Object.values(LOG));
    b.add(T.dataTable, STEPS_CREATE, [STEP, 0], {
      resource: 'table', operation: 'create', tableName: STEPS_TABLE, columns: { column: STEPS_TABLE_COLUMNS.map((c) => ({ name: c.name, type: c.type })) }, options: { createIfNotExists: true },
    }, { notes: `Creates ${STEPS_TABLE} when it is missing, before Get active steps reads it.` });
    b.add(T.dataTable, LOG.create, [2 * STEP, 0], {
      resource: 'table', operation: 'create', tableName: RUN_TABLE, columns: { column: RUN_TABLE_COLUMNS.map((c) => ({ name: c.name, type: c.type })) }, options: { createIfNotExists: true },
    }, { notes: `Creates the run log ${RUN_TABLE} when it is missing.` });
    b.connect(start, STEPS_CREATE);
    b.connect([{ node: STEPS_CREATE, output: 0 }], LOG.create);
    start = [{ node: LOG.create, output: 0 }];
    b.kept = LOG_NODES - 1;
  }
  b.overflow(b.walk(flow.nodes, start, logged ? 3 * STEP : STEP, 0));
  // No Run steps fitted under the cap: no tables, and the triggers start the flow directly.
  if (logged && !b.allRuns.length) {
    b.unlink(LOG.create, [STEPS_CREATE]);
    b.unlink(STEPS_CREATE, ['Run the bot', 'On a schedule']);
  }
  b.runLog();

  const project = line(flow.name, 120).replace(/^=+/, '').trim() || opts.name;
  const desktopPart = b.desktopDraftNames.length ? ` and ${plural(b.desktopDraftNames.length, 'desktop sequence')}` : '';
  const lists = [b.draftNames.length ? plural(b.draftNames.length, 'step list') : '', b.desktopDraftNames.length ? plural(b.desktopDraftNames.length, 'desktop step list') : ''].filter(Boolean).join(' and ') || '0 step lists';
  const summary = !uipath ? `${lists} as signed RPA steps` : `${plural(b.draftNames.length, 'browser sequence')}${desktopPart} as signed RPA steps, ${plural(b.others, 'other activity', 'other activities')} as n8n nodes, ${b.untranslated} not translated${b.skipped ? `, ${b.skipped.toLocaleString('en-US')} more not drawn (see the report)` : ''}`;
  // A loop, not Math.min(...positions): spreading a long array into arguments overflows the stack.
  let highest = 0;
  for (const n of b.nodes) highest = Math.min(highest, n.position[1]);
  // For a person who just imported the file and wants to run it: one thing to act on per line, nothing about wiring.
  const names = [...b.draftNames, ...b.desktopDraftNames];
  const which = names.length ? `${names.slice(0, 3).map((d) => code(d)).join(', ')}${names.length > 3 ? ', …' : ''}` : '';
  const colours = new Set([...b.colours, COLOUR.grey, COLOUR.green]);
  const about = [
    '### About this import',
    `- Runs the approved steps ${which || 'of the import'}, imported from ${from.origin} ${code(project, 120)}.`,
    uipath ? `- ${plural(b.others, 'other activity', 'other activities')} became n8n nodes. ${b.untranslated || b.skipped ? `Grey notes mark what was not translated${b.skipped ? `, and ${b.skipped.toLocaleString('en-US')} more not drawn (see the report)` : ''}: rebuild that by hand.` : 'Each one says what to check.'}` : '',
    '- **Run the bot** runs it now. **On a schedule** is off: set the time, turn it on, publish.',
    b.allRuns.length ? `- Each run writes a row to ${RUN_TABLE}. Failed runs show as failed in Executions.` : '',
    b.allRuns.length ? '- To hear of a failed run, set an Error Workflow in the workflow settings.' : '',
    names.length ? `- To change the steps or sign them again, use **${IMPORT_FORM}** with the bot's name.` : '',
    b.draftNames.length ? '- For self-repair when the site changes, see the browser guide, Part 2.' : '',
    colours.size > 2 ? `- ${[colours.has(COLOUR.gold) ? 'Gold: fill in.' : '', 'Green: set once.', 'Grey: leave as is.'].filter(Boolean).join(' ')}` : '',
  ].filter(Boolean).join('\n');
  // Each RPA credential the Run steps use: picked when the import passed it on (by id and name: no secret is in this file).
  const used = (slots: Slot[], runs: string[]) => (runs.length ? b.slots(slots) : { picked: [], missing: [] });
  const browserCreds = used(BROWSER_SLOTS, b.runNodes);
  const desktopCreds = used(DESKTOP_SLOTS, b.desktopRunNodes);
  const picked = [...new Set([...browserCreds.picked, ...desktopCreds.picked])];
  const secretLine = b.secretVariables.size
    ? `- ${SECRET_VARIABLES}, holding ${[...b.secretVariables].slice(0, 10).map((v) => code(v, 60)).join(', ')}: pick it on the Run steps that name them, and list where its values may be typed (the app or the site) in its May Be Typed Into.`
    : '';
  const toPick = [
    browserCreds.missing.length ? `- ${and(browserCreds.missing.map((l) => `**${l}**`))}: ${listed(b.runNodes)}` : '',
    desktopCreds.missing.length ? `- ${and(desktopCreds.missing.map((l) => `**${l}**`))}: ${listed(b.desktopRunNodes)}` : '',
    b.credentials && !b.desktopRunNodes.length ? '- UiPath credential lookups (green notes in the flow): the RPA Site Login on Run steps holds that login' : '',
    b.credentials && b.desktopRunNodes.length ? `- UiPath credential lookups (green notes in the flow): desktop steps type the sign-in from their Run steps' Variables (a password from ${SECRET_VARIABLES}); browser steps use the RPA Site Login on their Run steps` : '',
    b.s3Nodes.length ? `- **AWS**: ${listed(b.s3Nodes)}` : '',
    b.emailNodes.length ? `- **SMTP**: ${listed(b.emailNodes)}` : '',
    b.httpNodes.length ? `- HTTP authentication, if the endpoint needs it: ${listed(b.httpNodes)}` : '',
  ].filter(Boolean);
  const onNodes = b.allRuns.length === 1 ? 'the RPA node' : 'the RPA nodes';
  const setOnce = [
    '### Set once',
    toPick.length
      ? ['No secret is in this file. Pick these on the nodes:', ...toPick, picked.length ? `- Already set on ${onNodes}: ${and(picked.map((l) => `**${l}**`))}` : ''].filter(Boolean).join('\n')
      : picked.length ? `Nothing to pick: ${and(picked.map((l) => `**${l}**`))} ${picked.length === 1 ? 'is' : 'are'} set on ${onNodes}.` : 'Nothing to pick.',
    secretLine,
  ].filter(Boolean).join('\n');
  const aboutAt = noteSize(about, 460);
  const setAt = noteSize(setOnce, 440);
  const top = highest - Math.max(aboutAt.height, setAt.height) - 60;
  const before = b.nodes.length;
  b.sticky('About this import', about, COLOUR.grey, [-80, top], aboutAt.width, aboutAt.height, true);
  b.sticky('Set once', setOnce, COLOUR.green, [400, top], setAt.width, setAt.height, true);
  // The two stickies first, as in the templates.
  b.nodes.unshift(...b.nodes.splice(before));

  return {
    name: `${project} (${from.workflow})`,
    description: `Imported from ${from.origin} ${project}: ${summary}.`,
    nodes: b.nodes,
    connections: b.connections,
    settings: { executionOrder: 'v1' },
    pinData: {},
  };
}

/** The workflow as the Data output's binary `workflow`: `<name>.workflow.json`, application/json, and the workflow's name. */
export function workflowFile(flow: UiPathFlow, drafts: Draft[], opts: BuildWorkflowOptions): { data: Buffer; fileName: string; mimeType: 'application/json'; name: string } {
  const json = buildWorkflow(flow, drafts, opts);
  const base = opts.name.replace(/[^\w.\- ]+/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 120) || 'import';
  return { data: Buffer.from(JSON.stringify(json, null, 2), 'utf8'), fileName: `${base}.workflow.json`, mimeType: 'application/json', name: json.name };
}
