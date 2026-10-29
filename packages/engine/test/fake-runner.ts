// An in-process desktop runner for tests: a TLS WebSocket server speaking protocol 1 (JSON-RPC 2.0) over an in-memory
// UI tree of a demo app: by default a small order search ("orders": sign-in form, order search, results grid, export
// through a Save As dialog that writes a CSV into the run's export directory); with `app: 'erp'`, a model of the real
// ERP Demo v1 in desktop/erp-demo (its window titles, automation ids, menu names, line items and CSV). It enforces the runner's floor as the real one does: bearer token on
// the upgrade, one run at a time with a lease, allowed apps, declared write controls and gated keys, repair-mode limits,
// export directory confinement, and the protocol's error codes. Error messages never contain typed values (unless a
// test turns on `echoTypedInErrors`, to prove the engine masks them anyway).
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
}
export const DEMO_POLICY: FakePolicy = {
  allowedApps: [{ exe: DEMO_EXE }],
  writeControls: [{ exe: DEMO_EXE, automationId: 'btnPost' }],
  gatedKeys: ['Ctrl+S', 'F11'],
  maxFileBytes: 20 * 1024 * 1024,
};

/** The runner's ceiling for one file.retrieve answer (RunnerPolicy.MaxFileBytesCeiling). */
export const RUNNER_MAX_FILE_BYTES = 36 * 1024 * 1024;
const INVALID_PARAMS = -32602;

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
  onClick?: () => void;
}
interface Win { title: string; exe: string; automationId: string; className: string; root: El; owner?: Win }

const el = (controlType: string, automationId: string, name: string, more: Partial<El> = {}): El => ({
  controlType, automationId, name, className: '', enabled: true, visible: true, children: [], ...more,
});

const ORDERS = [
  ['ORD-1001', 'ACME', 'Open', '120.00'],
  ['ORD-1002', 'ACME', 'Closed', '75.50'],
  ['ORD-1003', 'Globex', 'Open', '300.00'],
];

/** What the runner needs of an app model: its windows (foreground last) and what tests look at. */
export interface AppModel {
  windows: Win[];
  readonly foreground: Win;
  results: string[][];
  signInFailures: number;
  posted: number;
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

function describeTarget(t: RunnerTarget): string {
  return t.path.map((c) => [c.controlType, c.automationId && `#${c.automationId}`, c.name !== undefined && `"${c.name}"`].filter(Boolean).join(' ')).join(' > ');
}

interface Run { runId: string; leaseMs: number; exportDir: string; timer: NodeJS.Timeout; app?: AppModel; focus?: El }

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
  /** The app model: 'orders' (default) or 'erp', the real ERP Demo v1's controls. */
  app?: 'orders' | 'erp';
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
  readonly app: 'orders' | 'erp';
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
    this.cert = selfSignedCert();
    this.fingerprint = this.cert.fingerprint;
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
          return { jsonrpc: '2.0', id: msg.id, error: { code: e.code, message: this.echoTypedInErrors ? `${e.message} (last typed: ${this.lastTyped})` : e.message } };
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

  private find(run: Run, target: RunnerTarget): { el: El; win: Win; candidate: number } {
    const app = run.app;
    if (!app || app.windows.length === 0) throw new RpcError(E.not_found, `no window for ${describeTarget(target)}`);
    const tries = [target, ...(target.fallbacks ?? [])];
    let primaryCount = 0;
    for (let i = 0; i < tries.length; i++) {
      const t = tries[i];
      const win = t.window ? [...app.windows].reverse().find((w) => winMatches(w, t.window!)) : app.foreground;
      if (!win) continue;
      let nodes: El[] = [win.root];
      for (const c of t.path) {
        const found = nodes.flatMap((n) => descendants(n)).filter((e) => condMatches(e, c));
        nodes = c.index !== undefined ? (found[c.index] ? [found[c.index]] : []) : found;
      }
      const visible = nodes.filter((n) => n.visible);
      if (i === 0) primaryCount = visible.length;
      if (visible.length === 1) return { el: visible[0], win, candidate: i };
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
    return (run.app?.windows ?? []).some((w) => [w.root, ...descendants(w.root)].some((e) => this.isWriteControl(w, e)));
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
        run.app = this.app === 'erp' ? new ErpApp(() => this.run?.exportDir) : new DemoApp(() => this.run?.exportDir);
        this.lastApp = run.app;
        return { pid: 4242 };
      }
      case 'snapshot': {
        const run = this.requireRun(p);
        optInt(p, 'maxNodes', 1, 5000);
        optInt(p, 'maxDepth', 1, 100);
        const win = run.app?.foreground;
        if (!win) throw new RpcError(E.not_found, 'not_found: no element matched a window of the run (no matching window of the run)');
        const max = optInt(p, 'maxNodes', 1, 5000) ?? 400;
        const maxDepth = optInt(p, 'maxDepth', 1, 100) ?? 25;
        const nodes: RunnerNode[] = [];
        const walk = (e: El, depth: number) => {
          if (nodes.length >= max || !e.visible || depth > maxDepth) return;
          nodes.push({
            ref: `r${nodes.length}`, depth, controlType: e.controlType, name: e.name, automationId: e.automationId, className: e.className, enabled: e.enabled,
            ...(e.isPassword ? (e.value ? { valueHidden: true as const } : {}) : e.value !== undefined ? { value: e.value } : {}),
          });
          for (const c of e.children) walk(c, depth + 1);
        };
        walk(win.root, 0);
        return { window: { title: win.title, exe: win.exe }, nodes };
      }
      case 'isVisible': {
        const run = this.requireRun(p);
        try {
          this.find(run, p.target as RunnerTarget);
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
      default:
        throw new RpcError(-32601, `unknown method ${method}`);
    }
  }

  private async act(run: Run, p: Record<string, unknown>): Promise<unknown> {
    const action = String(p.action);
    const write = p.write === true;
    const repair = p.mode === 'repair';
    const chord = action === 'key' ? parseChord(String(p.value ?? '')) : undefined;
    if (repair && !['focus', 'expand', 'read', 'click'].includes(action)) {
      throw new RpcError(E.policy_refused, 'repair mode allows only focus, expand, read and clicks on tabs, list items and tree items');
    }
    // The floor checks that need no UI, in the runner's order: shell chords, then gated keys.
    if (chord && isSystemChord(chord)) throw new RpcError(E.policy_refused, `policy_refused: the key ${chordText(chord)} reaches the Windows shell, not the app, and is never sent`);
    if (chord && this.isGatedKey(chord) && !write) throw new RpcError(E.policy_refused, `policy_refused: the gated key ${chordText(chord)} needs write: true`);
    if (chord && p.target === undefined) {
      this.checkKeyReach(run, chord, write);
      if (chord.key === 'Enter' && !chord.ctrl && !chord.alt && !chord.shift) (run.focus as (El & { onEnter?: () => void }) | undefined)?.onEnter?.();
      return {};
    }
    const { el: e, win } = await this.findWithin(run, p.target as RunnerTarget, p.timeoutMs as number);
    if (repair && !(['focus', 'expand', 'read'].includes(action) || (action === 'click' && ['TabItem', 'ListItem', 'TreeItem'].includes(e.controlType)))) {
      throw new RpcError(E.policy_refused, 'repair mode allows only focus, expand, read and clicks on tabs, list items and tree items');
    }
    if (this.isWriteControl(win, e) && !write) throw new RpcError(E.policy_refused, `${e.controlType} #${e.automationId} is a declared write control: the step must be a declared write`);
    if (chord) this.checkKeyReach(run, chord, write);
    run.focus = e;
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
        if (chord?.key === 'Enter' && !chord.ctrl && !chord.alt && !chord.shift) (e as El & { onEnter?: () => void }).onEnter?.();
        return {};
      case 'read':
        if (e.isPassword) throw new RpcError(E.policy_refused, 'password fields are never read');
        if (e.controlType === 'DataGrid') return { text: e.children.map((r) => r.children.map((c) => c.name).join('\t')).join('\n') };
        return { text: e.value ?? e.name };
      case 'expand':
      case 'focus':
        return {};
      default:
        throw new RpcError(-32602, `unknown action ${action}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The ERP Demo v1 (desktop/erp-demo): the same window titles, automation ids and menu names as the WinForms app, and the
// same deterministic line items and CSV. WinForms menu items have no automation id: they are found by name.

export const ERP_EXE = 'ErpDemo.exe';
export const ERP_USER = 'clerk';
export const ERP_PASSWORD = 'demo1234';
export const ERP_POLICY: FakePolicy = { ...DEMO_POLICY, allowedApps: [{ exe: ERP_EXE }], writeControls: [{ exe: ERP_EXE, automationId: 'btnPost' }] };
const ERP_VENDORS = ['Acme Paper Co', 'Blue River Logistics', 'Granite Tools', 'Harbor Foods', 'Summit Energy'];
const ERP_STATUSES = ['Open', 'Cleared', 'Blocked'];
const ERP_COUNTS: Record<string, number> = { 1000: 12, 2000: 7, 3000: 4 };
const ERP_CURRENCIES: Record<string, string> = { 1000: 'EUR', 2000: 'USD' };
export const ERP_CSV_HEADER = 'Document,Date,Company,Vendor,Amount,Currency,Status';

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

  constructor(private readonly exportDir: () => string | undefined) {
    this.windows = [this.loginWindow()];
  }

  get foreground(): Win {
    return this.windows[this.windows.length - 1];
  }

  private loginWindow(): Win {
    const user = el('Edit', 'txtUser', 'User name', { className: 'WindowsForms10.EDIT.app.0.2bf8098_r6_ad1' });
    const password = el('Edit', 'txtPassword', 'Password', { isPassword: true, className: 'WindowsForms10.EDIT.app.0.2bf8098_r6_ad1' });
    const error = el('Text', 'lblLoginError', '', { visible: false });
    const signIn = () => {
      if (user.value === ERP_USER && password.value === ERP_PASSWORD) { this.windows = [this.mainWindow()]; return; }
      error.name = 'User name or password is wrong.';
      error.visible = true;
      password.value = '';
      this.signInFailures++;
    };
    // The form's AcceptButton: Enter in any field presses Sign in.
    for (const field of [user, password]) (field as El & { onEnter?: () => void }).onEnter = signIn;
    const button = el('Button', 'btnSignIn', 'Sign in', { onClick: signIn });
    return {
      title: 'ERP Demo - Sign in', exe: ERP_EXE, automationId: 'LoginForm', className: 'WindowsForms10.Window.8.app.0.2bf8098_r6_ad1',
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
    const fileMenu = el('MenuItem', '', 'File', { onClick: () => this.toggleFileMenu() });
    const menu = el('MenuBar', 'mainMenu', '', { children: [fileMenu, el('MenuItem', '', 'Help')] });
    const searchPanel = el('Group', 'grpSearch', 'Line items', {
      children: [el('Text', 'lblCompany', 'Company code'), company, el('Text', 'lblFrom', 'Date from'), from, el('Text', 'lblTo', 'Date to'), to,
        el('Button', 'btnSearch', 'Search', { onClick: search }), el('Button', 'btnPost', 'Post', { onClick: () => { this.posted++; } }), count],
    });
    return {
      title: 'ERP Demo - Line items', exe: ERP_EXE, automationId: 'MainForm', className: 'WindowsForms10.Window.8.app.0.2bf8098_r6_ad1',
      root: el('Window', 'MainForm', 'ERP Demo - Line items', { children: [menu, searchPanel, grid, el('Pane', 'pnlDetail', '', { children: [detail] }), el('StatusBar', 'statusBar', '', { children: [status] })] }),
    };
  }

  private toggleFileMenu(): void {
    const open = this.windows.find((w) => w.automationId === 'FileMenu');
    if (open) { this.windows = this.windows.filter((w) => w !== open); return; }
    const exportItem = el('MenuItem', '', 'Export...', { onClick: () => { this.windows = this.windows.filter((w) => w.automationId !== 'FileMenu'); this.windows.push(this.saveDialog()); } });
    const exit = el('MenuItem', '', 'Exit');
    // The drop-down is its own untitled window of the app (a ToolStripDropDown), as in WinForms.
    this.windows.push({ title: '', exe: ERP_EXE, automationId: 'FileMenu', className: 'WindowsForms10.Window.20808.app.0.2bf8098_r6_ad1', root: el('Menu', '', 'File', { children: [exportItem, el('Separator', '', ''), exit] }) });
  }

  private saveDialog(): Win {
    const file = el('Edit', '1001', 'File name:', { className: 'Edit', value: 'line-items.csv' });
    const owner = this.foreground;
    const close = () => { this.windows = this.windows.filter((w) => w.title !== 'Export line items'); };
    const save = el('Button', '1', 'Save', {
      className: 'Button',
      onClick: () => {
        const typed = file.value ?? '';
        const cut = Math.max(typed.lastIndexOf('\\'), typed.lastIndexOf('/'));
        const dir = cut >= 0 ? typed.slice(0, cut) : '';
        const name = typed.slice(cut + 1);
        const exportDir = this.exportDir();
        if (name) this.saved.push(typed);
        if (exportDir && dir === exportDir && name) writeFileSync(join(exportDir, name), erpCsv(this.results));
        close();
      },
    });
    const cancel = el('Button', '2', 'Cancel', { className: 'Button', onClick: close });
    return {
      title: 'Export line items', exe: ERP_EXE, automationId: '', className: '#32770', owner,
      root: el('Window', '', 'Export line items', { children: [el('ComboBox', 'FileNameControlHost', 'File name:', { children: [file] }), save, cancel] }),
    };
  }
}
