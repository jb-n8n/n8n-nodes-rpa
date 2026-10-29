// A UiPath import's flow as an n8n workflow, delivered as JSON for n8n's "Import from file".
// Each browser sequence n becomes Get active steps (playwright_steps, name <name>-n) feeding Run steps with signed steps
// required and AI Repair on, as in template 2: its own Chat model and its Repaired Steps output into its own
// Approve steps, whose workflow the user picks. Each desktop sequence n becomes Get active steps feeding a Run steps on
// the RPA Desktop Runner credential (named by type, no secret), with signed steps required, AI Repair off (desktop steps
// have none yet) and the variables its steps type, empty for the user to fill in (secrets from a secret source). Everything else follows a fixed table of n8n 2.41 node types. Text from the project is
// never evaluated: it goes into literal parameters only when n8n cannot read it as an expression, and otherwise into
// notes and stickies as text. No credential is attached and no secret is written: credentials are named in stickies.
import type { DesktopDraft, Draft, FlowNode, UiPathFlow } from 'n8n-rpa-engine';
import { RPA_NODE_TYPE } from '../node-type.js';

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
  /** A credential named by type and display name only: no id, no secret. n8n selects it when one credential has the name. */
  credentials?: Record<string, { id: null; name: string }>;
}
export type ConnectionType = 'main' | 'ai_languageModel';
export interface WorkflowConnection { node: string; type: ConnectionType; index: number }
export interface WorkflowJson {
  name: string;
  description: string;
  nodes: WorkflowNode[];
  connections: Record<string, Partial<Record<ConnectionType, WorkflowConnection[][]>>>;
  settings: { executionOrder: 'v1' };
  pinData: Record<string, never>;
}
export interface BuildWorkflowOptions {
  /** The import's Name: draft n is named `<name>-n`. Used as a literal, so it must not start with "=". */
  name: string;
  /** The import's desktop drafts (ImportResult.desktopDrafts), named like the browser drafts. */
  desktopDrafts?: DesktopDraft[];
}

/** The credential a desktop Run steps names, by type (CREDENTIALS.desktopRunner) and display name. */
const DESKTOP_RUNNER_CREDENTIAL = { rpaDesktopRunnerApi: { id: null, name: 'RPA Desktop Runner' } };

/** Node types and the versions used, each checked against n8n's nodes-base (and nodes-langchain) at tag n8n@2.41.0. */
const T = {
  manualTrigger: ['n8n-nodes-base.manualTrigger', 1],
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
  chatModel: ['@n8n/n8n-nodes-langchain.lmChatAnthropic', 1.5],
  executeWorkflow: ['n8n-nodes-base.executeWorkflow', 1.2],
} as const satisfies Record<string, readonly [string, number]>;

const STEPS_TABLE = 'playwright_steps';
const COLOUR = { green: 4, gold: 2, grey: 7 } as const;
/** Horizontal distance between columns, and the vertical distance of an If branch per level of nesting below it. */
const STEP = 240;
const BRANCH = 200;
const HTTP_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const MAX_NAME = 95;
const APPROVE_WORKFLOW = 'RPA: 3 Approve steps';
/** The nodes one browser pair draws: Get active steps, Run steps, its Chat model, its Approve steps and their sticky. */
const PAIR_NODES = 5;
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
/** A literal parameter value, unless it could be or become an expression (a leading "=", or "{{" anywhere): then none. */
const literal = (v: string | undefined): string | undefined => (v !== undefined && v !== '' && !v.startsWith('=') && !v.includes('{{') ? v : undefined);
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
  readonly chatNodes: string[] = [];
  readonly approveNodes: string[] = [];
  readonly draftNames: string[] = [];
  readonly desktopRunNodes: string[] = [];
  readonly desktopDraftNames: string[] = [];
  credentials = 0;
  others = 0;
  untranslated = 0;
  /**
   * The binary property the imported draft gives its download, while that Run steps' item is what flows on: set by a
   * browser pair, kept by nodes that pass items through (Wait, If, stickies), cleared by every other node.
   */
  private lastFile: string | undefined;

  /** Activities not drawn because the workflow reached MAX_WORKFLOW_NODES. */
  skipped = 0;
  /** Set when the first activity does not fit: everything after it is counted too, so nothing is drawn out of order. */
  private full = false;
  /** Each If and For Each's depth and whether a browser pair is inside it, worked out once: every If above asks. */
  private readonly depths = new Map<FlowNode, number>();
  private readonly browsers = new Map<FlowNode, boolean>();

  constructor(private readonly prefix: string, private readonly drafts: Map<string, Draft>, private readonly desktopDrafts: Map<string, DesktopDraft> = new Map()) {}

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
  private hasBrowser(lists: FlowNode[][]): boolean {
    return lists.some((list) => list.some((n) => {
      if (n.kind === 'browser') return this.drafts.has(`${this.prefix}-${n.sequence}`);
      if (n.kind === 'desktop') return this.desktopDrafts.has(`${this.prefix}-${n.sequence}`);
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
    this.add(T.sticky, reserved ? name : this.unique(name), position, { content, height, width, color });
  }
  connect(tails: Tail[], to: string, type: ConnectionType = 'main'): void {
    for (const t of tails) {
      const outputs = ((this.connections[t.node] ??= {})[type] ??= []);
      while (outputs.length <= t.output) outputs.push([]);
      outputs[t.output].push({ node: to, type, index: 0 });
    }
  }
  /** The nodes a flow node draws itself, its If or loop body aside. */
  private cost(n: FlowNode): number {
    if (n.kind === 'browser') return this.drafts.has(`${this.prefix}-${n.sequence}`) ? PAIR_NODES : 1;
    if (n.kind === 'desktop') return this.desktopDrafts.has(`${this.prefix}-${n.sequence}`) ? DESKTOP_PAIR_NODES : 1;
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

  /** Draws the list; once the workflow has MAX_WORKFLOW_NODES nodes, the rest is only counted (see `overflow`). */
  walk(list: FlowNode[], tails: Tail[], x: number, y: number): Walked {
    let at: Walked = { tails, x };
    for (const n of list) {
      if (!this.full && this.nodes.length + this.cost(n) > MAX_WORKFLOW_NODES) this.full = true;
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

  /**
   * A desktop sequence: Get active steps → Run steps on the RPA Desktop Runner credential (by type), signed steps
   * required, AI Repair off, the draft's variables empty for the user (secret ones noted), and a gold sticky saying what
   * to fill in and how the steps get approved. A sequence without a draft is a grey sticky.
   */
  private desktopPair(n: Extract<FlowNode, { kind: 'desktop' }>, tails: Tail[], x: number, y: number): Walked {
    const draftName = `${this.prefix}-${n.sequence}`;
    const draft = this.desktopDrafts.get(draftName);
    if (!draft) {
      this.lastFile = undefined;
      return this.untranslatedSticky(tails, x, y, n.displayName, 'Desktop steps', `no draft named ${draftName} was built, so there are no steps to run`);
    }
    this.desktopDraftNames.push(draftName);
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
    const run = this.nodeName(n.displayName, `Run steps (${draftName})`);
    const runX = x + STEP;
    const secret = new Set(draft.secretVariables);
    const variables = draft.variables.map((name) => ({ name, value: '' }));
    this.add(T.rpa, run, [runX, y], {
      operation: 'runSteps',
      steps: "={{ $json.steps ?? '' }}",
      requireSignedSteps: true,
      signature: '={{ $json.signature }}',
      approvedBy: '={{ $json.approvedBy }}',
      aiRepair: false,
      options: { name: draftName, expectedVersion: '={{ $json.version }}', ...(variables.length ? { variables: { values: variables } } : {}) },
    }, {
      credentials: { ...DESKTOP_RUNNER_CREDENTIAL },
      notes: `Runs the signed desktop steps ${draftName} (${plural(draft.script.steps.length, 'step')} imported from UiPath "${line(n.displayName, 120)}") on the desktop runner. Pick the RPA Desktop Runner and RPA Step Signing credentials. Fill in the Variables${secret.size ? `; ${[...secret].join(', ')} must come from a secret source` : ''}.`,
    });
    this.connect([{ node: get, output: 0 }], run);
    this.desktopRunNodes.push(run);
    const listedVars = draft.variables.length
      ? draft.variables.map((v) => (secret.has(v) ? `**${code(v, 60)}** (a secret: map it from a secret source, such as an n8n external secret or a node that reads your vault; never type it here)` : code(v, 60))).join(', ')
      : 'none';
    const writes = draft.writeCandidates.length ? ` The import lists steps ${draft.writeCandidates.join(', ')} as candidate writes: when you approve, list in **Write Steps** the ones that save, post or submit.` : '';
    this.sticky(`Fill in the variables (${draftName})`,
      `### Fill in the variables (gold)\nOn **${md(run)}**, Options → Variables: ${listedVars}. Desktop steps are approved before they run: import the project with **RPA: 5 Import a bot** and approve ${code(draftName)} in **${APPROVE_WORKFLOW}**.${writes}`,
      COLOUR.gold, [runX - 80, y + 160], 320, 260);
    this.lastFile = downloadProperty(draft);
    return { tails: [{ node: run, output: 0 }], x: x + 2 * STEP };
  }

  private one(n: FlowNode, tails: Tail[], x: number, y: number): Walked {
    switch (n.kind) {
      case 'browser': {
        const draftName = `${this.prefix}-${n.sequence}`;
        const draft = this.drafts.get(draftName);
        if (!draft) {
          this.lastFile = undefined;
          return this.untranslatedSticky(tails, x, y, n.displayName, 'Browser steps', `no draft named ${draftName} was built, so there are no steps to run`);
        }
        this.draftNames.push(draftName);
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
        const run = this.nodeName(n.displayName, `Run steps (${draftName})`);
        const chat = this.unique(`Chat model (${draftName})`);
        const approve = this.unique(`Approve steps (${draftName})`);
        const runX = x + STEP;
        // The draft name comes from the import's Name, which may hold "{{": then the Goal names no draft.
        const goal = literal(`Do what the imported steps do: ${draftName}`) ?? 'Do what the imported steps do.';
        this.add(T.rpa, run, [runX, y], {
          operation: 'runSteps',
          steps: "={{ $json.steps ?? '' }}",
          requireSignedSteps: true,
          signature: '={{ $json.signature }}',
          approvedBy: '={{ $json.approvedBy }}',
          aiRepair: true,
          goal,
          options: { name: draftName, expectedVersion: '={{ $json.version }}' },
        }, {
          notes: `Runs the signed steps ${draftName} (${plural(draft.script.steps.length, 'step')} imported from UiPath "${line(n.displayName, 120)}"). Pick RPA Browser, RPA Site Login and RPA Step Signing here. AI Repair is on: rewrite the Goal in plain words (what the data is), pick a credential on ${chat}, and repaired steps go to ${approve}.`,
        });
        this.connect([{ node: get, output: 0 }], run);
        this.runNodes.push(run);
        // Below Run steps and left of the next column, where an If's or an inline sticky starts (x - 60, x - 40). The two labels sit
        // side by side (centres 210 apart) and the sticky starts below them (a node is 100 high, its label about 40 more).
        this.add(T.chatModel, chat, [runX - 80, y + 160], { model: { __rl: true, mode: 'id', value: 'claude-sonnet-5-5' }, options: {} });
        this.connect([{ node: chat, output: 0 }], run, 'ai_languageModel');
        this.chatNodes.push(chat);
        this.add(T.executeWorkflow, approve, [runX + 130, y + 160], {
          source: 'database',
          workflowId: { __rl: true, mode: 'list', value: '', cachedResultName: APPROVE_WORKFLOW },
          mode: 'once',
          options: { waitForSubWorkflow: false },
        }, { notes: `Pick the workflow ${APPROVE_WORKFLOW}. Fire and forget: the approval waits for a person; this run finishes now.` });
        this.connect([{ node: run, output: 1 }], approve);
        this.approveNodes.push(approve);
        this.sticky(`Pick ${APPROVE_WORKFLOW} (${draftName})`,
          `### Pick the approval workflow (gold)\nIn **${md(approve)}**, pick **${APPROVE_WORKFLOW}**: repaired steps wait there for a person.`,
          COLOUR.gold, [runX - 80, y + 320], 300, 100);
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
          // A browser pair's Chat model, Approve steps and sticky reach 420 below its row.
          COLOUR.grey, [x - 60, y - 160 - BRANCH * d], end - x, 330 + 2 * BRANCH * d + (this.hasBrowser([n.body]) ? 270 : 0));
        return { tails: body.tails, x: end };
      }
      case 'credential':
        this.credentials += 1;
        // Desktop steps refuse a Site Login: they type the sign-in from their Run steps' Variables.
        if (this.desktopDrafts.size > 0) {
          const browser = this.drafts.size > 0 ? ' Browser steps: pick an RPA Site Login on their Run steps; the Site Login holds the login.' : '';
          return this.inline(tails, x, y, `Credential: ${line(n.asset, 80) || 'UiPath'}`,
            `### UiPath credential (green)\nUiPath credential ${code(n.asset, 120)}: n8n never copies a UiPath credential. Desktop steps type the user name and password from their Run steps' **Variables** (see the gold notes): supply the password from a secret source, never as text in this workflow.${browser}`, COLOUR.green);
        }
        return this.inline(tails, x, y, `Credential: ${line(n.asset, 80) || 'UiPath'}`,
          `### UiPath credential (green)\nUiPath credential ${code(n.asset, 120)}: pick an RPA Site Login on the Run steps node(s). n8n never copies a UiPath credential; the Site Login holds the login.`, COLOUR.green);
      case 'untranslated':
        return this.untranslatedSticky(tails, x, y, n.displayName, n.activity, n.note);
    }
  }
}

/** Up to five names in bold, then how many more. */
function listed(names: string[]): string {
  const shown = names.slice(0, 5).map((n) => `**${md(n, 100)}**`).join(', ');
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}

/**
 * The n8n workflow for a UiPath import's flow. `drafts` are the import's drafts, named `<opts.name>-<n>`. Throws
 * only when opts.name cannot be used as a literal name (empty, or starting with "=").
 */
export function buildWorkflow(flow: UiPathFlow, drafts: Draft[], opts: BuildWorkflowOptions): WorkflowJson {
  if (opts.name.trim() === '' || opts.name.startsWith('=')) throw new Error('The Name must not be empty or start with "="');
  const b = new Builder(opts.name, new Map(drafts.map((d) => [d.name, d])), new Map((opts.desktopDrafts ?? []).map((d) => [d.name, d])));
  b.add(T.manualTrigger, b.unique('Run the bot'), [0, 0], {});
  b.reserve('About this import', 'Set once');
  b.overflow(b.walk(flow.nodes, [{ node: 'Run the bot', output: 0 }], STEP, 0));

  const project = line(flow.name, 120).replace(/^=+/, '').trim() || opts.name;
  const desktopPart = b.desktopDraftNames.length ? ` and ${plural(b.desktopDraftNames.length, 'desktop sequence')}` : '';
  const summary = `${plural(b.draftNames.length, 'browser sequence')}${desktopPart} as signed RPA steps, ${plural(b.others, 'other activity', 'other activities')} as n8n nodes, ${b.untranslated} not translated${b.skipped ? `, ${b.skipped.toLocaleString('en-US')} more not drawn (see the report)` : ''}`;
  // A loop, not Math.min(...positions): spreading a long array into arguments overflows the stack.
  let highest = 0;
  for (const n of b.nodes) highest = Math.min(highest, n.position[1]);
  const top = highest - 420;
  const about = [
    '### About this import (grey: leave as is)',
    `Imported from the UiPath project ${code(project, 120)}: ${summary}.`,
    b.draftNames.length
      ? `Each browser sequence is **Get active steps** → **Run steps**. AI Repair is on: when a page no longer matches, the Run steps' **Chat model** repairs the run and its Repaired Steps output goes to **Approve steps**. Run steps runs only the newest signed, active version of its steps (${b.draftNames.slice(0, 3).map((d) => code(d)).join(', ')}${b.draftNames.length > 3 ? ', …' : ''}) from ${STEPS_TABLE}. Run **Import steps** on the project (template **RPA: 5 Import a bot**) and approve each Repaired steps item in **RPA: 3 Approve steps**; until a version is approved, Run steps stops with "Steps is empty".`
      : '',
    b.desktopDraftNames.length
      ? `Each desktop sequence is **Get active steps** → **Run steps** on the **RPA Desktop Runner**: it runs only the newest signed, active version of its steps (${b.desktopDraftNames.slice(0, 3).map((d) => code(d)).join(', ')}${b.desktopDraftNames.length > 3 ? ', …' : ''}) from ${STEPS_TABLE}. Desktop steps are not replayed at import and have no AI repair yet: approve them in **${APPROVE_WORKFLOW}**, listing the steps that save, post or submit in Write Steps.`
      : '',
    'Grey notes: not translated, rebuild by hand. Gold: fill in. Green: set once. UiPath expressions are kept as text in notes; nothing from the project runs as an n8n expression.',
  ].filter(Boolean).join('\n\n');
  const setOnce = [
    '### Set once (green)',
    'No credential is stored in this file. Pick them on the nodes:',
    b.runNodes.length ? `- **RPA Browser**, **RPA Site Login** and **RPA Step Signing**: ${listed(b.runNodes)}` : '',
    b.desktopRunNodes.length ? `- **RPA Desktop Runner** and **RPA Step Signing**: ${listed(b.desktopRunNodes)}` : '',
    b.chatNodes.length ? `- **Chat model** (your model provider): ${listed(b.chatNodes)}` : '',
    b.credentials && !b.desktopRunNodes.length ? '- UiPath credential lookups (green notes in the flow): the RPA Site Login on Run steps holds that login' : '',
    b.credentials && b.desktopRunNodes.length ? '- UiPath credential lookups (green notes in the flow): desktop steps type the sign-in from their Run steps\' Variables (a password from a secret source); browser steps use the RPA Site Login on their Run steps' : '',
    b.s3Nodes.length ? `- **AWS**: ${listed(b.s3Nodes)}` : '',
    b.emailNodes.length ? `- **SMTP**: ${listed(b.emailNodes)}` : '',
    b.httpNodes.length ? `- HTTP authentication, if the endpoint needs it: ${listed(b.httpNodes)}` : '',
    b.approveNodes.length ? `\n${listed(b.approveNodes)}: choose **${APPROVE_WORKFLOW}**.` : '',
  ].filter(Boolean).join('\n');
  const before = b.nodes.length;
  b.sticky('About this import', about, COLOUR.grey, [-80, top], 460, 360, true);
  b.sticky('Set once', setOnce, COLOUR.green, [400, top], 440, 360, true);
  // The two stickies first, as in the templates.
  b.nodes.unshift(...b.nodes.splice(before));

  return {
    name: `${project} (imported from UiPath)`,
    description: `Imported from the UiPath project ${project}: ${summary}.`,
    nodes: b.nodes,
    connections: b.connections,
    settings: { executionOrder: 'v1' },
    pinData: {},
  };
}

/** The workflow as the Data output's binary `workflow`: `<name>.workflow.json`, application/json. */
export function workflowFile(flow: UiPathFlow, drafts: Draft[], opts: BuildWorkflowOptions): { data: Buffer; fileName: string; mimeType: 'application/json' } {
  const json = buildWorkflow(flow, drafts, opts);
  const base = opts.name.replace(/[^\w.\- ]+/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 120) || 'import';
  return { data: Buffer.from(JSON.stringify(json, null, 2), 'utf8'), fileName: `${base}.workflow.json`, mimeType: 'application/json' };
}
