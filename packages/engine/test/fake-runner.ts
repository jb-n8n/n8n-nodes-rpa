// An in-process desktop runner for tests: a TLS WebSocket server speaking protocol 1 (JSON-RPC 2.0) over an in-memory
// UI tree of a demo app: by default a small order search ("orders": sign-in form, order search, results grid, export
// through a Save As dialog that writes a CSV into the run's export directory); with `app: 'erp'`, a model of the real
// ERP Demo in desktop/erp-demo, v1 or v2 (its window titles, automation ids, menus and drop-downs, dialogs, line items
// and CSV, as the real runner showed them on windows-latest); with `app: 'authenticator'`, a desktop authenticator app
// built on a web view, whose content lives in a helper process (msedgewebview2.exe) and whose codes are only available
// through each entry's "Copy (<name>)" button and the clipboard. It enforces the runner's floor as the real one does: bearer
// token on the upgrade, one run at a time with a lease, allowed apps, declared write controls and gated keys,
// repair-mode limits, helper processes, the policy-gated clipboard.read (only the run's own fresh copy), export
// directory confinement, and the
// protocol's error codes. Targets resolve as the runner's
// TargetResolver does: across every run window the window selector matches, each element counted once. Error messages
// never contain typed values (unless a test turns on `echoTypedInErrors`, to prove the engine masks them anyway).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import { acceptKey, encodeFrame, FrameReader, OPCODE } from '../src/desktop/ws.js';
import { RUNNER_ERROR_CODES as E, type RunnerNode, type RunnerTarget, type Segment } from '../src/desktop/protocol.js';
import type { UiaCond, WindowSel } from '../src/types.js';
import { selfSignedCert } from './fake-runner-cert.js';

export const RUNNER_TOKEN = 'tok-5d8e3a71';
export const DEMO_EXE = 'ErpDemo.exe';
export const DEMO_USER = 'ops.bot';
export const DEMO_PASSWORD = 'Demo-pw-22';

export interface FakePolicy {
  allowedApps: { exe: string }[];
  writeControls: { exe: string; automationId: string }[];
  gatedKeys: string[];
  maxFileBytes: number;
  /** RunnerPolicy.HelperProcesses: a helper's elements count only while it descends from the app (the fake does not model paths). */
  helperProcesses?: { exe: string; pathPattern: string }[];
  /** RunnerPolicy.ClipboardRead (default false). */
  clipboardRead?: boolean;
}
export const DEMO_POLICY: FakePolicy = {
  allowedApps: [{ exe: DEMO_EXE }],
  writeControls: [{ exe: DEMO_EXE, automationId: 'btnPost' }],
  gatedKeys: ['Ctrl+S', 'F11'],
  maxFileBytes: 20 * 1024 * 1024,
};

/** RunnerService.MaxClipboardChars: longer clipboard text is refused. */
export const MAX_CLIPBOARD_CHARS = 1000;
/** RunnerService.ClipboardFreshness: clipboard.read only this long after the run's most recent act finished. */
export const CLIPBOARD_FRESHNESS_MS = 10_000;
/** The runner's ceiling for one file.retrieve answer (RunnerPolicy.MaxFileBytesCeiling). */
export const RUNNER_MAX_FILE_BYTES = 36 * 1024 * 1024;
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
/** RunnerService.RepairRefusal: a repair-mode action or key the floor never allows. */
const REPAIR_REFUSAL = 'policy_refused: repair mode allows only focus, expand, read, Escape without a target, and click on tabs, list items and tree items';
const REPAIR_ACTIONS = ['focus', 'expand', 'read', 'click', 'key'];
const REPAIR_CLICKABLE = ['TabItem', 'ListItem', 'TreeItem'];

/** A key chord as the runner reads it (KeyChord.Parse): modifier flags in any order and spelling, then the key. */
interface Chord { ctrl: boolean; alt: boolean; shift: boolean; win: boolean; key: string }
const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', space: 'Space', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown', up: 'Up', down: 'Down',
  left: 'Left', right: 'Right', apps: 'Apps', menu: 'Apps',
};
function parseChord(text: string): Chord {
  const parts = text.split('+').map((x) => x.trim());
  if (!text.trim() || parts.some((x) => !x)) throw new RpcError(INVALID_PARAMS, 'invalid params: key chord is not of the form Ctrl+Shift+Key');
  const c: Chord = { ctrl: false, alt: false, shift: false, win: false, key: '' };
  parts.forEach((part, i) => {
    const m = ({ ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', win: 'win', meta: 'win', windows: 'win' } as const)[part.toLowerCase() as 'ctrl'];
    if (!m) {
      if (i < parts.length - 1) throw new RpcError(INVALID_PARAMS, 'invalid params: key chord has an unknown modifier');
      const key = KEY_ALIASES[part.toLowerCase()] ?? (/^[A-Za-z0-9]$/.test(part) ? part.toUpperCase() : /^[Ff]([1-9]|1[0-9]|2[0-4])$/.test(part) ? part.toUpperCase() : undefined);
      if (!key) throw new RpcError(INVALID_PARAMS, 'invalid params: key chord names an unknown key');
      c.key = key;
      return;
    }
    if (c[m]) throw new RpcError(INVALID_PARAMS, 'invalid params: key chord names a modifier twice');
    c[m] = true;
  });
  return c;
}
const chordText = (c: Chord) => [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.win && 'Win', c.key].filter(Boolean).join('+');
/** RunnerService.IsSystemChord: anything with Win, Ctrl+Esc, Ctrl+Shift+Esc, Alt+Tab, Alt+Shift+Tab, Alt+Esc. */
const isSystemChord = (c: Chord) => c.win || (c.ctrl && c.key === 'Escape') || (c.alt && (c.key === 'Tab' || c.key === 'Escape'));
/** RunnerService.IsNavigationKey: Tab, Shift+Tab, arrows, Home, End, PageUp, PageDown, Escape, no other modifier. */
const isNavigationKey = (c: Chord) => !c.ctrl && !c.alt && !c.win
  && (c.key === 'Tab' || (!c.shift && ['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape'].includes(c.key)));
/** An optional integer param in [min, max], or -32602 as the runner answers (Params.OptLong). */
function optInt(p: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const v = p[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new RpcError(INVALID_PARAMS, `invalid params: ${name} must be an integer`);
  if (v < min || v > max) throw new RpcError(INVALID_PARAMS, `invalid params: ${name} must be between ${min} and ${max}`);
  return v;
}

class RpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

interface El {
  controlType: string;
  name: string;
  automationId: string;
  className: string;
  enabled: boolean;
  visible: boolean;
  value?: string;
  isPassword?: boolean;
  items?: string[];
  children: El[];
  /**
   * The process hosting the element when it is not the app's own: a helper process (a web view's browser process)
   * that the app started, or one that some other program started.
   */
  host?: 'helper' | 'otherHelper';
  onClick?: () => void;
  /** Runs after `type` set the value. */
  onType?: () => void;
  /** What ExpandCollapse.Expand does; an element without it (and not a ComboBox) cannot expand. */
  onExpand?: () => void;
}
/** A top-level window. `onCancel`: what Escape does to it (a form's CancelButton, a dialog's IDCANCEL). */
interface Win { title: string; exe: string; automationId: string; className: string; root: El; owner?: Win; onCancel?: () => void }

const el = (controlType: string, automationId: string, name: string, more: Partial<El> = {}): El => ({
  controlType, automationId, name, className: '', enabled: true, visible: true, children: [], ...more,
});

const ORDERS = [
  ['ORD-1001', 'ACME', 'Open', '120.00'],
  ['ORD-1002', 'ACME', 'Closed', '75.50'],
  ['ORD-1003', 'Globex', 'Open', '300.00'],
];

/** What the runner needs of an app model: its windows (back to front, so the front-most last) and what tests look at. */
export interface AppModel {
  windows: Win[];
  /** The window holding the foreground (the front-most one, unless the app says otherwise). */
  readonly foreground: Win;
  results: string[][];
  signInFailures: number;
  posted: number;
  /** Called before an action on a resolved target (a click elsewhere closes an open menu). */
  beforeAct?(e: El, action: string): void;
  /** A key the app handles itself (Escape, menu mode) on the window that receives it; true when handled. */
  onKey?(chord: Chord, win: Win): boolean;
}

/** The demo app's windows and behaviour. */
class DemoApp implements AppModel {
  windows: Win[] = [];
  results: string[][] = [];
  signInFailures = 0;
  posted = 0;

  constructor(private readonly exportDir: () => string | undefined) {
    this.windows = [this.signInWindow()];
  }

  get foreground(): Win {
    return this.windows[this.windows.length - 1];
  }

  private signInWindow(): Win {
    const user = el('Edit', 'txtUser', 'User name');
    const password = el('Edit', 'txtPassword', 'Password', { isPassword: true });
    const error = el('Text', 'lblError', 'Wrong user name or password', { visible: false });
    const button = el('Button', 'btnSignIn', 'Sign in', {
      onClick: () => {
        if (user.value === DEMO_USER && password.value === DEMO_PASSWORD) this.windows = [this.mainWindow()];
        else { error.visible = true; this.signInFailures++; }
      },
    });
    return { title: 'ERP Demo - Sign in', exe: DEMO_EXE, automationId: 'frmSignIn', className: 'WindowsForms10.Window', root: el('Window', 'frmSignIn', 'ERP Demo - Sign in', { children: [user, password, button, error] }) };
  }

  private mainWindow(): Win {
    const search = el('Edit', 'txtSearch', 'Search');
    const grid = el('DataGrid', 'gridResults', 'Results');
    const count = el('Text', 'lblCount', '');
    const openOnly = el('CheckBox', 'chkOpenOnly', 'Open orders only', { value: 'Off' });
    const status = el('ComboBox', 'cmbStatus', 'Status', { value: 'All', items: ['All', 'Open', 'Closed'] });
    const run = () => {
      const q = (search.value ?? '').toLowerCase();
      this.results = ORDERS.filter((o) => o[1].toLowerCase().includes(q) && (openOnly.value !== 'On' || o[2] === 'Open') && (status.value === 'All' || o[2] === status.value));
      grid.children = this.results.map((o, i) => el('DataItem', `row${i}`, o[0], {
        children: o.map((cell, j) => el('Text', `cell${i}_${j}`, cell)),
      }));
      count.name = `${this.results.length} results`;
    };
    const searchButton = el('Button', 'btnSearch', 'Search', { onClick: run });
    const exportButton = el('Button', 'btnExport', 'Export', { onClick: () => this.windows.push(this.saveDialog()) });
    const post = el('Button', 'btnPost', 'Post', { onClick: () => { this.posted++; } });
    const tabs = el('Tab', 'tabs', 'Views', { children: [el('TabItem', 'tabOrders', 'Orders'), el('TabItem', 'tabCustomers', 'Customers')] });
    (search as El & { onEnter?: () => void }).onEnter = run;
    return {
      title: 'ERP Demo - Orders', exe: DEMO_EXE, automationId: 'frmMain', className: 'WindowsForms10.Window',
      root: el('Window', 'frmMain', 'ERP Demo - Orders', { children: [tabs, search, searchButton, openOnly, status, count, grid, exportButton, post] }),
    };
  }

  private saveDialog(): Win {
    const file = el('Edit', '1001', 'File name:');
    const owner = this.foreground;
    const save = el('Button', '1', 'Save', {
      onClick: () => {
        const typed = file.value ?? '';
        const cut = Math.max(typed.lastIndexOf('\\'), typed.lastIndexOf('/'));
        const dir = cut >= 0 ? typed.slice(0, cut) : '';
        const name = typed.slice(cut + 1);
        const exportDir = this.exportDir();
        // The app saves where it is told; only a file in the export directory can be retrieved.
        if (exportDir && dir === exportDir && name) {
          const csv = ['Order,Customer,Status,Amount', ...this.results.map((r) => r.join(','))].join('\n') + '\n';
          writeFileSync(join(exportDir, name), csv);
        }
        this.windows = this.windows.filter((w) => w.title !== 'Save As');
      },
    });
    return { title: 'Save As', exe: DEMO_EXE, automationId: '', className: '#32770', owner, root: el('Window', '', 'Save As', { children: [file, save] }) };
  }
}

function descendants(e: El): El[] {
  return e.children.flatMap((c) => [c, ...descendants(c)]);
}
const condMatches = (e: El, c: UiaCond) =>
  (c.controlType === undefined || e.controlType === c.controlType) && (c.automationId === undefined || e.automationId === c.automationId)
  && (c.name === undefined || e.name === c.name) && (c.className === undefined || e.className === c.className);
const winMatches = (w: Win, s: WindowSel) =>
  (s.exe === undefined || w.exe.toLowerCase() === s.exe.toLowerCase()) && (s.title === undefined || w.title === s.title)
  && (s.titlePattern === undefined || new RegExp(s.titlePattern).test(w.title)) && (s.automationId === undefined || w.automationId === s.automationId)
  && (s.className === undefined || w.className === s.className);

/** A window selector as the runner describes it (WindowSel.ToString). */
function describeWindow(s: WindowSel): string {
  const fields: [string, string | undefined][] = [['exe', s.exe], ['title', s.title], ['titlePattern', s.titlePattern], ['automationId', s.automationId], ['className', s.className]];
  return `{${fields.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}="${v!.length > 80 ? `${v!.slice(0, 80)}...` : v}"`).join(', ')}}`;
}
/** The run's windows the selector matches (all without one), front to back, as WindowScope.RunWindows lists them. */
const frontToBack = (app: AppModel, sel?: WindowSel) => [...app.windows].reverse().filter((w) => !sel || winMatches(w, sel));

function describeTarget(t: RunnerTarget): string {
  return t.path.map((c) => [c.controlType, c.automationId && `#${c.automationId}`, c.name !== undefined && `"${c.name}"`].filter(Boolean).join(' ')).join(' > ');
}

interface Run {
  runId: string; leaseMs: number; exportDir: string; timer: NodeJS.Timeout; app?: AppModel; focus?: El;
  /** RunState.LastAct: the clipboard's sequence number before the run's most recent act, and when it finished. */
  lastAct?: { seq: number; at: number };
}

export interface FakeRunnerOptions {
  token?: string;
  policy?: FakePolicy;
  session?: { interactive: boolean; locked: boolean };
  /** A misbehaving runner that puts the last typed text into its error messages (the engine must mask it). */
  echoTypedInErrors?: boolean;
  /** Caps the TLS version (TLS 1.2: the server's handshake ends after the client's). */
  tlsMaxVersion?: 'TLSv1.2' | 'TLSv1.3';
  /** The allowed app's executable is not at its policy path (app.launch answers not_found, as the runner does). */
  appMissing?: boolean;
  /** The app model: 'orders' (default), 'erp' (the real ERP Demo's controls) or 'authenticator' (a web view app). */
  app?: 'orders' | 'erp' | 'authenticator';
  /** The ERP Demo's build: 'v1' (default) or 'v2' (= erpChanges rename, menu, confirm). app.launch args `--ui v1|v2` win over it. */
  erpUi?: 'v1' | 'v2';
  /** ERP Demo changes on top of the build, each on its own (see ErpChange). */
  erpChanges?: ErpChange[];
  /** A runner older than the `windows` method: it answers -32601. */
  noWindowsMethod?: boolean;
  /** A misbehaving app: every snapshot node's automationId and className get this many extra characters. */
  padSnapshotIds?: number;
  /** A runner older than `clipboard.read`: it answers -32601. */
  noClipboardMethod?: boolean;
  /** The authenticator's web view helper does not descend from the app (some other program started it). */
  helperOutsideRun?: boolean;
}

export interface Received { method: string; params: Record<string, unknown> }

/** The fake runner. `start()` listens on 127.0.0.1; `url`, `fingerprint` and `token` make the credential. */
export class FakeRunner {
  readonly token: string;
  readonly fingerprint: string;
  readonly cert: ReturnType<typeof selfSignedCert>;
  policy: FakePolicy;
  session: { interactive: boolean; locked: boolean };
  echoTypedInErrors: boolean;
  appMissing: boolean;
  url = '';
  /** Every decrypted byte each connection sent, in order (index = connection). */
  readonly bytes: Buffer[][] = [];
  /** Every JSON-RPC request, in order. */
  readonly requests: Received[] = [];
  /** TCP connections accepted (before any TLS handshake). */
  tcpConnections = 0;
  /** Upgrade requests that were refused (wrong or missing token). */
  refusedUpgrades = 0;
  heartbeats = 0;
  /** Runs whose lease expired. */
  expiredRuns: string[] = [];
  /** The run holding the lock, if any. */
  run: Run | undefined;
  /** The demo app of the last run (kept after run.end for assertions). */
  lastApp: AppModel | undefined;
  /** Which app model app.launch starts. */
  readonly app: 'orders' | 'erp' | 'authenticator';
  readonly noClipboardMethod: boolean;
  readonly helperOutsideRun: boolean;
  /** The clipboard's text (the authenticator's Copy buttons set it through copy(); tests may too). */
  clipboard: string | undefined;
  /** Whose window owns the clipboard: a process of the run, another application's, or none. */
  clipboardOwner: 'run' | 'other' | undefined;
  /** GetClipboardSequenceNumber: every copy() adds one. */
  clipboardSeq = 1;
  /** What the authenticator's Copy buttons copy instead of the entry's code (a test's own text). */
  copyText: string | undefined;
  /** Runs right before clipboard.read is answered (another application copying, time passing). */
  beforeClipboardRead: (() => void) | undefined;
  /** Added to the fake's clock (Date.now()), for the clipboard's freshness. */
  clockOffsetMs = 0;
  /** Another application's window holds the foreground (clipboard.read is refused). */
  foregroundElsewhere = false;
  readonly erpUi: 'v1' | 'v2';
  readonly erpChanges: ErpChange[];
  readonly noWindowsMethod: boolean;
  readonly padSnapshotIds: number;
  lastExportDir: string | undefined;
  private lastTyped = '';
  private server: Server | undefined;
  private readonly sockets = new Set<TLSSocket>();
  private readonly exportRoot = mkdtempSync(join(tmpdir(), 'fake-runner-'));
  private readonly tlsMaxVersion: 'TLSv1.2' | 'TLSv1.3';

  constructor(opts: FakeRunnerOptions = {}) {
    this.token = opts.token ?? RUNNER_TOKEN;
    this.policy = opts.policy ?? DEMO_POLICY;
    this.session = opts.session ?? { interactive: true, locked: false };
    this.echoTypedInErrors = opts.echoTypedInErrors ?? false;
    this.appMissing = opts.appMissing ?? false;
    this.tlsMaxVersion = opts.tlsMaxVersion ?? 'TLSv1.3';
    this.app = opts.app ?? 'orders';
    this.erpUi = opts.erpUi ?? 'v1';
    this.erpChanges = opts.erpChanges ?? [];
    this.noWindowsMethod = opts.noWindowsMethod ?? false;
    this.padSnapshotIds = opts.padSnapshotIds ?? 0;
    this.noClipboardMethod = opts.noClipboardMethod ?? false;
    this.helperOutsideRun = opts.helperOutsideRun ?? false;
    this.cert = selfSignedCert();
    this.fingerprint = this.cert.fingerprint;
  }

  /** An application's copy: new text, its owner, a new sequence number. */
  copy(text: string | undefined, owner: 'run' | 'other' | undefined): void {
    this.clipboard = text;
    this.clipboardOwner = owner;
    this.clipboardSeq++;
  }

  private now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  static async start(opts: FakeRunnerOptions = {}): Promise<FakeRunner> {
    const r = new FakeRunner(opts);
    await r.listen();
    return r;
  }

  get endpoint() {
    return { url: this.url, token: this.token, fingerprint: this.fingerprint };
  }

  methods(): string[] {
    return this.requests.map((r) => r.method);
  }

  private async listen(): Promise<void> {
    this.server = createServer({ key: this.cert.key, cert: this.cert.cert, maxVersion: this.tlsMaxVersion }, (socket) => this.onConnection(socket));
    this.server.on('connection', () => { this.tcpConnections++; });
    this.server.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as { port: number };
    this.url = `wss://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    if (this.run) this.endRun();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    rmSync(this.exportRoot, { recursive: true, force: true });
  }

  /**
   * Simulates another n8n holding the runner: the lock is taken by a run nobody here owns. With `leaseMs`, that run's
   * lease runs out after it (an n8n that stopped mid-run and sends no more heartbeats).
   */
  holdLock(leaseMs?: number): void {
    const exportDir = mkdtempSync(join(this.exportRoot, 'other-'));
    this.run = { runId: 'someone-else', leaseMs: leaseMs ?? 600_000, exportDir, timer: setTimeout(() => undefined, 0) };
    if (leaseMs !== undefined) this.armLease(this.run);
  }

  /** Ends the current run as if its lease had run out. */
  expireRun(): void {
    if (!this.run) return;
    this.expiredRuns.push(this.run.runId);
    this.endRun();
  }

  /** Answers heartbeats this much later (a runner busy with a long action, answering one request at a time). */
  heartbeatDelayMs = 0;

  /** Drops every open connection (a network break). */
  dropConnections(): void {
    for (const s of this.sockets) s.destroy();
  }

  private onConnection(socket: TLSSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    const log: Buffer[] = [];
    this.bytes.push(log);
    let head = Buffer.alloc(0);
    let reader: FrameReader | undefined;
    socket.on('data', (chunk: Buffer) => {
      log.push(chunk);
      if (reader) {
        try { this.onFrames(socket, reader, chunk); } catch { socket.destroy(); }
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      const headers = new Map(lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()] as const));
      const path = lines[0].split(' ')[1];
      if (headers.get('authorization') !== `Bearer ${this.token}` || path !== '/rpa/v1') {
        this.refusedUpgrades++;
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(headers.get('sec-websocket-key') ?? '')}\r\n\r\n`);
      reader = new FrameReader(true, 1024 * 1024);
      const rest = head.subarray(end + 4);
      if (rest.length) { try { this.onFrames(socket, reader, rest); } catch { socket.destroy(); } }
    });
  }

  private onFrames(socket: TLSSocket, reader: FrameReader, chunk: Buffer): void {
    for (const f of reader.push(chunk)) {
      if (f.opcode === OPCODE.close) { socket.end(encodeFrame(OPCODE.close, Buffer.from([0x03, 0xe8]), false)); return; }
      if (f.opcode === OPCODE.ping) { socket.write(encodeFrame(OPCODE.pong, f.payload, false)); continue; }
      if (f.opcode !== OPCODE.text) continue;
      let msg: { id: number; method: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(f.payload.toString('utf8')) as typeof msg;
      } catch {
        continue; // a malformed frame fails the test that sent it, not the test process
      }
      this.requests.push({ method: msg.method, params: msg.params ?? {} });
      void this.answer(msg.method, msg.params ?? {}).then(
        (result) => ({ jsonrpc: '2.0', id: msg.id, result }),
        (err: unknown) => {
          const e = err instanceof RpcError ? err : new RpcError(-32603, 'internal error');
          return { jsonrpc: '2.0', id: msg.id, error: { code: e.code, message: this.echoTypedInErrors ? `${e.message} (last typed: ${this.lastTyped}${this.clipboard ? `; clipboard: ${this.clipboard}` : ''})` : e.message } };
        },
      ).then((reply) => { if (!socket.destroyed) socket.write(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(reply)), false)); });
    }
  }

  private requireRun(params: Record<string, unknown>): Run {
    if (!this.run || params.runId !== this.run.runId) throw new RpcError(E.no_run, 'no active run with this runId');
    if (!this.session.interactive || this.session.locked) throw new RpcError(E.desktop_unavailable, 'the workstation is locked');
    return this.run;
  }

  private endRun(): void {
    const run = this.run;
    if (!run) return;
    clearTimeout(run.timer);
    rmSync(run.exportDir, { recursive: true, force: true });
    this.run = undefined;
  }

  private armLease(run: Run): void {
    clearTimeout(run.timer);
    run.timer = setTimeout(() => { this.expiredRuns.push(run.runId); if (this.run === run) this.endRun(); }, run.leaseMs);
  }

  /**
   * WindowScope.IsRunProcess for an element: the app's own, or a helper process the policy lists that descends from the
   * app. A helper some other program started never counts.
   */
  private isRunElement(e: El): boolean {
    if (!e.host) return true;
    if (e.host === 'otherHelper' || this.helperOutsideRun) return false;
    return (this.policy.helperProcesses ?? []).some((h) => h.exe.toLowerCase() === WEBVIEW_EXE.toLowerCase());
  }

  /** `anyProcess`: TargetResolver.AnyVisible (isVisible) does not filter by process; Resolve and act do. */
  private find(run: Run, target: RunnerTarget, anyProcess = false): { el: El; win: Win; candidate: number } {
    const app = run.app;
    if (!app || app.windows.length === 0) throw new RpcError(E.not_found, `no window for ${describeTarget(target)}`);
    const tries = [target, ...(target.fallbacks ?? [])];
    let primaryCount = 0;
    for (let i = 0; i < tries.length; i++) {
      const t = tries[i];
      // Every run window the selector matches (all of them without one), front to back. An element in two of them (a
      // drop-down is also in its owner's tree) counts once.
      const wins = frontToBack(app, t.window);
      if (wins.length === 0) continue;
      let nodes: El[] = wins.map((w) => w.root);
      for (const c of t.path) {
        const found = [...new Set(nodes.flatMap((n) => descendants(n)))].filter((e) => condMatches(e, c));
        nodes = c.index !== undefined ? (found[c.index] ? [found[c.index]] : []) : found;
      }
      // Elements another process hosts inside a run window (a web view) count only when that process is the run's.
      const visible = nodes.filter((n) => n.visible && (anyProcess || this.isRunElement(n)));
      if (i === 0) primaryCount = visible.length;
      if (visible.length === 1) return { el: visible[0], win: wins.find((w) => descendants(w.root).includes(visible[0])) ?? wins[0], candidate: i };
    }
    if (primaryCount > 1) throw new RpcError(E.not_unique, `${describeTarget(target)} matches ${primaryCount} elements`);
    throw new RpcError(E.not_found, `no element matched ${describeTarget(target)} in window "${app.foreground.title}"`);
  }

  private async findWithin(run: Run, target: RunnerTarget, timeoutMs: number) {
    const until = Date.now() + Math.min(timeoutMs, 30_000);
    for (;;) {
      try {
        return this.find(run, target);
      } catch (err) {
        if (Date.now() >= until) throw err;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  /** RunnerPolicy.IsGatedKey: a gated chord also gates the same key with extra modifiers. */
  private isGatedKey(c: Chord): boolean {
    return this.policy.gatedKeys.map(parseChord).some((g) => g.key === c.key && (!g.ctrl || c.ctrl) && (!g.alt || c.alt) && (!g.shift || c.shift) && (!g.win || c.win));
  }

  /**
   * Keys can reach a write control without targeting it (Enter on a default button, an Alt mnemonic, the menu bar): while
   * any window of the run holds a declared write control, a key without write: true must be plain navigation, and only
   * Escape or Tab while a menu is open (RunnerService.Act).
   */
  private checkKeyReach(run: Run, c: Chord, write: boolean): void {
    if (write || !this.runHasWriteControl(run)) return;
    const text = chordText(c);
    if (!isNavigationKey(c)) {
      throw new RpcError(E.policy_refused, `policy_refused: the key ${text} could reach a declared write control of this run and needs write: true (only Tab, arrows, Home, End, PageUp, PageDown and Escape do not)`);
    }
    if (c.key !== 'Escape' && c.key !== 'Tab' && this.runMenuOpen(run)) {
      throw new RpcError(E.policy_refused, `policy_refused: a menu is open, so the key ${text} could reach a declared write control and needs write: true`);
    }
  }

  private runHasWriteControl(run: Run): boolean {
    return (run.app?.windows ?? []).some((w) => this.windowHasWriteControl(w));
  }

  private windowHasWriteControl(win: Win): boolean {
    return [win.root, ...descendants(win.root)].some((e) => this.isWriteControl(win, e));
  }

  /**
   * RunnerService.CheckRepairEscape: Escape fires a form's cancel button whatever has the focus, so in repair mode it is
   * refused when its window holds a declared write control, unless a popup menu of that window is open (a run window
   * that is a Menu or a #32768, other than the window, that holds the foreground or is owned by the window).
   */
  private checkRepairEscape(run: Run, win: Win): void {
    const app = run.app;
    const ownedBy = (w: Win) => {
      let owner = w.owner;
      for (let i = 0; i < 8 && owner; i++, owner = owner.owner) if (owner === win) return true;
      return false;
    };
    const popupOpen = (app?.windows ?? []).some((w) => w !== win && (w.root.controlType === 'Menu' || w.className === '#32768') && w.root.visible
      && (w === app!.foreground || ownedBy(w)));
    if (this.windowHasWriteControl(win) && !popupOpen) {
      throw new RpcError(E.policy_refused, 'policy_refused: in repair mode Escape could press a declared write control of this window (a cancel button), so it is allowed only while a menu is open');
    }
  }

  private runMenuOpen(run: Run): boolean {
    return (run.app?.windows ?? []).some((w) => w.root.controlType === 'Menu' || w.className === '#32768' || descendants(w.root).some((e) => e.controlType === 'Menu' && e.visible));
  }

  private isWriteControl(win: Win, e: El): boolean {
    return this.policy.writeControls.some((w) => w.exe.toLowerCase() === win.exe.toLowerCase() && w.automationId === e.automationId);
  }

  private async answer(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'hello':
        return { protocol: 1, runner: { version: '0.0.0-fake', os: 'Windows Server 2022 (fake)', session: { ...this.session } } };
      case 'run.begin': {
        if (!this.session.interactive || this.session.locked) throw new RpcError(E.desktop_unavailable, 'the workstation is locked');
        if (this.run) throw new RpcError(E.runner_busy, 'another run holds the runner');
        const leaseMs = p.leaseMs as number;
        if (!Number.isInteger(leaseMs) || leaseMs < 5000 || leaseMs > 600_000) throw new RpcError(-32602, 'leaseMs must be 5000..600000');
        const exportDir = mkdtempSync(join(this.exportRoot, 'export-'));
        mkdirSync(exportDir, { recursive: true });
        this.run = { runId: String(p.runId), leaseMs, exportDir, timer: setTimeout(() => undefined, 0) };
        this.lastExportDir = exportDir;
        this.armLease(this.run);
        return { exportDir };
      }
      case 'run.heartbeat': {
        const run = this.requireRun(p);
        this.heartbeats++;
        this.armLease(run);
        if (this.heartbeatDelayMs) await new Promise((r) => setTimeout(r, this.heartbeatDelayMs));
        return {};
      }
      case 'run.end':
        this.requireRun(p);
        this.endRun();
        return {};
      case 'app.launch': {
        const run = this.requireRun(p);
        const exe = String((p.app as { exe?: string })?.exe ?? '').split(/[\\/]/).pop() ?? '';
        if (!this.policy.allowedApps.some((a) => a.exe.toLowerCase() === exe.toLowerCase())) throw new RpcError(E.policy_refused, `app not allowed: ${exe}`);
        if (this.appMissing) throw new RpcError(E.not_found, `not_found: no element matched application executable "${exe}" (no matching window of the run)`);
        run.app = this.app === 'erp' ? new ErpApp(() => this.run?.exportDir, this.erpChangesFor((p.app as { args?: unknown }).args))
          // The web view copies from its helper process: the run's while the helper descends from the app.
          : this.app === 'authenticator' ? new AuthenticatorApp((text) => this.copy(this.copyText ?? text, this.helperOutsideRun ? 'other' : 'run'))
          : new DemoApp(() => this.run?.exportDir);
        this.lastApp = run.app;
        return { pid: 4242 };
      }
      case 'snapshot': {
        const run = this.requireRun(p);
        const sel = p.window as WindowSel | undefined;
        const max = optInt(p, 'maxNodes', 1, 5000) ?? 400;
        const maxDepth = optInt(p, 'maxDepth', 1, 100) ?? 25;
        // WindowScope.CurrentWindow: the foreground window without a selector, else the front-most window it matches.
        const win = sel ? (run.app ? frontToBack(run.app, sel)[0] : undefined) : run.app?.foreground;
        if (!win) {
          throw new RpcError(E.not_found, `not_found: no element matched ${sel ? `window ${describeWindow(sel)}` : 'a window of the run'} (no matching window of the run)`);
        }
        // SnapshotBuilder.Build: depth first, hidden subtrees left out; truncated once maxNodes is reached or maxDepth cuts children off.
        const nodes: RunnerNode[] = [];
        let truncated = false;
        const walk = (e: El, depth: number, root: boolean) => {
          if (nodes.length >= max) { truncated = true; return; }
          if (!root && !e.visible) return;
          nodes.push({
            ref: `r${nodes.length}`, depth, controlType: e.controlType, name: e.name, automationId: e.automationId + 'x'.repeat(this.padSnapshotIds), className: e.className + 'y'.repeat(this.padSnapshotIds), enabled: e.enabled,
            ...(e.isPassword ? (e.value ? { valueHidden: true as const } : {}) : e.value !== undefined ? { value: e.value } : {}),
          });
          if (depth >= maxDepth) { if (e.children.length > 0) truncated = true; return; }
          for (const c of e.children) {
            walk(c, depth + 1, false);
            if (nodes.length >= max) { truncated = true; return; }
          }
        };
        walk(win.root, 0, true);
        return { window: { title: win.title, exe: win.exe }, nodes, ...(truncated ? { truncated: true } : {}) };
      }
      case 'windows': {
        if (this.noWindowsMethod) throw new RpcError(METHOD_NOT_FOUND, 'method not found');
        const run = this.requireRun(p);
        // RunnerService.Windows: the foreground window first, then front to back, at most 20.
        const app = run.app;
        const all = app ? frontToBack(app) : [];
        const fg = app?.foreground;
        return {
          windows: [...all.filter((w) => w === fg), ...all.filter((w) => w !== fg)].slice(0, 20)
            .map((w) => ({ title: w.title, exe: w.exe, automationId: w.automationId, className: w.className, foreground: w === fg })),
        };
      }
      case 'isVisible': {
        const run = this.requireRun(p);
        try {
          this.find(run, p.target as RunnerTarget, true);
          return { visible: true };
        } catch (err) {
          if (err instanceof RpcError && err.code === E.not_unique) return { visible: true };
          return { visible: false };
        }
      }
      case 'resolve': {
        const run = this.requireRun(p);
        return { candidate: (await this.findWithin(run, p.target as RunnerTarget, p.timeoutMs as number)).candidate };
      }
      case 'act':
        return this.act(this.requireRun(p), p);
      case 'file.retrieve': {
        const run = this.requireRun(p);
        // The runner takes maxBytes >= 1 and caps it at its policy's maxFileBytes and its own ceiling.
        const limit = Math.min(optInt(p, 'maxBytes', 1, Number.MAX_SAFE_INTEGER) ?? this.policy.maxFileBytes, this.policy.maxFileBytes, RUNNER_MAX_FILE_BYTES);
        const re = new RegExp(String(p.pattern));
        const until = Date.now() + Math.min(p.timeoutMs as number, 30_000);
        for (;;) {
          const hit = readdirSync(run.exportDir).find((f) => re.test(f) && statSync(join(run.exportDir, f)).isFile());
          if (hit) {
            const data = readFileSync(join(run.exportDir, hit));
            if (data.length > limit) throw new RpcError(E.policy_refused, `policy_refused: the matching file is ${data.length} bytes, over the limit of ${limit} bytes`);
            return { name: hit, size: data.length, base64: data.toString('base64') };
          }
          if (Date.now() >= until) throw new RpcError(E.expected_file_missing, 'no file matching the pattern in the export directory');
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      case 'screenshot':
        this.requireRun(p);
        return { base64: '' };
      case 'clipboard.read': {
        if (this.noClipboardMethod) throw new RpcError(METHOD_NOT_FOUND, 'method not found');
        const run = this.requireRun(p);
        this.beforeClipboardRead?.();
        // RunnerService.ClipboardRead: the policy flag, then the foreground (never brought back for a read), then the
        // run's most recent act and its age, then (with the clipboard open) its owner and its sequence number, then the size.
        if (!this.policy.clipboardRead) throw new RpcError(E.policy_refused, 'policy_refused: reading the clipboard is off in the runner\'s policy (clipboardRead)');
        if (this.foregroundElsewhere || !run.app || run.app.windows.length === 0) {
          const holder = this.foregroundElsewhere ? 'a window of "notepad.exe"' : 'no window';
          throw new RpcError(E.policy_refused, `policy_refused: the clipboard is read only while a window of the run holds the foreground, and ${holder} holds it`);
        }
        const last = run.lastAct;
        if (!last) throw new RpcError(E.policy_refused, 'policy_refused: the clipboard is read only right after an act of the run copied to it, and the run has not acted yet');
        const age = this.now() - last.at;
        if (age > CLIPBOARD_FRESHNESS_MS) {
          throw new RpcError(E.policy_refused, `policy_refused: the clipboard is read only within ${CLIPBOARD_FRESHNESS_MS / 1000} seconds after the run's last act, and ${Math.floor(age / 1000)} seconds have passed`);
        }
        if (this.clipboardOwner === undefined) throw new RpcError(E.policy_refused, 'policy_refused: the clipboard is read only when a process of the run put the text there, and no window owns the clipboard');
        if (this.clipboardOwner !== 'run') throw new RpcError(E.policy_refused, 'policy_refused: the clipboard is read only when a process of the run put the text there, and a window of "KeePass.exe" owns it');
        if (this.clipboardSeq === last.seq) throw new RpcError(E.policy_refused, 'policy_refused: the clipboard has not changed since the run\'s last act, so the text is not the run\'s copy');
        const text = this.clipboard ?? '';
        if (text.length > MAX_CLIPBOARD_CHARS) throw new RpcError(E.policy_refused, `policy_refused: the clipboard holds more than ${MAX_CLIPBOARD_CHARS} characters`);
        return { text };
      }
      default:
        throw new RpcError(-32601, `unknown method ${method}`);
    }
  }

  /** The ERP Demo's changes for this launch: `--ui v1|v2` in the args, else the runner's erpUi; then erpChanges. */
  private erpChangesFor(args: unknown): Set<ErpChange> {
    const list = Array.isArray(args) ? args.map(String) : [];
    const at = list.indexOf('--ui');
    const ui = at >= 0 && (list[at + 1] === 'v1' || list[at + 1] === 'v2') ? list[at + 1] : this.erpUi;
    return new Set<ErpChange>([...(ui === 'v2' ? ERP_V2 : []), ...this.erpChanges]);
  }

  /** RunnerService.Act: every act, refused ones included, first records the clipboard's sequence number; when it ends,
   * its time. */
  private async act(run: Run, p: Record<string, unknown>): Promise<unknown> {
    const mark = { seq: this.clipboardSeq, at: this.now() };
    run.lastAct = mark;
    try {
      return await this.actOnce(run, p);
    } finally {
      run.lastAct = { ...mark, at: this.now() };
    }
  }

  private async actOnce(run: Run, p: Record<string, unknown>): Promise<unknown> {
    const action = String(p.action);
    const write = p.write === true;
    const repair = p.mode === 'repair';
    const chord = action === 'key' ? parseChord(String(p.value ?? '')) : undefined;
    // The floor checks that need no UI, in the runner's order: repair actions, shell chords, gated keys, repair keys.
    if (repair && !REPAIR_ACTIONS.includes(action)) throw new RpcError(E.policy_refused, REPAIR_REFUSAL);
    if (chord && isSystemChord(chord)) throw new RpcError(E.policy_refused, `policy_refused: the key ${chordText(chord)} reaches the Windows shell, not the app, and is never sent`);
    if (chord && this.isGatedKey(chord)) {
      if (repair) throw new RpcError(E.policy_refused, `policy_refused: the gated key ${chordText(chord)} is never allowed in repair mode`);
      if (!write) throw new RpcError(E.policy_refused, `policy_refused: the gated key ${chordText(chord)} needs write: true`);
    }
    // Repair may close a menu or dialog with Escape (to the focused element), and press no other key.
    if (repair && chord && (p.target !== undefined || chordText(chord) !== 'Escape')) throw new RpcError(E.policy_refused, REPAIR_REFUSAL);
    if (chord && p.target === undefined) {
      // A key without a target goes to the foreground run window.
      const fg = run.app?.foreground;
      if (!fg) throw new RpcError(E.not_found, 'not_found: no element matched a window of the run (no matching window of the run)');
      // RunnerService.CheckWriteControl on the focused element (the fake's focus: the last target acted on, while its
      // window still holds it).
      const focused = run.focus && (fg.root === run.focus || descendants(fg.root).includes(run.focus)) ? run.focus : undefined;
      if (focused && this.isWriteControl(fg, focused)) {
        if (repair) throw new RpcError(E.policy_refused, 'policy_refused: the target is a declared write control; repair mode never acts on it');
        if (!write) throw new RpcError(E.policy_refused, 'policy_refused: the target is a declared write control and needs write: true');
      }
      if (repair) this.checkRepairEscape(run, fg);
      this.checkKeyReach(run, chord, write);
      if (run.app?.onKey?.(chord, fg)) return {};
      if (chord.key === 'Enter' && !chord.ctrl && !chord.alt && !chord.shift) (run.focus as (El & { onEnter?: () => void }) | undefined)?.onEnter?.();
      return {};
    }
    const { el: e, win } = await this.findWithin(run, p.target as RunnerTarget, p.timeoutMs as number);
    if (this.isWriteControl(win, e)) {
      if (repair) throw new RpcError(E.policy_refused, 'policy_refused: the target is a declared write control; repair mode never acts on it');
      if (!write) throw new RpcError(E.policy_refused, `${e.controlType} #${e.automationId} is a declared write control: the step must be a declared write`);
    }
    if (repair && action === 'click' && !REPAIR_CLICKABLE.includes(e.controlType)) {
      throw new RpcError(E.policy_refused, `policy_refused: repair mode may click only tabs, list items and tree items, not a ${e.controlType}`);
    }
    if (chord) this.checkKeyReach(run, chord, write);
    // WindowsDesktop.KeyboardReceiver: keyboard input (a key, typing into an edit) needs the foreground window to be the
    // window the target resolved in. A dialog nested in the main form's tree, targeted through the main form, never is.
    if ((action === 'key' || (action === 'type' && e.controlType === 'Edit')) && run.app && run.app.foreground !== win) {
      throw new RpcError(E.timeout, `timeout: the run's window does not have the keyboard focus (${describeTarget(p.target as RunnerTarget)})`);
    }
    run.focus = e;
    run.app?.beforeAct?.(e, action);
    switch (action) {
      case 'click':
      case 'doubleClick':
        e.onClick?.();
        return {};
      case 'type': {
        // The driver's answer for a control without a text value (WindowsDesktop.Type): -32602.
        if (e.controlType !== 'Edit') throw new RpcError(INVALID_PARAMS, 'invalid params: the element does not take typed text');
        const segments = (p.segments as Segment[] | undefined) ?? [{ text: String(p.value ?? '') }];
        const text = segments.map((s) => ('exportDir' in s ? run.exportDir : s.text)).join('');
        this.lastTyped = text;
        e.value = text;
        e.onType?.();
        return {};
      }
      case 'select': {
        const v = String(p.value ?? '');
        this.lastTyped = v;
        if (!e.items?.includes(v)) throw new RpcError(E.not_found, `${e.controlType} #${e.automationId} has no item with that name`);
        e.value = v;
        return {};
      }
      case 'check':
      case 'uncheck':
        if (e.controlType !== 'CheckBox' && e.controlType !== 'RadioButton') throw new RpcError(INVALID_PARAMS, 'invalid params: the element cannot be checked or unchecked');
        e.value = action === 'check' ? 'On' : 'Off';
        return {};
      case 'key':
        if (run.app?.onKey?.(chord!, win)) return {};
        if (chord?.key === 'Enter' && !chord.ctrl && !chord.alt && !chord.shift) (e as El & { onEnter?: () => void }).onEnter?.();
        return {};
      case 'read':
        if (e.isPassword) throw new RpcError(E.policy_refused, 'password fields are never read');
        if (e.controlType === 'DataGrid') return { text: e.children.map((r) => r.children.map((c) => c.name).join('\t')).join('\n') };
        return { text: e.value ?? e.name };
      case 'expand':
        // WindowsDesktop.Expand: ExpandCollapse (a menu item with a drop-down, a combo box), else invalid params.
        if (e.onExpand) e.onExpand();
        else if (e.controlType !== 'ComboBox') throw new RpcError(INVALID_PARAMS, 'invalid params: the element cannot expand');
        return {};
      case 'focus':
        return {};
      default:
        throw new RpcError(-32602, `unknown action ${action}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The ERP Demo (desktop/erp-demo): the same window titles, automation ids and menu names as the WinForms app, and the
// same deterministic line items and CSV. WinForms menu items have no automation id: they are found by name. v1 by
// default; v2 (--ui v2) is three changes, and the fake adds a fourth that the real app does not have (customSave).

export const ERP_EXE = 'ErpDemo.exe';
export const ERP_USER = 'clerk';
export const ERP_PASSWORD = 'demo1234';
export const ERP_POLICY: FakePolicy = { ...DEMO_POLICY, allowedApps: [{ exe: ERP_EXE }], writeControls: [{ exe: ERP_EXE, automationId: 'btnPost' }] };
const ERP_VENDORS = ['Acme Paper Co', 'Blue River Logistics', 'Granite Tools', 'Harbor Foods', 'Summit Energy'];
const ERP_STATUSES = ['Open', 'Cleared', 'Blocked'];
const ERP_COUNTS: Record<string, number> = { 1000: 12, 2000: 7, 3000: 4 };
const ERP_CURRENCIES: Record<string, string> = { 1000: 'EUR', 2000: 'USD' };
export const ERP_CSV_HEADER = 'Document,Date,Company,Vendor,Amount,Currency,Status';
/**
 * One change to the ERP Demo, as an app upgrade makes it. 'rename': Search (btnSearch) becomes Find (btnFind). 'menu':
 * File keeps only Exit; Export moves to a new top-level Reports menu as "Export line items...". 'confirm': Export asks
 * first in a Confirm export form, whose Continue opens the Save dialog. 'customSave' (not in the real app): the export
 * dialog is a WinForms form (#ExportForm) whose save button is Export (btnExportSave), not a Win32 Save dialog.
 */
export type ErpChange = 'rename' | 'menu' | 'confirm' | 'customSave';
/** ERP Demo v2 (--ui v2): its changes. */
export const ERP_V2: readonly ErpChange[] = ['rename', 'menu', 'confirm'];
/** The class of the app's forms, and of its menu drop-downs (each a top-level window of its own), as UI Automation reports them. */
const ERP_FORM_CLASS = 'WindowsForms10.Window.8.app.0.2bf8098_r6_ad1';
const ERP_DROP_DOWN_CLASS = 'WindowsForms10.Window.808.app.0.2bf8098_r6_ad1';

/** LineItems.Search of the ERP Demo: rows of [Document, Date, Company, Vendor, Amount, Currency, Status]. */
export function erpLineItems(company: string, from: string, to: string): string[][] {
  const code = Number(company);
  const rows: string[][] = [];
  for (let i = 1; i <= (ERP_COUNTS[company] ?? 0); i++) {
    const date = new Date(Date.UTC(2026, 0, 5 + (i - 1) * 23)).toISOString().slice(0, 10);
    if (date < from || date > to) continue;
    const amount = (100 + ((i * 7919 + code) % 100000) / 100).toFixed(2);
    rows.push([`${company}-${String(i).padStart(4, '0')}`, date, company, ERP_VENDORS[(i + Math.floor(code / 1000)) % ERP_VENDORS.length], amount, ERP_CURRENCIES[company] ?? 'GBP', ERP_STATUSES[i % 3]]);
  }
  return rows;
}
/** LineItems.ToCsv: a header, CRLF line ends, fields quoted only when they need it. */
export function erpCsv(rows: string[][]): string {
  const quote = (f: string) => (/[,"\r\n]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f);
  return [ERP_CSV_HEADER, ...rows.map((r) => r.map(quote).join(','))].map((l) => `${l}\r\n`).join('');
}

class ErpApp implements AppModel {
  windows: Win[] = [];
  results: string[][] = [];
  signInFailures = 0;
  posted = 0;
  /** Files the app saved, by full path (saving outside the export directory is allowed but never retrievable). */
  readonly saved: string[] = [];
  private main: Win | undefined;
  /** The menu bar's top-level items by name, each with its drop-down (a Menu holding the drop-down's items). */
  private readonly menus = new Map<string, { item: El; dropDown: El }>();
  /** The open drop-down's window; at most one is open. Open dialogs nest the same way (see open()). */
  private dropDown: Win | undefined;
  /**
   * The menu bar's highlighted item while in menu mode. One Escape closes a drop-down but leaves the bar in menu mode
   * (a Down or Enter without a target reopens the highlighted item's drop-down); a second Escape leaves menu mode, and
   * so does any action on a target outside the menu.
   */
  private highlighted: string | undefined;

  constructor(private readonly exportDir: () => string | undefined, private readonly changes: ReadonlySet<ErpChange> = new Set()) {
    this.windows = [this.loginWindow()];
  }

  /** A drop-down never takes the foreground: its owner keeps it. */
  get foreground(): Win {
    return [...this.windows].reverse().find((w) => w.root.controlType !== 'Menu') ?? this.windows[this.windows.length - 1];
  }

  beforeAct(e: El, action: string): void {
    const inMenu = [...this.menus.values()].some((m) => m.item === e || descendants(m.dropDown).includes(e));
    if (inMenu) return;
    // A click, typing or a key elsewhere closes the open drop-down (reading or focusing does not).
    if (action !== 'read' && action !== 'focus') this.closeMenu();
    if (!this.dropDown) this.highlighted = undefined;
  }

  onKey(c: Chord, win: Win): boolean {
    if (c.ctrl || c.alt || c.shift || c.win) return false;
    if (c.key === 'Escape') {
      if (this.dropDown) this.closeMenu();
      else if (this.highlighted) this.highlighted = undefined;
      else win.onCancel?.();
      return true;
    }
    if ((c.key === 'Down' || c.key === 'Enter') && !this.dropDown && this.highlighted) {
      this.openMenu(this.highlighted);
      return true;
    }
    return false;
  }

  private loginWindow(): Win {
    const user = el('Edit', 'txtUser', 'User name', { className: 'WindowsForms10.EDIT.app.0.2bf8098_r6_ad1' });
    const password = el('Edit', 'txtPassword', 'Password', { isPassword: true, className: 'WindowsForms10.EDIT.app.0.2bf8098_r6_ad1' });
    const error = el('Text', 'lblLoginError', '', { visible: false });
    const signIn = () => {
      if (user.value === ERP_USER && password.value === ERP_PASSWORD) { this.main = this.mainWindow(); this.windows = [this.main]; return; }
      error.name = 'User name or password is wrong.';
      error.visible = true;
      password.value = '';
      this.signInFailures++;
    };
    // The form's AcceptButton: Enter in any field presses Sign in.
    for (const field of [user, password]) (field as El & { onEnter?: () => void }).onEnter = signIn;
    const button = el('Button', 'btnSignIn', 'Sign in', { onClick: signIn });
    return {
      title: 'ERP Demo - Sign in', exe: ERP_EXE, automationId: 'LoginForm', className: ERP_FORM_CLASS,
      root: el('Window', 'LoginForm', 'ERP Demo - Sign in', { children: [el('Text', 'lblUser', 'User name'), user, el('Text', 'lblPassword', 'Password'), password, error, button] }),
    };
  }

  private mainWindow(): Win {
    const company = el('ComboBox', 'cmbCompany', 'Company code', { items: ['1000', '2000', '3000'] });
    const from = el('Edit', 'txtDateFrom', 'Date from', { value: '2026-01-01' });
    const to = el('Edit', 'txtDateTo', 'Date to', { value: '2026-12-31' });
    const count = el('Text', 'lblResultCount', '');
    const grid = el('Table', 'gridResults', 'Results');
    const detail = el('Edit', 'txtDetail', 'Detail', { value: '' });
    const status = el('Text', 'lblStatus', 'Signed in as clerk');
    const columns = ['Document', 'Date', 'Company', 'Vendor', 'Amount', 'Currency', 'Status'];
    const search = () => {
      if (!company.value) { count.name = 'Choose a company code.'; return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from.value ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to.value ?? '')) { count.name = 'Dates must be YYYY-MM-DD.'; return; }
      this.results = erpLineItems(company.value, from.value!, to.value!);
      grid.children = this.results.map((r, i) => el('Custom', '', `Row ${i}`, { children: r.map((cell, j) => el('DataItem', '', `${columns[j]} Row ${i}`, { value: cell })) }));
      count.name = `${this.results.length} line items`;
      detail.value = this.results[0] ? [this.results[0][0], this.results[0][1], this.results[0][3], this.results[0][4], this.results[0][5], this.results[0][6]].join(' ') : '';
    };
    // v1: File > Export..., Separator, Exit. 'menu': File > Exit, and Reports > Export line items... between File and Help.
    this.menus.clear();
    const command = (name: string, run: () => void) => el('MenuItem', '', name, { onClick: () => { this.closeMenu(); this.highlighted = undefined; run(); } });
    const exit = command('Exit', () => { this.windows = []; });
    const bar = [this.topMenu('File', this.changes.has('menu') ? [exit] : [command('Export...', () => this.export()), el('Separator', '', ''), exit])];
    if (this.changes.has('menu')) bar.push(this.topMenu('Reports', [command('Export line items...', () => this.export())]));
    // About shows a message box in the real app; the fake only closes the menu.
    bar.push(this.topMenu('Help', [command('About', () => undefined)]));
    const go = this.changes.has('rename') ? el('Button', 'btnFind', 'Find', { onClick: search }) : el('Button', 'btnSearch', 'Search', { onClick: search });
    const searchPanel = el('Group', 'grpSearch', 'Line items', {
      children: [el('Text', 'lblCompany', 'Company code'), company, el('Text', 'lblFrom', 'Date from'), from, el('Text', 'lblTo', 'Date to'), to,
        go, el('Button', 'btnPost', 'Post', { onClick: () => { this.posted++; } }), count],
    });
    return {
      title: 'ERP Demo - Line items', exe: ERP_EXE, automationId: 'MainForm', className: ERP_FORM_CLASS,
      root: el('Window', 'MainForm', 'ERP Demo - Line items', { children: [el('MenuBar', 'mainMenu', '', { children: bar }), searchPanel, grid, el('Pane', 'pnlDetail', '', { children: [detail] }), el('StatusBar', 'statusBar', '', { children: [status] })] }),
    };
  }

  /** A top-level menu item: a click toggles its drop-down, expand opens it. */
  private topMenu(name: string, items: El[]): El {
    const item = el('MenuItem', '', name, { onClick: () => this.toggleMenu(name), onExpand: () => this.openMenu(name) });
    this.menus.set(name, { item, dropDown: el('Menu', '', name, { children: items }) });
    return item;
  }

  /**
   * Opens a drop-down, closing any other. It is a top-level window of its own (title the item's name, no automation id,
   * owned by the main form, above it but never the foreground), and the main form's tree holds the same elements under
   * the menu item: MenuItem "Reports" > Menu "Reports" > MenuItem "Export line items...".
   */
  private openMenu(name: string): void {
    this.highlighted = name;
    if (this.dropDown?.title === name) return;
    this.closeMenu();
    const m = this.menus.get(name)!;
    m.item.children = [m.dropDown];
    this.dropDown = { title: name, exe: ERP_EXE, automationId: '', className: ERP_DROP_DOWN_CLASS, owner: this.main, root: m.dropDown };
    this.windows.push(this.dropDown);
  }

  private closeMenu(): void {
    const open = this.dropDown;
    if (!open) return;
    this.menus.get(open.title)!.item.children = [];
    this.windows = this.windows.filter((w) => w !== open);
    this.dropDown = undefined;
  }

  private toggleMenu(name: string): void {
    if (this.dropDown?.title !== name) { this.openMenu(name); return; }
    this.closeMenu();
    this.highlighted = undefined;
  }

  /**
   * Opens a dialog of the main form: a top-level window of its own, and (as UI Automation reports an owned window) its
   * root `Window` node also sits under the main form's root, the same El objects in both trees.
   */
  private open(win: Win): void {
    this.windows.push(win);
    this.main!.root.children.push(win.root);
  }

  private close(win: Win): void {
    this.windows = this.windows.filter((w) => w !== win);
    if (this.main) this.main.root.children = this.main.root.children.filter((c) => c !== win.root);
  }

  private export(): void {
    this.open(this.changes.has('confirm') ? this.confirmDialog() : this.saveDialog());
  }

  /** 'confirm': a form of the app (the main form's class), owned by it; Escape presses Cancel. */
  private confirmDialog(): Win {
    const win: Win = {
      title: 'Confirm export', exe: ERP_EXE, automationId: 'ConfirmExportForm', className: ERP_FORM_CLASS, owner: this.main,
      onCancel: () => this.close(win),
      root: el('Window', 'ConfirmExportForm', 'Confirm export', {
        children: [
          el('Text', 'lblConfirm', `Export ${this.results.length} line items to a CSV file?`),
          el('Button', 'btnConfirmExport', 'Continue', { onClick: () => { this.close(win); this.open(this.saveDialog()); } }),
          el('Button', 'btnCancelExport', 'Cancel', { onClick: () => this.close(win) }),
        ],
      }),
    };
    return win;
  }

  /** The export dialog: the Win32 Save dialog, or with 'customSave' a form of the app. Saving writes the CSV where it is told. */
  private saveDialog(): Win {
    const file = el('Edit', '1001', 'File name:', { className: 'Edit', value: 'line-items.csv' });
    const save = () => {
      const typed = file.value ?? '';
      const cut = Math.max(typed.lastIndexOf('\\'), typed.lastIndexOf('/'));
      const dir = cut >= 0 ? typed.slice(0, cut) : '';
      const name = typed.slice(cut + 1);
      const exportDir = this.exportDir();
      if (name) this.saved.push(typed);
      if (exportDir && dir === exportDir && name) writeFileSync(join(exportDir, name), erpCsv(this.results));
      this.close(win);
    };
    const cancel = () => this.close(win);
    const win: Win = this.changes.has('customSave')
      ? {
          title: 'Export line items', exe: ERP_EXE, automationId: 'ExportForm', className: ERP_FORM_CLASS, owner: this.main, onCancel: cancel,
          root: el('Window', 'ExportForm', 'Export line items', {
            children: [file, el('Button', 'btnExportSave', 'Export', { onClick: save }), el('Button', 'btnExportCancel', 'Cancel', { onClick: cancel })],
          }),
        }
      : {
          title: 'Export line items', exe: ERP_EXE, automationId: '', className: '#32770', owner: this.main, onCancel: cancel,
          root: el('Window', '', 'Export line items', {
            children: [el('ComboBox', 'FileNameControlHost', 'File name:', { children: [file] }), el('Button', '1', 'Save', { className: 'Button', onClick: save }),
              el('Button', '2', 'Cancel', { className: 'Button', onClick: cancel })],
          }),
        };
    return win;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// A desktop authenticator app built on a web view: the app's own window holds a web view pane whose elements belong to
// a helper process (msedgewebview2.exe). Each entry is a button "Copy (<name>)" whose digits are folded into its label,
// so the code is only available by clicking it and reading the clipboard. The Search box filters the entries.

export const AUTH_EXE = 'Authenticator.exe';
export const WEBVIEW_EXE = 'msedgewebview2.exe';
export const WEBVIEW_PATTERN = 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\*\\msedgewebview2.exe';
export const AUTH_USER = 'ops.bot';
/** The codes the app shows, by entry name (a space in the middle, as the app shows them). */
export const AUTH_CODES: Readonly<Record<string, string>> = { [AUTH_USER]: '988 374', 'other.user': '120 559' };
export const AUTH_POLICY: FakePolicy = {
  allowedApps: [{ exe: AUTH_EXE }], writeControls: [], gatedKeys: [], maxFileBytes: 20 * 1024 * 1024,
  helperProcesses: [{ exe: WEBVIEW_EXE, pathPattern: WEBVIEW_PATTERN }], clipboardRead: true,
};

class AuthenticatorApp implements AppModel {
  windows: Win[];
  results: string[][] = [];
  signInFailures = 0;
  posted = 0;

  constructor(private readonly copy: (text: string) => void) {
    const entries = Object.entries(AUTH_CODES).map(([name, code]) => el('Button', '', `Copy (${name})`, { host: 'helper', onClick: () => this.copy(code) }));
    const search = el('Edit', '', 'Search', { host: 'helper' });
    search.onType = () => {
      const q = (search.value ?? '').toLowerCase();
      entries.forEach((e, i) => { e.visible = Object.keys(AUTH_CODES)[i].toLowerCase().includes(q); });
    };
    const view = el('Pane', '', 'Authenticator', { host: 'helper', className: 'Chrome_RenderWidgetHostHWND', children: [search, el('List', '', 'Entries', { host: 'helper', children: entries })] });
    this.windows = [{ title: 'Authenticator', exe: AUTH_EXE, automationId: '', className: 'AppWindow', root: el('Window', '', 'Authenticator', { children: [view] }) }];
  }

  get foreground(): Win {
    return this.windows[this.windows.length - 1];
  }
}
