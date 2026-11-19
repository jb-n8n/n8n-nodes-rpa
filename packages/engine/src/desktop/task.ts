// The desktop lane: one run of a desktop step set on a desktop runner. Parallel to the browser's script lane and
// returning the same result shapes (LaneSuccess, TaskFailure), so the node consumes both alike. n8n stays the trust
// root: the signature is verified here, before anything connects; the runner only enforces its local floor.

import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { DEFAULT_MAX_ACTIONS, modelErrorText } from '../agent/loop.js';
import { countingModel, type ChatMessage, type ChatModel } from '../agent/model.js';
import { clampAgentBudget, PROVE_RESERVE_MS } from '../lane/agent-lane.js';
import { stripShownPrefix } from '../classify/classify.js';
import { CANCELLED, clampBudget, laneFailure, type LaneSuccess } from '../lane/script-lane.js';
import type { AgentActionSummary, TaskFailure } from '../lane/task.js';
import { hasSignature, type TrustInput, type TrustResult } from '../lane/trust.js';
import {
  DESKTOP_UNSIGNED_WRITES, desktopNotInteractive, desktopStepFailure, inputTooLong, nameMismatch, RUNNER_BUSY, runnerAppMissing, runnerAppNotAllowed, secretAppNotListed, SIGNATURE_INVALID, SIGNATURE_WITHOUT_KEY,
  UNSIGNED_REQUIRED, UNSIGNED_SECRET_VARIABLE, versionMismatch, AGENT_OUT_OF_BUDGET, REPAIR_ALREADY_RAN, WENT_IN_CIRCLES, withCost,
} from '../messages.js';
import { createMasker, type Masker } from '../secrets/mask.js';
import { MAX_RENDERED } from '../secrets/render.js';
import { registerSecretVars } from '../secrets/secret-fills.js';
import { appFileName, appListed, type SecretTargets } from '../secrets/secret-targets.js';
import { scriptHash, verifyScript } from '../sign.js';
import { FILE_CHECK_FAILED_PREFIX } from '../steps/file-check.js';
import { runBinaryProblem } from '../steps/limits.js';
import { parseDesktopScript } from '../steps/parse.js';
import { sleep } from '../steps/poll.js';
import { newRunState, runSteps, type StepContext } from '../steps/run.js';
import type { DesktopScript, DownloadedFile, ErrorCode, PortalPolicy, RunState, Script, Step, StepLogEntry, StepOutput } from '../types.js';
import { connectRunner, RUNNER_CONNECT_TIMEOUT_MS, type Lease, type RunnerClient, type RunnerEndpoint } from './client.js';
import {
  DesktopUnavailableError, ElementCannotActError, ElementNotFoundError, ElementNotUniqueError, ExpectedFileMissingError, NoRunError, PolicyRefusedError, PROTOCOL_VERSION,
  RunnerBusyError, RunnerConnectError, RunnerDisconnectedError, RunnerError, RunnerTimeoutError, RUNNER_ERROR_CODES,
} from './protocol.js';
import { createDesktopSurface, DesktopDriftError, MIN_MASKED_TYPED, RunnerTooOldError, type DesktopSurface } from './surface.js';
import './handlers.js';
import { unrepairable, type FailedPart } from './repair/patch.js';
import { proveDesktopRepair, type DesktopProofEvidence } from './repair/prove.js';
import { desktopRepairProposal, type DesktopRepairProposal } from './repair/proposal.js';
import { runDesktopRepairSession, type FailureClass } from './repair/session.js';

/** One desktop run. Apart from the abort signal, everything is JSON-serialisable. */
export interface DesktopTaskInput {
  /** The raw step document (`surface: "desktop"`). */
  script: unknown;
  trust: TrustInput;
  /** The RPA Desktop Runner credential. */
  runner: RunnerEndpoint;
  vars?: Record<string, string>;
  /**
   * The names in `vars` whose values are secrets (in n8n, the RPA Secret Variables credential): masked from the run start
   * like the token, refused by every template except a fill whose value is exactly that one {{var.name}}, and typed only
   * by signed steps.
   */
  secretVars?: string[];
  /**
   * Where the secret variables' values may be typed (in n8n, the RPA Secret Variables credential's May Be Typed Into):
   * a run whose app.exe file name is not one of `apps` is refused (policy_violation) before it connects to the runner, so
   * before the app starts. Absent: no limit.
   */
  secretTargets?: SecretTargets;
  budgetMs?: number;
  defaultStepTimeoutMs?: number;
  signal?: AbortSignal;
  /**
   * How long run.begin retries a busy runner (default: the lease plus 15 s, defaultBusyWaitMs; never past the budget).
   * 0: fail at the first refusal.
   */
  busyWaitMs?: number;
  /** The run's lease on the runner, renewed every third of it (5000..600000; default 30 s). */
  leaseMs?: number;
  /** AI repair: present only when repair is on and a chat model is connected. */
  repair?: DesktopRepairInput;
}

/** AI repair of a desktop run (signed steps only). */
export interface DesktopRepairInput {
  model: ChatModel;
  /** What the automation is for (the node's Goal): context for the model. */
  goal?: string;
  /** Clamped to 1..200 actions and 1,000..1,000,000 tokens. */
  agentBudget?: { maxActions?: number; maxTokens?: number };
  /** A repair already ran in this execution: no repair, drift is reported with the reason. */
  alreadyRan?: boolean;
  /** Why AI repair does not run this time (a failed repair is held): no repair, the drift carries this text. */
  held?: string;
}

/**
 * A desktop run that drifted and was repaired: the proposal (version N+1, no write flags) waits for a person. The run's
 * outputs and files are returned only when every step ran in the proof (no write and nothing held).
 */
export interface DesktopRepairSuccess {
  ok: true;
  lane: 'agent';
  surface: 'desktop';
  name: string | null;
  version: number | null;
  hash: string;
  /** True when the proof ran every step (no declared write, nothing held for approval). */
  completed: boolean;
  files: DownloadedFile[];
  outputs: StepOutput[];
  proposal: DesktopRepairProposal;
  digest: string;
  proof: DesktopProofEvidence;
  agentLog: AgentActionSummary[];
  log: StepLogEntry[];
  tokens: number;
  llmCalls: number;
  transcript: ChatMessage[];
  durationMs: number;
  /** What the repair did, one sentence (masked). */
  note: string;
  submitted: false;
}
export type DesktopTaskResult = LaneSuccess | DesktopRepairSuccess | TaskFailure;

/** Why a desktop repair is not attempted (appended to the drift message). */
export const DESKTOP_REPAIR_NEEDS_SIGNED = 'AI repair of desktop steps needs signed steps';
export const DESKTOP_REPAIR_AFTER_WRITE = 'AI repair is not available once a write step ran in this run';
export const DESKTOP_REPAIR_NOT_RESPONDING = 'AI repair not attempted: the control was found but did not respond';
export const DESKTOP_REPAIR_FILE_CHECK = "AI repair not attempted: the file's checks failed";
/** The proof did not pass: nothing is proposed. */
export const DESKTOP_REPAIR_WITHHELD = 'repaired steps withheld: the proof in a fresh session did not pass';
/** How long the repair run keeps the runner for its proof. */
export const PROOF_RESERVE_MS = 30_000;

export const DEFAULT_LEASE_MS = 30_000;
/** How much longer than a lease a busy runner is waited for by default. */
const BUSY_WAIT_MARGIN_MS = 15_000;
/**
 * The default busy wait for a run with this lease: the lease plus 15 s. A run whose n8n stopped mid-run holds the
 * runner until its lease runs out (it sends no more heartbeats, and it had the same lease when the node's defaults
 * apply), so waiting the lease plus a margin lets the next run start instead of failing busy just before the lock frees.
 */
export const defaultBusyWaitMs = (leaseMs: number): number => leaseMs + BUSY_WAIT_MARGIN_MS;
const BUSY_RETRY_MS = 1_000;
/**
 * Appended when the runner no longer knows the run (no_run, or a heartbeat told so): the run always sends its own
 * runId, so the run ended on the runner's side.
 */
export const LEASE_LOST = 'the runner no longer has this run: its lease ran out or the runner restarted';
const END_WAIT_MS = 5_000;

/** Desktop steps have no browser page: any browser code reaching for it fails loudly instead of acting. */
const NO_PAGE = new Proxy({}, { get() { throw new Error('a desktop run has no browser page'); } }) as Page;
/** Desktop steps have no network policy (the runner's local policy is the floor): an allow-nothing policy for StepContext. */
const NO_NETWORK: PortalPolicy = { startUrl: 'about:blank', navHosts: [], subresourceHosts: [], login: [], allowedSubmits: [] };

const refuse = (message: string): TrustResult => ({ ok: false, code: 'script_untrusted', message });

/**
 * The trust gate for desktop step sets, in the browser gate's order: a present signature is always verified (no key:
 * SIGNATURE_WITHOUT_KEY; invalid: UNSIGNED_REQUIRED when required, else SIGNATURE_INVALID); absent and required:
 * UNSIGNED_REQUIRED; unsigned write steps without Allow Unsigned Writes: DESKTOP_UNSIGNED_WRITES; signed steps must
 * match Expected Name and Expected Version. The signature binds the app (sign.ts desktopBinding) where a browser
 * signature binds its start host; the hash covers `surface` and `app`, so a desktop signature never verifies a browser
 * document or another app's.
 */
export function checkDesktopTrust(raw: unknown, trust: TrustInput): TrustResult {
  let script: DesktopScript | undefined;
  try {
    script = parseDesktopScript(raw);
  } catch {
    script = undefined;
  }
  if (hasSignature(trust)) {
    if (!trust.key || trust.key.trim() === '') return refuse(SIGNATURE_WITHOUT_KEY);
    const valid = verifyScript(raw, trust.key, {
      approvedBy: trust.approvedBy ?? '', signature: trust.signature as string, ...(trust.expect?.siteLoginId ? { siteLoginId: trust.expect.siteLoginId } : {}),
    });
    if (!valid) return refuse(trust.required ? UNSIGNED_REQUIRED : SIGNATURE_INVALID);
    if (!script) return { ok: true, signed: true };
    const want = trust.expect ?? {};
    const wantName = typeof want.name === 'string' ? want.name.trim() : '';
    if (wantName && script.name !== wantName) return refuse(nameMismatch(script.name ?? '', wantName));
    const rawVersion: unknown = want.version;
    if (!(rawVersion === undefined || rawVersion === null || (typeof rawVersion === 'string' && rawVersion.trim() === ''))) {
      const wantVersion = Number(rawVersion);
      if (!Number.isInteger(wantVersion) || script.version !== wantVersion) return refuse(versionMismatch(script.version ?? 0, rawVersion as number));
    }
    return { ok: true, signed: true };
  }
  if (trust.required) return refuse(UNSIGNED_REQUIRED);
  if (script && !trust.allowUnsignedWrites && script.steps.some((s) => s.write === true)) return refuse(DESKTOP_UNSIGNED_WRITES);
  return { ok: true, signed: false };
}

/**
 * A runner message without its leading error code (`not_unique: `, `invalid params: `): the code names the kind of
 * failure for the engine, and the rest is the runner's sentence for a person. Any other text comes back as it is.
 */
function withoutRunnerCode(message: string): string {
  const code = [...Object.keys(RUNNER_ERROR_CODES), 'invalid params'].find((c) => message.startsWith(`${c}: `));
  return code === undefined ? message : message.slice(code.length + 2);
}

/** The error code of a desktop failure, from the error the failing step met. */
function codeOf(err: unknown, message: string): ErrorCode {
  if (err instanceof RunnerBusyError) return 'busy';
  if (
    err instanceof DesktopUnavailableError || err instanceof NoRunError || err instanceof RunnerDisconnectedError || err instanceof RunnerConnectError
    || err instanceof RunnerTooOldError
  ) {
    return 'runner_unavailable';
  }
  if (err instanceof PolicyRefusedError || message.endsWith(UNSIGNED_SECRET_VARIABLE)) return 'policy_violation';
  if (
    err instanceof ElementNotFoundError || err instanceof ElementNotUniqueError || err instanceof ElementCannotActError || err instanceof RunnerTimeoutError
    || err instanceof DesktopDriftError
  ) {
    return 'drift_detected';
  }
  if (err instanceof ExpectedFileMissingError) return 'incomplete';
  if (message.startsWith(FILE_CHECK_FAILED_PREFIX)) return 'drift_detected';
  return 'incomplete';
}

/**
 * Messages, log notes and read outputs leave the run masked: secrets, the value of every variable the run typed into a
 * field (DesktopSurface.typed) and every clipboard text it read (DesktopSurface.clipboard), when long enough to mask. The
 * runner never puts typed values into its messages; this holds even if one did, and a read of a field holding such a
 * value shows [secret] in its place. Intents are the signed steps' own text and stay as written. `except`: one clipboard
 * text left unmasked (a clipboard read's own output); a typed variable value equal to it stays masked.
 */
function outputMasker(base: (string | undefined)[], surface?: DesktopSurface, except?: string): Masker {
  const long = (t: string) => t.length >= MIN_MASKED_TYPED;
  return createMasker([
    ...base, ...(surface?.typed ?? []).filter(long), ...(surface?.clipboard ?? []).filter((t) => long(t) && t !== except),
  ]);
}

/** Log notes and read outputs masked for secrets and typed variable values. */
function maskedLog(log: StepLogEntry[], masker: Masker): StepLogEntry[] {
  return log.map((e) => ({
    ...e, ...(e.note !== undefined ? { note: masker.mask(e.note) } : {}),
    ...(e.output?.text !== undefined ? { output: { ...e.output, text: masker.mask(e.output.text) } } : {}),
  }));
}

/**
 * Read outputs (Data `values`) masked like the log, except that a clipboard read's output keeps its own value (the
 * value is what the step returns; any typed variable value inside it stays masked).
 */
function maskedOutputs(outputs: StepOutput[], script: DesktopScript, secrets: (string | undefined)[], surface: DesktopSurface): StepOutput[] {
  const masker = outputMasker(secrets, surface);
  return outputs.map((o) => {
    if (o.text === undefined) return o;
    const step = script.steps[o.index];
    const clipboard = step !== undefined && 'read' in step && 'clipboard' in step.read;
    return { ...o, text: (clipboard ? outputMasker(secrets, surface, o.text) : masker).mask(o.text) };
  });
}

/** run.begin with this id, retrying a busy runner until busyUntil (then RunnerBusyError). */
async function beginRun(client: RunnerClient, id: string, leaseMs: number, busyUntil: number): Promise<void> {
  for (;;) {
    try {
      await client.call('run.begin', { runId: id, leaseMs });
      return;
    } catch (err) {
      if (!(err instanceof RunnerBusyError)) throw err;
      if (Date.now() + BUSY_RETRY_MS >= busyUntil) throw err;
      await sleep(BUSY_RETRY_MS);
    }
  }
}

/** app.launch, with the runner's not_found and not-allowed answers in the engine's words (AppLaunchError). */
async function launchApp(surface: DesktopSurface, app: DesktopScript['app']): Promise<void> {
  try {
    await surface.rpc('app.launch', { app });
  } catch (err) {
    const exe = app.exe.split(/[\\/]/).pop() ?? app.exe;
    // not_found from app.launch is the executable missing on the runner's machine: an installation problem, not drift.
    if (err instanceof ElementNotFoundError) throw new AppLaunchError('runner_unavailable', runnerAppMissing(exe));
    // policy_refused from app.launch with the runner's exact "not in the runner's allowedApps" text is the app missing from its
    // policy: name the way out instead. Other policy refusals (a writable folder, a changed file) keep the runner's own words.
    if (err instanceof PolicyRefusedError && err.message === `policy_refused: application "${exe}" is not in the runner's allowedApps`) {
      throw new AppLaunchError('policy_violation', runnerAppNotAllowed(exe));
    }
    throw err;
  }
}
class AppLaunchError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

/** The repair trigger table: whether a failed step of a signed run is repaired, and why not. */
export function repairableCause(err: unknown, message: string): FailureClass {
  const code = codeOf(err, message);
  if (code !== 'drift_detected') return { repair: false, code };
  if (err instanceof RunnerTimeoutError) return { repair: false, code, why: DESKTOP_REPAIR_NOT_RESPONDING };
  if (message.startsWith(FILE_CHECK_FAILED_PREFIX)) return { repair: false, code, why: DESKTOP_REPAIR_FILE_CHECK };
  const element = err instanceof ElementNotFoundError || err instanceof ElementNotUniqueError || err instanceof ElementCannotActError || err instanceof DesktopDriftError;
  return element ? { repair: true } : { repair: false, code };
}

/**
 * Runs a desktop step set: trust gate, shape check, connect (certificate pinned before the token is sent), hello,
 * run.begin (a busy runner is retried for busyWaitMs), app.launch, the steps on the desktop surface, and run.end on
 * every path once the run began. One budget and one cancel signal cover everything. Never throws. Messages, log notes
 * and read outputs are masked for secrets and typed variable values; file names are masked for secrets.
 */
export async function runDesktopTask(input: DesktopTaskInput): Promise<DesktopTaskResult> {
  const t0 = Date.now();
  const vars = input.vars ?? {};
  // The step context's masker: the token, the key and the secret variables, which only a signed fill of exactly one of
  // them may type (registerSecretVars). Every other masker of the run is built from `secrets`, which holds them all.
  const stepMasker = createMasker([input.runner?.token, input.trust.key]);
  registerSecretVars(input.secretVars, vars, stepMasker);
  /** A variable whose value is a secret: listed as one, or its value is held by the step masker (a token, the key). */
  const isSecretVar = (name: string): boolean => {
    const v = Object.hasOwn(vars, name) ? vars[name] : undefined;
    return (input.secretVars ?? []).includes(name) || (typeof v === 'string' && v !== '' && stepMasker.containsSecret(v));
  };
  const secrets: (string | undefined)[] = [...stepMasker.secrets];
  let surface: DesktopSurface | undefined;
  /** A failure. `message` is masked for secrets here; a message that can carry runner text is masked for typed values first. */
  const fail = (code: ErrorCode, message: string, extra: Partial<TaskFailure> = {}): TaskFailure => {
    const m = createMasker(secrets);
    return { ...laneFailure(t0, m, code, m.mask(message), extra), lane: 'script' };
  };
  const gate = checkDesktopTrust(input.script, input.trust);
  if (!gate.ok) return fail(gate.code, gate.message);
  let script: DesktopScript;
  try {
    script = parseDesktopScript(input.script);
  } catch (err) {
    return fail('policy_violation', (err as Error).message);
  }
  const version = script.version;
  const hash = scriptHash(input.script);
  const ids = { ...(version !== undefined ? { version } : {}), hash };
  // The secrets' owner limits where their values may be typed: an app not listed never starts with them.
  if (input.secretTargets && !appListed(input.secretTargets, script.app.exe)) return fail('policy_violation', secretAppNotListed(appFileName(script.app.exe)), ids);
  for (const [name, value] of Object.entries(input.vars ?? {})) {
    if (typeof value === 'string' && value.length > MAX_RENDERED) return fail('incomplete', stripShownPrefix(inputTooLong(name.slice(0, 100), MAX_RENDERED)), ids);
  }
  if (input.signal?.aborted) return fail('incomplete', CANCELLED, ids);

  const budget = clampBudget(input.budgetMs);
  const deadline = t0 + budget;
  let client: RunnerClient;
  try {
    client = await connectRunner(input.runner, { timeoutMs: Math.max(1, Math.min(RUNNER_CONNECT_TIMEOUT_MS, deadline - Date.now())), ...(input.signal ? { signal: input.signal } : {}) });
  } catch (err) {
    if (input.signal?.aborted) return fail('incomplete', CANCELLED, ids);
    // A malformed URL, token or fingerprint (plain Error) is the credential's configuration.
    const config = !(err instanceof RunnerConnectError);
    return fail('runner_unavailable', (err as Error).message, { ...ids, ...(config ? { configError: true } : {}) });
  }

  let timedOut = false;
  let cancelled = false;
  let runId: string | undefined;
  const stop = () => {
    // The runner frees the run when its lease ends; run.end first frees it at once when the runner still answers.
    if (runId) void client.call('run.end', { runId }, 1_000).catch(() => undefined).finally(() => client.destroy());
    else client.destroy();
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, deadline - Date.now()));
  const onAbort = () => { cancelled = true; stop(); };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  /** Run-level outcomes that override the step's own error: cancellation, then the budget. */
  const override = (where?: string): { code: ErrorCode; message: string } | undefined => {
    if (cancelled) return { code: 'incomplete', message: CANCELLED };
    if (timedOut) return { code: 'incomplete', message: `run budget of ${budget} ms ran out${where ? ` at "${where}"` : ''}` };
    return undefined;
  };

  let lease: Lease | undefined;
  let state: RunState | undefined;
  try {
    const hello = await client.hello();
    if (hello.protocol !== PROTOCOL_VERSION) return fail('runner_unavailable', `the desktop runner speaks protocol ${String(hello.protocol)}; this node needs ${PROTOCOL_VERSION}`, ids);
    const session = hello.runner?.session;
    if (!session?.interactive || session.locked) return fail('runner_unavailable', desktopNotInteractive(session?.locked === true), ids);

    const leaseMs = Math.min(Math.max(input.leaseMs ?? DEFAULT_LEASE_MS, 5_000), 600_000);
    const busyUntil = Date.now() + Math.min(Math.max(input.busyWaitMs ?? defaultBusyWaitMs(leaseMs), 0), deadline - Date.now());
    const id = randomUUID();
    try {
      // If this call times out after the runner began the run, runId stays unset and no run.end is sent: the runner's
      // lease (leaseMs) frees it.
      await beginRun(client, id, leaseMs, busyUntil);
    } catch (err) {
      if (err instanceof RunnerBusyError) return fail('busy', RUNNER_BUSY, ids);
      throw err;
    }
    runId = id;
    lease = client.startLease(runId, leaseMs);
    surface = createDesktopSurface(client, runId, script.app);
    try {
      await launchApp(surface, script.app);
    } catch (err) {
      if (err instanceof AppLaunchError) return fail(err.code, err.message, ids);
      throw err;
    }

    const ctx: StepContext = {
      page: NO_PAGE, surface, script: script as unknown as Script, policy: NO_NETWORK, vars,
      masker: stepMasker, defaultTimeoutMs: input.defaultStepTimeoutMs ?? 8000, violations: [], signed: gate.signed,
    };
    const desktop = surface;
    desktop.trackStep(() => ctx.stepIndex);
    state = newRunState();
    // The step runner dispatches on the surface kind: desktop steps reach only the desktop handlers.
    const res = await runSteps(ctx, script.steps as unknown as Step[], state);
    if (!res.ok) {
      const o = override(res.failure.intent);
      const m = outputMasker(secrets, surface);
      const failure = { ...res.failure, message: m.mask(res.failure.message) };
      const base = {
        ...ids, failure, log: maskedLog(res.state.log, m), lastCheckpoint: res.state.lastCheckpoint, ...(res.state.submitted ? { submitted: true } : {}),
      };
      if (o) return fail(o.code, o.message, base);
      const cause = desktop.errors.get(res.failure.index);
      const code = codeOf(cause, res.failure.message);
      const lost = lease?.error || cause instanceof NoRunError ? ` (${LEASE_LOST})` : '';
      // Every failed step starts with its number and intent. The runner's own words follow as they came (without its
      // code); the engine's own wording follows without a limit or capture prefix, so the intent is not said twice.
      const said = cause instanceof RunnerError ? withoutRunnerCode(failure.message) : stripShownPrefix(failure.message);
      const shown = desktopStepFailure(res.failure.index + 1, res.failure.intent.replace(/\s+/g, ' ').trim(), said);
      if (!input.repair || code !== 'drift_detected' || lost) return fail(code, `${shown}${lost}`, base);

      // AI repair: refused for the reasons below (the drift carries the reason), else the session, then the proof.
      const repair = input.repair;
      const step = script.steps[res.failure.index]!;
      const trigger = repairableCause(cause, res.failure.message);
      const dr2 = unrepairable(step, isSecretVar);
      const why = repair.alreadyRan ? REPAIR_ALREADY_RAN
        : repair.held?.trim() ? repair.held.trim()
        : !gate.signed ? DESKTOP_REPAIR_NEEDS_SIGNED
        : res.state.submitted ? DESKTOP_REPAIR_AFTER_WRITE
        : !trigger.repair ? trigger.why
        : dr2 ? `AI repair not attempted on step ${res.failure.index + 1}: ${dr2}`
        : undefined;
      if (why || !trigger.repair) return fail(code, `${shown}${why ? ` (${why})` : ''}`, base);

      const calls = { n: 0 };
      const budgetCaps = clampAgentBudget(repair.agentBudget);
      const reserve = Math.min(PROVE_RESERVE_MS, Math.floor(budget * 0.4));
      const part: FailedPart = cause instanceof DesktopDriftError && cause.message.startsWith('expected ') ? 'expect' : 'target';
      const sessionMask = () => outputMasker(secrets, surface);
      const session = await runDesktopRepairSession({
        surface: desktop, ctx, state: res.state, base: script,
        failure: { index: res.failure.index, intent: res.failure.intent, message: m.mask(said), part },
        model: countingModel(repair.model, calls), ...(repair.goal ? { goal: repair.goal } : {}),
        budget: { maxActions: budgetCaps.maxActions ?? DEFAULT_MAX_ACTIONS, maxTokens: budgetCaps.maxTokens, deadlineMs: deadline - reserve },
        ...(input.signal ? { signal: input.signal } : {}),
        mask: sessionMask, isSecretVar,
        classify: (index, message) => repairableCause(desktop.errors.get(index), message),
      });
      const { loop } = session;
      const llmCalls = Math.max(calls.n, loop.llmCalls);
      const tokens = loop.tokens;
      const sm = sessionMask();
      const agentLog: AgentActionSummary[] = session.actions.map((a) => ({ tool: a.tool, ok: a.ok, url: sm.mask(desktop.address()), ...(a.note ? { note: sm.mask(a.note) } : {}) }));
      const agentExtra = { lane: 'agent' as const, agentLog, tokens, llmCalls, transcript: loop.transcript };
      const repairLog = () => maskedLog(res.state.log, sessionMask());
      const failAgent = (c: ErrorCode, message: string): TaskFailure => ({
        ...fail(c, withCost(message, llmCalls, tokens), { ...base, log: repairLog(), ...(res.state.submitted ? { submitted: true } : {}) }), ...agentExtra,
      });
      const o2 = override(res.failure.intent);
      if (o2) return failAgent(o2.code, o2.message);
      const end = session.end;
      if (!end) {
        if (loop.outcome === 'budget') return failAgent('incomplete', `${shown}. ${AGENT_OUT_OF_BUDGET}: ${loop.note}`);
        if (loop.outcome === 'circling') return failAgent('incomplete', `${shown}. The repair ${WENT_IN_CIRCLES}: ${loop.note}`);
        const modelFailed = 'the model call failed: ';
        const note = loop.note.startsWith(modelFailed) ? `model unavailable: ${modelErrorText(loop.note.slice(modelFailed.length), sm)}` : `the repair could not continue: ${loop.note}`;
        return failAgent('incomplete', `${shown}. ${note}`);
      }
      if (end.kind === 'gave_up') return failAgent('drift_detected', `${shown}. AI repair did not fix it: ${end.note}`);
      if (end.kind === 'failed') return failAgent(end.code, `${shown}. AI repair: ${end.message}`);

      // The proof: the repair run ends and keeps the runner for the proof's run, which starts the app afresh.
      lease?.stop();
      lease = undefined;
      const proofId = randomUUID();
      await client.call('run.end', { runId: id, reserveFor: proofId, reserveMs: PROOF_RESERVE_MS }, END_WAIT_MS).catch(() => undefined);
      runId = undefined;
      const proof = await proveDesktopRepair({
        client, runId: proofId, doc: end.doc, changed: end.changed, added: end.added, marks: end.marks, stop: end.stop, vars,
        stepMasker: (() => { const pm = createMasker([input.runner?.token, input.trust.key]); registerSecretVars(input.secretVars, vars, pm); return pm; })(),
        mask: (ps) => createMasker([...sessionMask().secrets, ...(ps ? outputMasker([], ps).secrets : [])]),
        leaseMs, busyUntil: Math.min(Date.now() + PROOF_RESERVE_MS + 5_000, deadline), defaultStepTimeoutMs: ctx.defaultTimeoutMs, signed: gate.signed,
        began: (pid) => { runId = pid; }, begin: beginRun, launch: (ps) => launchApp(ps, script.app),
      });
      runId = undefined;
      const o3 = override();
      if (o3) return failAgent(o3.code, o3.message);
      const pm = createMasker([...sessionMask().secrets, ...(proof.surface ? outputMasker([], proof.surface).secrets : [])]);
      if (!proof.ok) return failAgent(proof.code === 'runner_unavailable' ? 'runner_unavailable' : 'drift_detected', `${DESKTOP_REPAIR_WITHHELD}. Reason: ${proof.reason}`);
      const { proposal, digest } = desktopRepairProposal({ base: script, doc: end.doc, proof: proof.evidence, mask: (t) => pm.mask(t) });
      const completed = end.stop === null && proof.evidence.stoppedAt === null;
      const ev = proof.evidence;
      const stopNote = ev.stoppedAt !== null ? `; the proof stopped at step ${ev.stoppedAt} (${ev.stoppedBecause}: found, not run)` : '';
      const repairNote = end.stop ? `; the repair stopped at step ${end.stop.index + 1}: ${end.stop.why}` : '';
      return {
        ok: true, lane: 'agent', surface: 'desktop', name: script.name ?? null, version: version ?? null, hash, completed,
        files: completed ? proof.files : [], outputs: completed ? maskedOutputs(proof.outputs, end.doc, secrets, proof.surface) : [],
        proposal, digest, proof: proof.evidence, agentLog, log: [...repairLog(), ...maskedLog(proof.log, pm)], tokens, llmCalls, transcript: loop.transcript,
        durationMs: Date.now() - t0, note: pm.mask(`repaired ${end.fixes} step${end.fixes === 1 ? '' : 's'} and replayed the steps in a fresh start of the app${stopNote}${repairNote}`).slice(0, 500),
        submitted: false,
      };
    }
    const tail = { ...ids, log: maskedLog(res.state.log, outputMasker(secrets, surface)), ...(res.state.submitted ? { submitted: true } : {}) };
    const o = override();
    if (o) return fail(o.code, o.message, tail);
    const tooMuch = runBinaryProblem(res.state);
    if (tooMuch) return fail('incomplete', stripShownPrefix(tooMuch), tail);
    await desktop.refreshWindow();
    const m = outputMasker(secrets, surface);
    return {
      ok: true, lane: 'script', name: script.name ?? null, version: version ?? null, hash, rows: [], files: res.state.downloads, outputs: maskedOutputs(res.state.outputs, script, secrets, surface),
      log: maskedLog(res.state.log, m), violations: [], blockedRequests: [],
      page: { url: m.mask(desktop.address()), title: m.mask(desktop.windowTitle()).slice(0, 200), status: null },
      verified: false, confirmed: false, writes: [], submitted: res.state.submitted, durationMs: Date.now() - t0,
    };
  } catch (err) {
    const o = override();
    const extra = { ...ids, ...(state?.submitted ? { submitted: true } : {}) };
    if (o) return fail(o.code, o.message, extra);
    const message = (err as Error)?.message ?? String(err);
    return fail(codeOf(err, message), outputMasker(secrets, surface).mask(message.split('\n')[0]).slice(0, 500), extra);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
    lease?.stop();
    if (runId && !client.closed) await client.call('run.end', { runId }, END_WAIT_MS).catch(() => undefined);
    await client.close();
  }
}
