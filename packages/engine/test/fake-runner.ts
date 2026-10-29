// An in-process desktop runner for tests: a TLS WebSocket server speaking protocol 1 (JSON-RPC 2.0) over an in-memory
// UI tree of the demo app ("ERP Demo": sign-in form, order search, results grid, export through a Save As dialog that
// writes a CSV into the run's export directory). It enforces the runner's floor as the real one does: bearer token on
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

/** The demo app's windows and behaviour. */
class DemoApp {
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

interface Run { runId: string; leaseMs: number; exportDir: string; timer: NodeJS.Timeout; app?: DemoApp; focus?: El }

export interface FakeRunnerOptions {
  token?: string;
  policy?: FakePolicy;
  session?: { interactive: boolean; locked: boolean };
  /** A misbehaving runner that puts the last typed text into its error messages (the engine must mask it). */
  echoTypedInErrors?: boolean;
  /** Caps the TLS version (TLS 1.2: the server's handshake ends after the client's). */
  tlsMaxVersion?: 'TLSv1.2' | 'TLSv1.3';
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
  lastApp: DemoApp | undefined;
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
    this.tlsMaxVersion = opts.tlsMaxVersion ?? 'TLSv1.3';
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

  /** Simulates another n8n holding the runner: the lock is taken by a run nobody here owns. */
  holdLock(): void {
    const exportDir = mkdtempSync(join(this.exportRoot, 'other-'));
    this.run = { runId: 'someone-else', leaseMs: 600_000, exportDir, timer: setTimeout(() => undefined, 0) };
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
        run.app = new DemoApp(() => this.run?.exportDir);
        this.lastApp = run.app;
        return { pid: 4242 };
      }
      case 'snapshot': {
        const run = this.requireRun(p);
        const win = run.app?.foreground;
        if (!win) return { window: { title: '', exe: '' }, nodes: [] };
        const max = typeof p.maxNodes === 'number' ? p.maxNodes : 400;
        const nodes: RunnerNode[] = [];
        const walk = (e: El, depth: number) => {
          if (nodes.length >= max || !e.visible) return;
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
        const re = new RegExp(String(p.pattern));
        const until = Date.now() + Math.min(p.timeoutMs as number, 30_000);
        for (;;) {
          const hit = readdirSync(run.exportDir).find((f) => re.test(f) && statSync(join(run.exportDir, f)).isFile());
          if (hit) {
            const data = readFileSync(join(run.exportDir, hit));
            const max = Math.min(p.maxBytes as number, this.policy.maxFileBytes);
            if (data.length > max) throw new RpcError(E.policy_refused, `the file is larger than ${max} bytes`);
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
    if (action === 'key' && p.target === undefined) {
      const chord = String(p.value);
      if (this.policy.gatedKeys.includes(chord) && !write) throw new RpcError(E.policy_refused, `the key ${chord} needs a declared write step`);
      if (repair) throw new RpcError(E.policy_refused, 'repair mode allows only focus, expand, read and clicks on tabs, list items and tree items');
      if (chord === 'Enter') (run.focus as (El & { onEnter?: () => void }) | undefined)?.onEnter?.();
      return {};
    }
    const { el: e, win } = await this.findWithin(run, p.target as RunnerTarget, p.timeoutMs as number);
    if (repair && !(['focus', 'expand', 'read'].includes(action) || (action === 'click' && ['TabItem', 'ListItem', 'TreeItem'].includes(e.controlType)))) {
      throw new RpcError(E.policy_refused, 'repair mode allows only focus, expand, read and clicks on tabs, list items and tree items');
    }
    if (this.isWriteControl(win, e) && !write) throw new RpcError(E.policy_refused, `${e.controlType} #${e.automationId} is a declared write control: the step must be a declared write`);
    run.focus = e;
    switch (action) {
      case 'click':
      case 'doubleClick':
        e.onClick?.();
        return {};
      case 'type': {
        if (e.controlType !== 'Edit') throw new RpcError(E.policy_refused, `${e.controlType} #${e.automationId} is not a text field`);
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
        e.value = action === 'check' ? 'On' : 'Off';
        return {};
      case 'key': {
        const chord = String(p.value);
        if (this.policy.gatedKeys.includes(chord) && !write) throw new RpcError(E.policy_refused, `the key ${chord} needs a declared write step`);
        if (chord === 'Enter') (e as El & { onEnter?: () => void }).onEnter?.();
        return {};
      }
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
