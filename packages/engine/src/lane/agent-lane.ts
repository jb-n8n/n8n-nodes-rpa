import { DEFAULT_MAX_ACTIONS, DEFAULT_MAX_TOKENS, modelErrorText, runAgentLoop, type AgentLoopResult } from '../agent/loop.js';
import type { AgentAction } from '../agent/tools.js';
import type { StorageState } from '../browser/session.js';
import { classifyFailure, stripShownPrefix } from '../classify/classify.js';
import { runBinaryProblem } from '../steps/limits.js';
import type { DownloadTemplate } from '../steps/file-check.js';
import { CompileError, compileProposal, type CompileResult } from '../compile/compile.js';
import { AGENT_SIGN_IN_UNFINISHED, agentSignInLocked, agentSignInRejected, FILE_NOT_DELIVERABLE, FILE_WITHHELD, ROWS_WITHHELD } from '../messages.js';
import { noWritePolicy } from '../policy/derive.js';
import { flattenSteps, loginBlockEnd } from '../policy/validate.js';
import { buildProposal, proposalDigest, type Proposal } from '../proposal/proposal.js';
import { openReusedSession } from '../prove/entry.js';
import type { ProveResult } from '../prove/prove.js';
import { maskRequests, maskViolations, type Masker } from '../secrets/mask.js';
import { isLoginPage } from '../steps/handlers/auth.js';
import { binaryName } from '../steps/handlers/files.js';
import { isVisibleNow } from '../steps/locator.js';
import { newRunState, type StepContext } from '../steps/run.js';
import { stopTrace, wantTrace } from '../trace/trace.js';
import { maskSessionSegments, shownMessage } from '../steps/urls.js';
import type { ChatModel } from '../agent/model.js';
import type { ErrorCode, RunState, Script, StepFailure, Violation } from '../types.js';
import { verifyRows } from '../verify/verify.js';
import { runProve } from './prove-run.js';
import { maskedPageText, pageInfo } from './start-page.js';
import { CANCELLED, laneFailure, maskLog, traceOn, type LaneRuntime } from './script-lane.js';
import type { AgentActionSummary, RepairInput, TaskFailure, TaskInput, TaskResult } from './task.js';

export const PROVE_RESERVE_MS = 60_000;
/** Upper bounds of Max Agent Actions and Max LLM Tokens; the lower bounds are 1 and 1,000. */
export const MAX_AGENT_ACTIONS = 200;
export const MAX_AGENT_TOKENS = 1_000_000;
const MIN_AGENT_TOKENS = 1000;

/** The agent lane's caps: finite numbers are clamped into range; anything else (NaN would disable a cap) falls back to the default. */
export function clampAgentBudget(b?: { maxActions?: number; maxTokens?: number }): { maxActions: number; maxTokens: number } {
  const clamp = (v: number | undefined, lo: number, hi: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : fallback;
  return {
    maxActions: clamp(b?.maxActions, 1, MAX_AGENT_ACTIONS, DEFAULT_MAX_ACTIONS),
    maxTokens: clamp(b?.maxTokens, MIN_AGENT_TOKENS, MAX_AGENT_TOKENS, DEFAULT_MAX_TOKENS),
  };
}
/** Prefixes of runAgentLoop's 'error' notes. */
const MODEL_FAILED = 'the model call failed: ';
const PAGE_UNREADABLE = 'the page could not be read';

export interface Handoff {
  runtime: LaneRuntime;
  ctx: StepContext;
  prior: RunState;
  base?: Script;
  failure?: StepFailure;
  /** Where the script lane's login block ended, and the session state at that moment (repair runs only). */
  postLoginUrl?: string;
  storageState?: StorageState;
  /** The session state right before the login block's detect, for a heal whose drift is that detect. */
  beforeDetect?: { url: string; storageState: StorageState };
  screenshot?: Buffer;
  version?: number;
  hash?: string;
  /** What this repair produces: rows, or one checked file (`download`: the checks it must pass, bound into compile). */
  kind: 'rows' | 'file';
  download?: DownloadTemplate;
  t0: number;
}
/** The healing session once it was released before prove: its trace (when tracing was on) is kept for the result. */
interface Released {
  done: boolean;
  trace?: Buffer;
}
interface Attempt {
  loop: AgentLoopResult;
  state: RunState;
}

/**
 * Attaches the trace as asked and disposes the runtime (unless it was already released before prove). Under
 * 'onFailure', agent rows that prove did not confirm count as a failure: their trace is kept too.
 */
export async function finishLane(input: TaskInput, runtime: LaneRuntime, result: TaskResult, released?: Released): Promise<TaskResult> {
  let out = result;
  const unconfirmed = out.ok && out.lane === 'agent' && !out.confirmed;
  const keep = wantTrace(input.saveTrace, out.ok && !unconfirmed);
  // A trace already on the result (prove's, after a blocked request in prove) wins over the healing trace.
  if (released?.done) return keep && !out.trace && released.trace ? { ...out, trace: released.trace } : out;
  try {
    if (keep) {
      const trace = await stopTrace(runtime.session, { masker: runtime.masker, policy: input.policy }).catch(() => undefined);
      if (trace) out = { ...out, trace };
    }
  } finally {
    await runtime.dispose();
  }
  return out;
}

/** The model with every invoke counted before it is sent: the count survives a throw anywhere in the agent lane. */
function countingModel(model: ChatModel, calls: { n: number }): ChatModel {
  return {
    bindTools(defs) {
      const bound = model.bindTools(defs);
      return { invoke(messages, options) { calls.n++; return bound.invoke(messages, options); } };
    },
  };
}

export async function agentLane(input: TaskInput, original: RepairInput, h: Handoff): Promise<TaskResult> {
  // Every agent-lane result carries llmCalls, the thrown path included.
  const calls = { n: 0 };
  const repair: RepairInput = { ...original, model: countingModel(original.model, calls) };
  // Repair never writes: from the first agent turn on only declared login POSTs pass, even if allowedSubmits lists the form.
  const noWrites = noWritePolicy(input.policy);
  h.runtime.session.restrict(noWrites);
  h.ctx.policy = noWrites;
  // Agent actions never get the Fill and Submit window (restrict() already closed it on the session side).
  h.ctx.writeWindow = undefined;
  h.ctx.writeStep = false;
  const { session, masker } = h.runtime;
  const released: Released = { done: false };
  // Before prove: keep the healing trace and close the healing browser (prove needs only the state captured at login).
  const release = async () => {
    if (released.done) return;
    released.done = true;
    try {
      if (traceOn(input.saveTrace)) released.trace = await stopTrace(session, { masker, policy: input.policy }).catch(() => undefined);
    } finally {
      await h.runtime.dispose();
    }
  };
  let result: TaskResult;
  try {
    result = await agentLaneBody(input, repair, h, release);
  } catch (err) {
    // Once released, the session reads as closed by the caller: it no longer says anything about cancellation.
    const o = released.done ? null : h.runtime.override();
    const message = o && o.code !== 'policy_violation' ? o.message : shownMessage(String((err as Error)?.message ?? err), masker);
    result = {
      ...laneFailure(h.t0, masker, o?.code ?? 'incomplete', message, {
        violations: session.violations, blockedRequests: session.blockedRequests,
        ...(h.version !== undefined ? { version: h.version } : {}), ...(h.hash ? { hash: h.hash } : {}),
      }),
      lane: 'agent', llmCalls: calls.n,
    };
  }
  // A write the script lane sent before the hand-off still happened: every result says so. runTask
  // refuses repair once a write went out, so this is defence in depth; agent and prove sessions never write.
  const wrote = h.prior.submitted || session.writesSent > 0;
  if (result.ok && result.lane === 'agent') result = { ...result, submitted: wrote };
  else if (!result.ok && wrote) result = { ...result, submitted: true };
  return finishLane(input, h.runtime, result, released);
}

function summarize(actions: AgentAction[], masker: Masker): AgentActionSummary[] {
  return actions.map((a) => ({
    tool: a.tool, ok: a.ok, url: masker.mask(maskSessionSegments(a.url)),
    ...(a.step ? { intent: masker.mask(a.step.intent) } : {}),
    ...(a.note ? { note: shownMessage(a.note, masker) } : {}),
  }));
}

/** Agent state for a new attempt: no rows yet, but what the run already did to sign in carries over. */
function carryState(from: RunState): RunState {
  const state = newRunState();
  state.credentialsSubmitted = from.credentialsSubmitted;
  state.submitClicked = from.submitClicked;
  state.detected = { ...from.detected };
  return state;
}

/**
 * The failed base download whose trigger click went through without a file (RunState.clickedTrigger), when compile
 * must replay that click: the agent went on from the page it left (a format dialog, say). Only for the attempt that
 * resumed from the drift point (`fromDrift`); an escalation restarts after login and the agent redoes its own clicks.
 */
export function triggerClickToKeep(h: Pick<Handoff, 'base' | 'failure' | 'prior'>, fromDrift: boolean): { index: number } | undefined {
  const index = h.failure?.index;
  if (!fromDrift || index === undefined || h.prior.clickedTrigger?.index !== index) return undefined;
  const failed = h.base?.steps[index];
  return failed && 'download' in failed && failed.download.via === undefined ? { index } : undefined;
}

/**
 * After the agent's own sign_in, whether the run ended on a login outcome: lock wording on the page (classifyFailure,
 * ignored once the sign-in visibly went through) → account_locked; still on a declared login page with the password
 * field showing → login_failed (the site rejected the credentials). Undefined otherwise. When the agent lane is what
 * clicked the submit button (`submittedHere`: `submitClicked` flipped in the agent lane), the last sign_in counts even
 * if it failed after that click; a sign_in that failed while filling the form (before the click) stays auth_blocked.
 */
async function signInOutcome(
  ctx: StepContext, actions: AgentAction[], state: RunState, submittedHere: boolean,
): Promise<'account_locked' | 'login_failed' | undefined> {
  const at = actions.findLastIndex((a) => a.tool === 'sign_in' && (a.ok || (submittedHere && !!a.step && 'signIn' in a.step)));
  const signIn = actions[at];
  if (!signIn?.step || !('signIn' in signIn.step)) return undefined;
  const onLogin = isLoginPage(ctx.policy, ctx.page.url());
  const leftLogin = actions.slice(at + 1).some((a) => a.url && !isLoginPage(ctx.policy, a.url));
  const loginConfirmed = Object.values(state.detected).includes('logged_in') || (!onLogin && leftLogin);
  const pageText = await maskedPageText(ctx.page, ctx.masker);
  if (classifyFailure({ violations: [], pageText, loginConfirmed }) === 'account_locked') return 'account_locked';
  if (onLogin && (await isVisibleNow(ctx.page, signIn.step.signIn.password).catch(() => false))) return 'login_failed';
  return undefined;
}

async function agentLaneBody(input: TaskInput, repair: RepairInput, h: Handoff, release: () => Promise<void>): Promise<TaskResult> {
  const { model } = repair;
  const { runtime, ctx } = h;
  const { session, masker } = runtime;
  const reserve = Math.min(PROVE_RESERVE_MS, Math.floor(runtime.budget * 0.4));
  const agentDeadline = runtime.deadline - reserve;
  // Caps on the whole agent lane.
  const { maxActions, maxTokens } = clampAgentBudget(repair.agentBudget);
  const loginEnd = h.base ? loginBlockEnd(h.base) : -1;
  const resumeFrom = h.base && h.failure ? h.failure.index - 1 : -1;
  // A repair that resumed past the post-login page may escalate once to it; the first attempt keeps half the actions for that.
  const canEscalate = !!h.base && !!h.postLoginUrl && !!h.storageState && resumeFrom > loginEnd;
  const failure = h.failure ? { intent: h.failure.intent, message: h.failure.message } : undefined;

  // The approved steps after the one that failed, as a hint about where the data was. Navigation only: sign-in,
  // its checks and conditional pop-up steps say nothing about the route.
  const route = h.base && h.failure
    ? h.base.steps.slice(h.failure.index + 1).filter((st) => !('signIn' in st) && !('detect' in st) && !st.when).map((st) => st.intent)
    : [];
  const attempt = async (state: RunState, why: typeof failure, actions: number, tokens: number): Promise<Attempt> => ({
    state,
    loop: await runAgentLoop({
      ctx, state, model, goal: repair.goal, output: input.output ?? {}, ...(why ? { failure: why } : {}), ...(route.length ? { route } : {}),
      ...(h.download ? { download: h.download } : {}),
      budget: { maxActions: actions, maxTokens: tokens, deadlineMs: agentDeadline }, signal: input.signal,
    }),
  });
  const attempts: Attempt[] = [await attempt(carryState(h.prior), failure, canEscalate ? Math.ceil(maxActions / 2) : maxActions, maxTokens)];
  let compileFrom = resumeFrom;

  const first = attempts[0];
  const actionsLeft = maxActions - first.loop.actions.length;
  const tokensLeft = maxTokens - first.loop.tokens;
  if (
    canEscalate && failure && (first.loop.outcome === 'not_found' || first.loop.outcome === 'budget')
    && !runtime.override() && !input.signal?.aborted && Date.now() < agentDeadline && actionsLeft > 0 && tokensLeft > 0
  ) {
    // The work's entry page (the goto right after the login block, else the start URL), as prove opens it, not
    // the page URL captured after sign-in: a portal that keeps window state on the server has moved that window on since.
    const base = h.base as Script;
    const timeout = Math.max(1000, Math.min(30_000, agentDeadline - Date.now()));
    const opened = await openReusedSession(ctx.page, {
      script: base, from: loginEnd + 1, policy: ctx.policy, masker, capturedUrl: h.postLoginUrl as string, timeoutMs: timeout,
      stopped: () => !!runtime.override(),
    });
    const { start } = opened;
    const loaded = start.error === undefined && start.responded && start.status !== null && start.status < 400;
    if (loaded && !isLoginPage(ctx.policy, ctx.page.url()) && !runtime.override()) {
      const why = {
        intent: failure.intent,
        message: `${failure.message}. A first attempt from that page ended without the data (${first.loop.note}), so the engine reopened the start of the work right after sign-in`,
      };
      attempts.push(await attempt(carryState(first.state), why, actionsLeft, tokensLeft));
      // Restarted on the base's own goto: that goto stays in the compiled steps, so the proof opens the same page.
      compileFrom = opened.atEntry && opened.entry?.fromGoto ? loginEnd + 1 : loginEnd;
    }
  }

  const last = attempts[attempts.length - 1];
  const { loop, state } = last;
  const allActions = attempts.flatMap((a) => a.loop.actions);
  const agentLog = summarize(allActions, masker);
  const tokens = attempts.reduce((n, a) => n + a.loop.tokens, 0);
  const llmCalls = attempts.reduce((n, a) => n + a.loop.llmCalls, 0);
  const transcript = attempts.flatMap((a) => a.loop.transcript);
  // The script lane's steps come first: the log covers the whole run. Each agent action runs as a one-step list (index
  // 0), so agent entries are renumbered to count up after the script lane's last index, as the script lane does.
  const nextIndex = h.prior.log.reduce((n, e) => Math.max(n, e.index + 1), 0);
  const agentEntries = attempts.flatMap((a) => a.state.log).map((e, k) => ({ ...e, index: nextIndex + k }));
  const log = maskLog([...h.prior.log, ...agentEntries], masker);
  const extra = { lane: 'agent' as const, agentLog, tokens, llmCalls, transcript };
  const scriptFailure = h.failure ? { failure: { ...h.failure, intent: masker.mask(h.failure.intent), message: masker.mask(h.failure.message) } } : {};
  // Messages carry model notes, prove reasons and compile issues: every URL in them is shown without query string.
  const fail = (code: ErrorCode, message: string, more: Violation[] = []): TaskFailure => ({
    ...laneFailure(h.t0, masker, code, shownMessage(message, masker), {
      violations: [...session.violations, ...more], blockedRequests: session.blockedRequests, log, ...scriptFailure,
      ...(h.version !== undefined ? { version: h.version } : {}), ...(h.hash ? { hash: h.hash } : {}),
    }),
    ...extra,
  });

  await session.idle();
  const o = runtime.override();
  if (o) return fail(o.code, o.message);
  if (input.signal?.aborted) return fail('incomplete', CANCELLED);
  // A two-page sign_in: a username the site sent back is a rejected login; a sign-in left on the password
  // page never signed in, whatever the agent reported (its credentials are spent for this run).
  if (attempts.some((a) => a.loop.signInStage === 'username_rejected')) return fail('login_failed', agentSignInRejected(loop.note));
  if (attempts.some((a) => a.loop.signInStage === 'pending')) return fail('auth_blocked', `${AGENT_SIGN_IN_UNFINISHED}: ${loop.note}`);
  if (loop.outcome !== 'found') {
    const auth = await signInOutcome(ctx, allActions, state, !h.prior.submitClicked && state.submitClicked);
    if (auth === 'account_locked') return fail('account_locked', agentSignInLocked(loop.note));
    if (auth === 'login_failed') return fail('login_failed', agentSignInRejected(loop.note));
  }
  if (loop.outcome === 'blocked') return fail('auth_blocked', `the agent could not continue: ${loop.note}`);
  if (loop.outcome === 'not_found') return fail('not_found', `the agent did not find the data: ${loop.note}`);
  if (loop.outcome === 'budget') return fail('incomplete', `the agent ran out of budget: ${loop.note}`);
  if (loop.outcome === 'error') {
    // 'error' is infrastructure: the model failed or went silent (or, rarely, the page could not be read at all).
    if (loop.note.startsWith(PAGE_UNREADABLE)) return fail('incomplete', `the agent could not continue: ${loop.note}`);
    const cause = loop.note.startsWith(MODEL_FAILED) ? loop.note.slice(MODEL_FAILED.length) : loop.note;
    return fail('incomplete', `model unavailable: ${modelErrorText(cause, masker)}`);
  }
  // The script lane's captures and downloads are carried into the result: the run-wide binary cap still applies.
  const tooMuch = runBinaryProblem(h.prior);
  if (tooMuch) return fail('incomplete', stripShownPrefix(tooMuch));
  if (h.kind === 'file') {
    // A file task's result is the one file the agent downloaded (the download tool keeps only a file that passed the checks).
    if (state.downloads.length !== 1) return fail('incomplete', 'the agent did not download a file that passed the checks');
  } else {
    const v = verifyRows({ rows: state.rows, evidence: state.evidence, output: input.output ?? {}, requireGrounding: true, ungroundedFields: state.attributeFields });
    if (!v.ok) return fail('incomplete', v.reasons.join('; '));
  }
  // Read before prove: release() closes this page.
  const page = await pageInfo(ctx.page, session.lastDocument, masker);

  let compiled: CompileResult | undefined;
  let compileIssues: string[] | undefined;
  const keepTriggerClick = triggerClickToKeep(h, attempts.length === 1 && compileFrom === resumeFrom);
  try {
    compiled = compileProposal({
      base: h.base, resumeFrom: compileFrom, actions: loop.actions,
      // Repaired steps are named steps.name ?? Options → Name; a first run's script already carries repair.name.
      ...((h.base?.name ?? repair.name) !== undefined ? { name: (h.base?.name ?? repair.name) as string } : {}),
      startUrl: h.base?.startUrl ?? input.policy.startUrl,
      version: (h.base?.version ?? 0) + 1, policy: input.policy, secrets: input.secrets, observedNavigations: [...session.navigations],
      // Raw run vars (typed values equal to one become {{var.<name>}}); a file task's checks must survive compile unchanged.
      ...(input.vars ? { vars: input.vars } : {}), ...(h.download ? { download: h.download } : {}),
      // The script lane's trigger click opened what the agent used (a format dialog): the proof must replay it.
      ...(keepTriggerClick ? { keepTriggerClick } : {}),
    });
  } catch (err) {
    if (!(err instanceof CompileError)) throw err;
    // Issues reach the result and the ROWS_WITHHELD reason: shown like every other message.
    compileIssues = err.issues.map((i) => shownMessage(i, masker));
  }
  let prove: ProveResult | undefined;
  let proposal: Proposal | undefined;
  if (compiled) {
    await release();
    // A blocked request recorded while the healing session closed still ends the run.
    if (session.violations.some((v) => v.fatal)) return fail('policy_violation', 'a blocked request was attempted during the run');
    prove = await runProve(input, h, loop, compiled, state.rows);
    if (input.signal?.aborted) return fail('incomplete', CANCELLED);
    if (prove.policyViolation) {
      // The prove trace (scrubbed) shows the blocked request: it replaces the healing trace.
      const out = fail('policy_violation', 'the compiled script attempted a blocked request during prove', prove.violations);
      return prove.trace ? { ...out, trace: prove.trace } : out;
    }
    if (prove.ok) {
      proposal = buildProposal({
        base: h.base, script: compiled.script, prove, safetyFlags: compiled.safetyFlags, masker,
        ...(h.screenshot ? { beforeScreenshot: h.screenshot } : {}), ...(prove.screenshot ? { afterScreenshot: prove.screenshot } : {}),
        ...(prove.trace ? { proofTrace: prove.trace } : {}),
      });
    }
  }
  // Agent-lane rows reach the caller only when the proof passed, or with Deliver Unconfirmed
  // Rows on. A file reaches the caller only when the proof passed, whatever Deliver Unconfirmed Rows says. A replay
  // that hit a login failure keeps that code, so the login breaker still trips.
  const isFile = h.kind === 'file';
  if (prove?.ok !== true && (isFile || !repair.deliverUnconfirmed)) {
    const code: ErrorCode = prove?.failureCode === 'login_failed' || prove?.failureCode === 'account_locked' ? prove.failureCode : 'incomplete';
    // The golden text stays the prefix; why the proof did not pass follows (the first prove reason, else the first compile issue).
    const why = prove?.reasons[0] ?? compileIssues?.[0];
    const withheld = isFile ? FILE_WITHHELD : ROWS_WITHHELD;
    return fail(code, why ? `${withheld}. Reason: ${why}` : withheld);
  }
  // A proven file task: the agent's file, named like the compiled download step's output on a normal run. Without a
  // download step to name it or a file to deliver, the task fails: a file task never succeeds with no file.
  const downloadAt = compiled ? compiled.script.steps.findIndex((st) => flattenSteps([st]).some((x) => 'download' in x)) : -1;
  const got = state.downloads[0];
  if (isFile && (downloadAt < 0 || !got)) return fail('incomplete', FILE_NOT_DELIVERABLE);
  const files = !isFile ? h.prior.downloads : got ? [{ ...got, binaryName: binaryName(newRunState(), 'download', downloadAt) }] : [];
  return {
    ok: true, lane: 'agent', name: h.base?.name ?? null, version: h.version ?? null, hash: h.hash ?? null,
    rows: state.rows, files, page, outputs: h.prior.outputs, confirmed: isFile ? !!prove?.ok : !!prove?.ok && prove.total !== null,
    ...(proposal ? { proposal, digest: proposalDigest(proposal) } : {}),
    ...(prove ? {
      prove: {
        ok: prove.ok, total: prove.total, reasons: prove.reasons.map((x) => masker.mask(x)),
        diff: { missing: prove.diff.missing.map((x) => masker.mask(x)), extra: prove.diff.extra.map((x) => masker.mask(x)) },
        ...(prove.failureCode ? { failureCode: prove.failureCode } : {}),
        ...(prove.file ? { file: prove.file } : {}),
      },
    } : {}),
    ...(compileIssues ? { compileIssues } : {}),
    agentLog, log, violations: maskViolations(session.violations, masker),
    blockedRequests: maskRequests(session.blockedRequests, masker),
    tokens, llmCalls, durationMs: Date.now() - h.t0, note: shownMessage(loop.note, masker), transcript, submitted: false,
  };
}
