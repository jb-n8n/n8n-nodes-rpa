import type { Page } from 'playwright-core';
import { openSession, violationMessage, type Session, type StorageState } from '../browser/session.js';
import { PolicyError } from '../steps/errors.js';
import { classifyFailure, DETECTED_PREFIX, shownFailure, stripShownPrefix, toErrorCode } from '../classify/classify.js';
import { BLOCKED_STOP, inputTooLong } from '../messages.js';
import { effectivePolicy } from '../policy/derive.js';
import { loginDetectIndex } from '../policy/login-block.js';
import { loginBlockEnd, validateScript } from '../policy/validate.js';
import { createMasker, maskRequests, maskViolations, type Masker } from '../secrets/mask.js';
import { MAX_RENDERED } from '../secrets/render.js';
import { scriptHash } from '../sign.js';
import { MAX_SCREENSHOT_HEIGHT } from '../steps/handlers/capture.js';
import { runBinaryProblem } from '../steps/limits.js';
import { screenshotMasks } from '../steps/masks.js';
import { shownMessage } from '../steps/urls.js';
import { installInterrupts } from '../steps/interrupts.js';
import { parseScript } from '../steps/parse.js';
import { newRunState, runSteps, type StepContext } from '../steps/run.js';
import { stopTrace, wantTrace, type SaveTrace } from '../trace/trace.js';
import type {
  BrowserEndpoint, DownloadedFile, ErrorCode, OutputSpec, PageInfo, PortalPolicy, PortalSecrets, RequestRecord, Row, RunState, Script,
  StepFailure, StepLogEntry, StepOutput, Violation,
} from '../types.js';
import { verifyRows } from '../verify/verify.js';
import { maskedPageText, openStartPage, pageInfo, START_TIMEOUT_MS, startPageFailure, startPlan, startProceeds } from './start-page.js';
import { checkTrust, type TrustInput } from './trust.js';

export const DEFAULT_BUDGET_MS = 180_000;
export const MAX_BUDGET_MS = 300_000;
export const CANCELLED = 'run cancelled';
const LIMIT_PREFIX = 'limit: ';

/** Input for one script-lane run. `script` is the raw step document; the trust gate checks it before it is parsed. */
export interface ScriptLaneInput {
  script: unknown;
  /** Signature, approver, signing key and the Require Signed Steps / Allow Unsigned Writes switches (lane/trust.ts). */
  trust: TrustInput;
  policy: PortalPolicy;
  /** Site Login secrets; absent without a Site Login. */
  secrets?: PortalSecrets;
  /** Browser viewport; Playwright's default when absent. */
  viewport?: { width: number; height: number };
  vars?: Record<string, string>;
  /** Row checks, run only after an extract step. Absent: rows are returned unchecked (none are required). */
  output?: OutputSpec;
  /** How the start page's status is read: 'classify' (default, v1) or 'report' (quick operations). */
  startStatus?: 'classify' | 'report';
  endpoint: BrowserEndpoint;
  budgetMs?: number;
  defaultStepTimeoutMs?: number;
  /** Aborting cancels the run: the browser session is closed and the result is `incomplete` / 'run cancelled'. */
  signal?: AbortSignal;
  /** Keep a scrubbed Playwright trace: on failure (default), always, or never. */
  saveTrace?: SaveTrace;
}

export type LaneSuccess = {
  ok: true; lane: 'script'; name: string | null; version: number | null; hash: string; rows: Row[]; files: DownloadedFile[];
  /** What screenshot, pdf and read steps produced, in step order (strings masked). */
  outputs: StepOutput[];
  log: StepLogEntry[]; violations: Violation[];
  /** Writes that were blocked and logged without ending the run (writeMode 'block'). */
  blockedRequests: RequestRecord[];
  /** The page the run ended on. */
  page: PageInfo;
  /** Row checks ran (an extract step ran). */
  verified: boolean;
  /** Row checks ran and the page stated a total equal to the row count. */
  confirmed: boolean;
  /** The POSTs the Fill and Submit window let through (method, masked host and path); empty without a window. */
  writes: RequestRecord[];
  /** True once a write left the browser: any non-safe request the session let through, except declared login POSTs. */
  submitted: boolean;
  durationMs: number; trace?: Buffer;
};
export type LaneFailure = {
  ok: false; code: ErrorCode; message: string; failure?: StepFailure; violations: Violation[]; log: StepLogEntry[];
  /** Writes that were blocked and logged before the run failed (writeMode 'block'); empty when none were. */
  blockedRequests: RequestRecord[];
  screenshot?: Buffer; durationMs: number; version?: number; hash?: string;
  lastCheckpoint?: number; credentialsSubmitted?: boolean; trace?: Buffer;
  /** True once a write left the browser (any non-safe request the session let through, except declared login POSTs); absent otherwise. */
  submitted?: boolean;
};
/**
 * Result of a script-lane run. On success: extracted rows or downloaded files, the masked step log and the
 * non-fatal violations that were blocked. On failure: an error code, a masked message, the failing step,
 * violations, a masked screenshot when a page was open, and resume info (`lastCheckpoint`, -1 when none was
 * reached; `credentialsSubmitted`) when steps ran. Every string and violation URL is masked.
 */
export type LaneResult = LaneSuccess | LaneFailure;

export { screenshotMasks } from '../steps/masks.js';

/** The run masker: every Site Login secret (when attached), the endpoint token and the signing key. */
export function laneMasker(input: { secrets?: PortalSecrets; endpoint: BrowserEndpoint; signingKey?: string }): Masker {
  return createMasker([input.secrets?.username, input.secrets?.password, input.secrets?.totpSecret, input.endpoint.token, input.signingKey]);
}

export function clampBudget(budgetMs?: number): number {
  const requested = typeof budgetMs === 'number' && Number.isFinite(budgetMs) ? budgetMs : DEFAULT_BUDGET_MS;
  return Math.min(Math.max(requested, 1000), MAX_BUDGET_MS);
}

export function laneFailure(t0: number, masker: Masker, code: ErrorCode, message: string, extra: Partial<LaneFailure> = {}): LaneFailure {
  const { violations = [], blockedRequests = [], ...rest } = extra;
  return {
    ok: false, code, message, log: [], durationMs: Date.now() - t0, ...rest,
    violations: maskViolations(violations, masker),
    blockedRequests: maskRequests(blockedRequests, masker),
  };
}

/** Whether a run records a browser trace at all under this mode (default 'onFailure'); wantTrace decides if it is kept. */
export const traceOn = (mode: SaveTrace | undefined): boolean => (mode ?? 'onFailure') !== 'never';

export function maskLog(log: StepLogEntry[], masker: Masker): StepLogEntry[] {
  return log.map((e) => ({ ...e, intent: masker.mask(e.intent) }));
}

/** A guarded browser session with the run's single deadline and cancel signal attached. */
export interface LaneRuntime {
  readonly session: Session;
  readonly masker: Masker;
  readonly budget: number;
  /** Absolute end of the run (Date.now() scale); the session closes as 'budget' at this time. */
  readonly deadline: number;
  readonly timedOut: boolean;
  /**
   * Run-level outcomes that override step-level classification, in priority order:
   * a fatal violation, then a spontaneous browser disconnect, then caller cancellation, then the run budget.
   */
  override(where?: string, allowDetected?: boolean): { code: ErrorCode; message: string } | null;
  /** Clears the timer and abort listener and closes the session (saving a running trace first). */
  dispose(): Promise<void>;
}

/**
 * Opens the guarded session for a run. Throws BrowserUnavailableError when the browser cannot be reached. The budget
 * starts before the browser is opened, so waiting for a free browser session never runs past it.
 */
export async function openLaneRuntime(opts: {
  endpoint: BrowserEndpoint; policy: PortalPolicy; masker: Masker; budgetMs?: number; signal?: AbortSignal; trace: boolean;
  viewport?: { width: number; height: number };
}): Promise<LaneRuntime> {
  const budget = clampBudget(opts.budgetMs);
  const deadline = Date.now() + budget;
  const session = await openSession({
    endpoint: opts.endpoint, policy: opts.policy, masker: opts.masker, trace: opts.trace, ...(opts.viewport ? { viewport: opts.viewport } : {}),
    deadlineMs: deadline, ...(opts.signal ? { signal: opts.signal } : {}),
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void session.close('budget'); }, Math.max(1, deadline - Date.now()));
  const onAbort = () => { void session.close('caller'); };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
  const masker = opts.masker;
  return {
    session, masker, budget, deadline,
    get timedOut() { return timedOut; },
    override(where?: string, allowDetected = false) {
      const fatal = session.violations.find((v) => v.fatal);
      if (fatal) return { code: 'policy_violation', message: masker.mask(violationMessage(fatal, opts.policy)) };
      if (session.closeReason === 'disconnected') return { code: 'browser_unavailable', message: 'the browser disconnected during the run' };
      if (session.closeReason === 'caller') return { code: 'incomplete', message: CANCELLED };
      if (timedOut && !allowDetected) return { code: 'incomplete', message: masker.mask(`run budget of ${budget} ms ran out${where ? ` at "${where}"` : ''}`) };
      return null;
    },
    async dispose() {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      await session.close();
    },
  };
}

/** What a script-lane run leaves behind for the agent lane (present once the steps ran). */
export interface ScriptRun {
  result: LaneResult;
  ctx?: StepContext;
  state?: RunState;
  script?: Script;
  /** The page URL right after the script's login block passed (captured only when the session may be kept). */
  postLoginUrl?: string;
  /** The healing session's cookies and storage at that moment, for prove to reuse instead of signing in again. */
  storageState?: StorageState;
  /**
   * The same, captured right before the login block's detect (after the sign-in and its own steps). Prove resumes here
   * only when that detect is the step that failed and the agent re-anchored it.
   */
  beforeDetect?: { url: string; storageState: StorageState };
}

/** A masked failure screenshot: full page unless the page is taller than a screenshot may be (then the viewport). */
async function failureScreenshot(page: Page, secrets?: PortalSecrets): Promise<Buffer | undefined> {
  const height = await page.evaluate(() => document.documentElement?.scrollHeight ?? 0).catch(() => 0);
  return page.screenshot({ fullPage: height <= MAX_SCREENSHOT_HEIGHT, mask: screenshotMasks(page, secrets) }).catch(() => undefined);
}

async function executeScript(
  input: ScriptLaneInput, script: Script, runtime: LaneRuntime, t0: number, version: number | undefined, hash: string, capture: boolean,
  /** Receives the run state as soon as it exists, so the caller's catch path can still tell whether a write went out. */
  live: { state?: RunState } = {},
): Promise<ScriptRun> {
  const { session, masker } = runtime;
  const fail = (code: ErrorCode, message: string, extra: Partial<LaneFailure> = {}) =>
    laneFailure(t0, masker, code, message, { ...(version !== undefined ? { version } : {}), hash, blockedRequests: session.blockedRequests, ...extra });
  const interrupts = await installInterrupts(session.page, script.interrupts);
  // The start page: the document's startUrl, or steps[0] itself when startUrl came from its goto (never loaded twice).
  const plan = startPlan(input.script, script);
  const defaultTimeoutMs = input.defaultStepTimeoutMs ?? 8000;
  const startTimeoutMs = plan.firstStep === 1 ? (script.steps[0].timeoutMs ?? defaultTimeoutMs) : START_TIMEOUT_MS;
  const statusMode = input.startStatus ?? 'classify';
  const startedAt = Date.now();
  const start = await openStartPage(session.page, plan.url, { policy: input.policy, masker, timeoutMs: startTimeoutMs, waitUntil: plan.waitUntil });
  if (!startProceeds(start, statusMode)) {
    // A redirect hop's address check may still be pending: a late private hop must win over the start-page status.
    await session.idle();
    const f = startPageFailure(runtime, start, statusMode);
    return { result: fail(f.code, f.message, { violations: session.violations }) };
  }
  const state = newRunState();
  live.state = state;
  if (plan.firstStep === 1) {
    const s0 = script.steps[0];
    state.log.push({ index: 0, intent: s0.intent, status: 'ok', ms: Date.now() - startedAt, note: 'start page' });
    if (s0.checkpoint) state.lastCheckpoint = 0;
  }

  const ctx: StepContext = {
    page: session.page, script, policy: input.policy, secrets: input.secrets, vars: input.vars ?? {},
    masker, defaultTimeoutMs, violations: session.violations, interrupts, stepHooks: session.stepHooks,
    ...(input.output?.emptyPattern ? { emptyPattern: input.output.emptyPattern } : {}),
    ...(session.writeWindow ? { writeWindow: session.writeWindow } : {}),
    armSubmit: (target) => session.armSubmit(target),
  };
  // Once a write left the browser (any request the session let through that writes: a window POST, a submit, a download
  // through a form, a plain click on a form posting to an allowed submission), every result says so.
  const wrote = (s: RunState) => s.submitted || session.writesSent > 0;
  const loginEnd = capture ? loginBlockEnd(script) : -1;
  const seen: { postLoginUrl?: string; storageState?: StorageState; beforeDetect?: ScriptRun['beforeDetect'] } = {};
  const detectAt = loginDetectIndex(script, loginEnd);
  /** The session's cookies and storage and the page it is on, for prove to reuse instead of signing in again. */
  const snap = async () => {
    const storageState = await ctx.page.context().storageState().catch(() => undefined);
    return storageState ? { url: ctx.page.url(), storageState } : undefined;
  };
  const afterStep = async (i: number) => {
    // Right before the login block's detect: kept apart, used only if that detect fails.
    if (detectAt > 0 && i === detectAt - 1) { seen.beforeDetect = await snap(); return; }
    if (i !== loginEnd) return;
    // Right after sign-in: what prove reuses so it never submits the credentials a second time.
    const s = await snap();
    if (s) Object.assign(seen, { postLoginUrl: s.url, storageState: s.storageState });
  };
  const res = await runSteps(ctx, script.steps, state, { afterStep, startAt: plan.firstStep });
  // Address checks that finish after their request must land before the outcome is decided.
  await session.idle();
  const keep = { ctx, state: res.state, script, ...seen };
  if (!res.ok) {
    const screenshot = await failureScreenshot(ctx.page, input.secrets);
    const failure = { ...res.failure, intent: masker.mask(res.failure.intent), message: masker.mask(res.failure.message) };
    const base = {
      failure, violations: session.violations, log: maskLog(res.state.log, masker), screenshot,
      lastCheckpoint: res.state.lastCheckpoint, credentialsSubmitted: res.state.credentialsSubmitted,
      ...(wrote(res.state) ? { submitted: true } : {}),
    };
    const o = runtime.override(res.failure.intent, res.failure.message.startsWith(DETECTED_PREFIX));
    if (o) {
      // A step that only says it was stopped gets the violation's own message (off-list site, private address). So does
      // any step when the run ended on a private address: the step's own error is only a consequence of it.
      const firstFatal = session.violations.find((v) => v.fatal);
      const detail = res.failure.message === BLOCKED_STOP || firstFatal?.kind === 'private' ? o.message : res.failure.message;
      return { result: fail(o.code, o.code === 'policy_violation' ? masker.mask(`${res.failure.intent}: ${detail}`) : o.message, base), ...keep };
    }
    const pageText = await maskedPageText(ctx.page, masker);
    const loginConfirmed = Object.values(res.state.detected).includes('logged_in');
    const cls = classifyFailure({ violations: session.violations, failure: res.failure, pageText, loginConfirmed });
    return { result: fail(toErrorCode(cls), masker.mask(shownFailure(res.failure.intent, res.failure.message)), base), ...keep };
  }
  const tail = {
    violations: session.violations, log: maskLog(res.state.log, masker),
    lastCheckpoint: res.state.lastCheckpoint, credentialsSubmitted: res.state.credentialsSubmitted,
    ...(wrote(res.state) ? { submitted: true } : {}),
  };
  const o = runtime.override();
  if (o) return { result: fail(o.code, o.message, tail), ...keep };
  // Every capture and download of the run counts toward one cap.
  const tooMuch = runBinaryProblem(res.state);
  if (tooMuch) return { result: fail('incomplete', stripShownPrefix(tooMuch), tail), ...keep };
  // Row checks run only when an extract step ran, and only the configured ones.
  let verified = false;
  let confirmed = false;
  if (res.state.extractRan) {
    const v = verifyRows({
      rows: res.state.rows, evidence: res.state.evidence, output: input.output ?? {}, requireGrounding: true, ungroundedFields: res.state.attributeFields,
    });
    // Reasons quote row values (IDs can be URLs): shown like every other message.
    if (!v.ok) return { result: fail('incomplete', shownMessage(v.reasons.join('; '), masker), tail), ...keep };
    verified = true;
    confirmed = v.total !== null && v.total === res.state.rows.length;
  }
  const page = await pageInfo(ctx.page, session.lastDocument, masker);
  return {
    result: {
      ok: true, lane: 'script', name: script.name ?? null, version: version ?? null, hash, rows: res.state.rows, files: res.state.downloads,
      outputs: res.state.outputs,
      log: maskLog(res.state.log, masker), violations: maskViolations(session.violations, masker),
      blockedRequests: maskRequests(session.blockedRequests, masker),
      page, verified, confirmed,
      writes: (session.writeWindow?.posts ?? []).map((p) => ({ method: p.method, host: masker.mask(p.host), path: masker.mask(p.path) })),
      submitted: wrote(res.state),
      durationMs: Date.now() - t0,
    },
    ...keep,
  };
}

/**
 * Pre-flight (signature, shape, policy), then the guarded run. With `keepSessionOnDrift`, a drift failure returns the
 * live runtime (not disposed) so the agent lane can continue on the same page; otherwise the trace is attached as asked
 * and the session is closed.
 */
export async function startScriptLane(
  input: ScriptLaneInput, opts: { keepSessionOnDrift?: boolean; t0?: number } = {},
): Promise<{ run: ScriptRun; runtime?: LaneRuntime }> {
  const t0 = opts.t0 ?? Date.now();
  // Built first: the gate's messages carry names and hosts, and every result string is masked.
  const masker = laneMasker({ secrets: input.secrets, endpoint: input.endpoint, signingKey: input.trust.key });
  // The trust gate runs before the steps are parsed for the run and before any browser opens.
  const gate = checkTrust(input.script, input.trust, { policy: input.policy, firstRun: false });
  if (!gate.ok) return { run: { result: laneFailure(t0, masker, gate.code, masker.mask(gate.message)) } };
  let script: Script;
  try {
    script = parseScript(input.script, { defaultStartUrl: input.policy.startUrl });
  } catch (err) {
    return { run: { result: laneFailure(t0, masker, 'policy_violation', masker.mask((err as Error).message)) } };
  }
  const version = script.version;
  const hash = scriptHash(input.script);
  // The policy the run uses: block-and-log writes only for unsigned steps without a Site Login, and
  // for Run Steps without a Site Login the declared submit / download.via targets on navigation hosts as the allowed
  // submissions. Built before validation: its allowedSubmits are what the declared targets are checked against.
  const policy = effectivePolicy(input.policy, script, { signed: gate.signed, hasSecrets: input.secrets !== undefined });
  const laneInput: ScriptLaneInput = { ...input, policy };
  const policyResult = validateScript(script, { policy, secrets: input.secrets, mode: 'load' });
  if (!policyResult.ok) {
    // A load that breaks only limits is incomplete with the limit named; anything else is a policy violation.
    const onlyLimits = policyResult.violations.every((v) => v.startsWith(LIMIT_PREFIX));
    const message = policyResult.violations.map(stripShownPrefix).join('; ');
    return { run: { result: laneFailure(t0, masker, onlyLimits ? 'incomplete' : 'policy_violation', masker.mask(message), { version, hash }) } };
  }
  for (const [name, value] of Object.entries(input.vars ?? {})) {
    if (typeof value === 'string' && value.length > MAX_RENDERED) {
      return { run: { result: laneFailure(t0, masker, 'incomplete', masker.mask(stripShownPrefix(inputTooLong(name.slice(0, 100), MAX_RENDERED))), { version, hash }) } };
    }
  }
  if (input.signal?.aborted) return { run: { result: laneFailure(t0, masker, 'incomplete', CANCELLED, { version, hash }) } };
  let runtime: LaneRuntime;
  try {
    runtime = await openLaneRuntime({
      endpoint: input.endpoint, policy, masker, budgetMs: input.budgetMs, signal: input.signal,
      trace: traceOn(input.saveTrace), ...(input.viewport ? { viewport: input.viewport } : {}),
    });
  } catch (err) {
    // Cancelled while waiting for a free browser session: the caller's cancellation, not an unreachable browser.
    if (input.signal?.aborted) return { run: { result: laneFailure(t0, masker, 'incomplete', CANCELLED, { version, hash }) } };
    // A private address on the policy is a policy decision, not an unreachable browser.
    const code = err instanceof PolicyError ? 'policy_violation' : 'browser_unavailable';
    return { run: { result: laneFailure(t0, masker, code, masker.mask((err as Error).message), { version, hash }) } };
  }
  let run: ScriptRun;
  const live: { state?: RunState } = {};
  try {
    run = await executeScript(laneInput, script, runtime, t0, version, hash, !!opts.keepSessionOnDrift, live);
  } catch (err) {
    const message = shownMessage(String((err as Error)?.message ?? err), masker);
    const o = runtime.override();
    // Any write that went out before the throw still counts.
    const wrote = !!live.state?.submitted || runtime.session.writesSent > 0;
    const extra = {
      violations: runtime.session.violations, blockedRequests: runtime.session.blockedRequests, version, hash,
      ...(wrote ? { submitted: true } : {}),
    };
    run = { result: o ? laneFailure(t0, masker, o.code, o.code === 'policy_violation' ? message : o.message, extra) : laneFailure(t0, masker, 'incomplete', message, extra) };
  }
  const r = run.result;
  if (opts.keepSessionOnDrift && !r.ok && r.code === 'drift_detected' && run.ctx && !runtime.session.closed) return { run, runtime };
  try {
    if (wantTrace(input.saveTrace, r.ok)) {
      const trace = await stopTrace(runtime.session, { masker, policy }).catch(() => undefined);
      if (trace) run = { ...run, result: { ...r, trace } };
    }
  } finally {
    await runtime.dispose();
  }
  return { run };
}

/**
 * Runs an approved script: verifies the signature, parses and policy-checks it, opens a guarded browser
 * session, runs the steps under the run budget, then verifies rows (grounded) or file outputs. Never throws;
 * every outcome is a LaneResult. Precedence on failure: policy_violation, browser_unavailable (disconnect),
 * cancellation, budget, then step classification.
 */
export async function runScriptLane(input: ScriptLaneInput): Promise<LaneResult> {
  return (await startScriptLane(input)).run.result;
}
