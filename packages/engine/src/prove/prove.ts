import { classifyFailure, toErrorCode } from '../classify/classify.js';
import { openSession, type Session, type StorageState } from '../browser/session.js';
import { maskedPageText, openStartPage } from '../lane/start-page.js';
import { openReusedSession } from './entry.js';
import { signInIndex } from '../policy/login-block.js';
import { flattenSteps, loginBlockEnd } from '../policy/validate.js';
import { fileEvidence, type FileEvidence } from '../proposal/evidence.js';
import { maskViolations, type Masker } from '../secrets/mask.js';
import { msUntilNextWindow } from '../secrets/totp.js';
import { stopTrace } from '../trace/trace.js';
import { installInterrupts } from '../steps/interrupts.js';
import { screenshotMasks } from '../steps/masks.js';
import { sleep } from '../steps/poll.js';
import { hostOf, isLoginPage, shownMessage } from '../steps/urls.js';
import { runSteps, type StepContext } from '../steps/run.js';
import type { BrowserEndpoint, CodeProvider, OutputSpec, ErrorCode, PortalPolicy, PortalSecrets, Row, Script, Violation } from '../types.js';
import { verifyRows } from '../verify/verify.js';

const TOTP_WINDOW_MS = 30_000;

export interface ProveInput {
  script: Script;
  policy: PortalPolicy;
  /** Site Login secrets; absent without a Site Login. */
  secrets?: PortalSecrets;
  /** A full replay's signIn with totp.source 'workflow' asks this for the code (the run's codeProvider). */
  codeProvider?: CodeProvider;
  codeTimeoutMs?: number;
  vars?: Record<string, string>;
  output: OutputSpec;
  endpoint: BrowserEndpoint;
  masker: Masker;
  /**
   * Post-login state of the healing session. With postLoginUrl, prove skips the login block and opens the work's entry page
   * with these cookies (the goto at the resumed step, else the script's startUrl; see prove/entry.ts), falling
   * back to postLoginUrl (the page captured then) when the entry page does not load or lands on a login page.
   */
  storageState?: StorageState;
  postLoginUrl?: string;
  /**
   * With storageState: the step the reused session resumes at. Default: right after the login block. Inside the login
   * block only after the sign-in (when the state was captured before a detect the agent re-anchored, so the new
   * detect runs here too). Steps before it are skipped, so none of them may be the agent's (checkFallbacksFrom).
   */
  resumeAt?: number;
  defaultStepTimeoutMs?: number;
  budgetMs: number;
  /** The agent's rows, for the reported difference (never a pass criterion). */
  agentRows: Row[];
  /** Steps from this index on were built by the agent: if one of them matches only by a fallback, prove fails. */
  checkFallbacksFrom?: number;
  /** Epoch ms of the agent's last TOTP code; a full replay waits for the next 30 s window after it. */
  freshTotpAfter?: number;
  /** Cancels the proof: the session is closed and the result is ok:false. */
  signal?: AbortSignal;
  /** Absolute epoch ms of the run deadline; prove never runs past min(deadlineMs, now + budgetMs). */
  deadlineMs?: number;
  /** Record a Playwright trace of the prove session; it is returned (scrubbed) once the steps ran or prove hit a blocked request. */
  trace?: boolean;
  /** The run's browser viewport; Playwright's default when absent. */
  viewport?: { width: number; height: number };
  /** A file task: the proof passes on exactly one downloaded file (its step's checks already passed), not on rows. */
  expectFile?: boolean;
}
export interface ProveResult {
  ok: boolean;
  rows: Row[];
  total: number | null;
  /** Masked reasons; empty when ok. */
  reasons: string[];
  diff: { missing: string[]; extra: string[] };
  screenshot?: Buffer;
  /** Set when a full replay failed on a step (login_failed, account_locked, auth_blocked, ...). */
  failureCode?: ErrorCode;
  /** True when the candidate script attempted a blocked request during prove (a security event, not a plain failure). */
  policyViolation: boolean;
  /** The policy's read-only POST entries the proof session used (labels, first-use order); empty when none. */
  readPosts: string[];
  /** The prove session's fatal violations (URLs masked), present when policyViolation is true. */
  violations?: Violation[];
  /**
   * The scrubbed prove-session trace, when `trace` was asked for and the steps ran (or a request was blocked): the new steps
   * replayed alone in a fresh browser, one "Proof: …" group per step. A passing proof attaches it to the proposal for the reviewer.
   */
  trace?: Buffer;
  /** A file task's proof: the one file it downloaded (strings masked, columns clipped). */
  file?: FileEvidence;
}


/** Replays a candidate script in a fresh browser with no LLM and judges it. Never throws. */
export async function proveScript(input: ProveInput): Promise<ProveResult> {
  try {
    return await proveInner(input);
  } catch (err) {
    // The inner run closes its own session in a finally; all that is left is a masked reason.
    const message = err instanceof Error ? err.message : String(err);
    let reason: string;
    try { reason = shownMessage(`prove failed unexpectedly: ${message}`, input.masker); } catch { reason = 'prove failed unexpectedly'; }
    return { ok: false, rows: [], total: null, reasons: [reason], diff: { missing: [], extra: [] }, policyViolation: false, readPosts: [] };
  }
}

async function proveInner(input: ProveInput): Promise<ProveResult> {
  const { script, policy, masker } = input;
  const idsOf = (rows: Row[]) => rows.flatMap((r) => (typeof r.id === 'string' ? [r.id] : []));
  const agentIds = new Set(idsOf(input.agentRows));
  const reasons: string[] = [];
  let blocked: Violation[] | undefined;
  let proofSession: Session | undefined;
  let file: FileEvidence | undefined;
  const finish = (rows: Row[], total: number | null, screenshot?: Buffer, failureCode?: ErrorCode): ProveResult => {
    const ids = new Set(idsOf(rows));
    // Reasons reach messages (ROWS_WITHHELD): masked, URLs without query string, masked again.
    const unique = [...new Set(reasons.map((r) => shownMessage(r, masker)))];
    return {
      ok: unique.length === 0, rows, total, reasons: unique,
      diff: { missing: [...agentIds].filter((id) => !ids.has(id)), extra: [...ids].filter((id) => !agentIds.has(id)) },
      ...(screenshot ? { screenshot } : {}),
      ...(failureCode ? { failureCode } : {}),
      policyViolation: blocked !== undefined,
      readPosts: proofSession ? [...proofSession.readPostsUsed] : [],
      ...(blocked ? { violations: maskViolations(blocked, masker) } : {}),
      ...(file ? { file } : {}),
    };
  };
  /** Records the session's fatal violations; true when there was one. */
  const blockedIn = (violations: Violation[]): boolean => {
    const fatal = violations.filter((v) => v.fatal);
    if (fatal.length === 0) return false;
    blocked = fatal;
    reasons.push('prove attempted a blocked request');
    return true;
  };

  const startedAt = Date.now();
  const deadline = Math.min(input.deadlineMs ?? Infinity, startedAt + input.budgetMs);
  if (input.signal?.aborted) { reasons.push('prove cancelled'); return finish([], null); }
  if (!(input.budgetMs > 0) || deadline <= startedAt) { reasons.push('no time left for prove'); return finish([], null); }
  if ((input.storageState === undefined) !== (input.postLoginUrl === undefined)) {
    reasons.push('storageState and postLoginUrl must be given together'); return finish([], null);
  }
  const end = loginBlockEnd(script);
  const skipLogin = input.storageState !== undefined && input.postLoginUrl !== undefined && end >= 0;
  const resumeAt = input.resumeAt ?? end + 1;
  if (skipLogin && input.resumeAt !== undefined) {
    const signInAt = signInIndex(script);
    if (!Number.isInteger(resumeAt) || resumeAt <= signInAt || resumeAt > end) {
      reasons.push('prove can resume the healing session only inside the login block, after the sign-in'); return finish([], null);
    }
  }
  if (skipLogin && input.checkFallbacksFrom !== undefined && input.checkFallbacksFrom < resumeAt) {
    reasons.push('the agent changed the login block; prove cannot reuse the session'); return finish([], null);
  }
  const steps = skipLogin ? script.steps.slice(resumeAt) : script.steps;
  const offset = script.steps.length - steps.length;
  const startUrl = skipLogin ? (input.postLoginUrl as string) : script.startUrl;
  if (!policy.navHosts.includes(hostOf(startUrl))) { reasons.push('the prove start page is not on an allowed host'); return finish([], null); }
  if (steps.length === 0) { reasons.push('there are no steps to prove after the login block'); return finish([], null); }
  if (!skipLogin && input.freshTotpAfter !== undefined && script.steps.some((s) => 'signIn' in s && s.signIn.totp)) {
    // Never reuse the code the agent just typed: wait for the next TOTP window.
    if (Math.floor(Date.now() / TOTP_WINDOW_MS) === Math.floor(input.freshTotpAfter / TOTP_WINDOW_MS)) {
      const wait = msUntilNextWindow(Date.now()) + 250;
      if (Date.now() + wait >= deadline) { reasons.push('no time left for prove to wait for a fresh sign-in code'); return finish([], null); }
      await sleep(wait);
    }
  }
  if (input.signal?.aborted) { reasons.push('prove cancelled'); return finish([], null); }
  if (Date.now() >= deadline) { reasons.push('no time left for prove'); return finish([], null); }

  let session: Session;
  try {
    session = await openSession({
      endpoint: input.endpoint, policy, masker, ...(skipLogin ? { storageState: input.storageState } : {}), ...(input.trace ? { trace: true } : {}),
      ...(input.viewport ? { viewport: input.viewport } : {}),
      deadlineMs: deadline, ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (err) {
    if (input.signal?.aborted) { reasons.push('prove cancelled'); return finish([], null); }
    reasons.push(`could not open a browser to prove the script: ${(err as Error).message}`);
    return finish([], null);
  }
  proofSession = session;
  let timedOut = false;
  let cancelled = false;
  const onAbort = () => { cancelled = true; void session.close('caller'); };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; void session.close('budget'); }, Math.max(1, deadline - Date.now()));
  /** Adds the session's scrubbed trace when tracing was on (before the finally closes the session). */
  const traced = async (out: ProveResult): Promise<ProveResult> => {
    const trace = input.trace ? await stopTrace(session, { masker, policy }).catch(() => undefined) : undefined;
    return trace ? { ...out, trace } : out;
  };
  /** The result for a blocked request, with the session's scrubbed trace when tracing was on. */
  const finishBlocked = (rows: Row[]): Promise<ProveResult> => traced(finish(rows, null));
  try {
    if (input.signal?.aborted) onAbort();
    const interrupts = await installInterrupts(session.page, script.interrupts);
    // The work's entry page with the reused session; the re-anchored-detect resume path (resumeAt, inside the login block)
    // keeps opening the captured post-login URL, where the steps it resumes were recorded.
    const start = skipLogin && input.resumeAt === undefined
      ? (await openReusedSession(session.page, {
        script, from: resumeAt, policy, masker, capturedUrl: startUrl, stopped: () => cancelled || session.violations.some((v) => v.fatal),
      })).start
      : await openStartPage(session.page, startUrl, { policy, masker });
    if (blockedIn(session.violations)) return await finishBlocked([]);
    if (cancelled) { reasons.push('prove cancelled'); return finish([], null); }
    if (skipLogin && isLoginPage(policy, session.page.url())) {
      reasons.push('the healing session expired before prove could reuse it: the post-login page redirected to the login page');
      return finish([], null);
    }
    // Unlike the script lane, prove also fails when goto returned no response (a 401/403 login page still proceeds).
    if (start.error !== undefined || !start.responded || !start.proceed) {
      reasons.push(`the prove start page did not load${start.responded ? ` (HTTP ${start.status})` : ''}`);
      return finish([], null);
    }
    const ctx: StepContext = {
      page: session.page, script, policy, secrets: input.secrets, vars: input.vars ?? {}, masker,
      ...(input.codeProvider ? { codeProvider: input.codeProvider } : {}), ...(input.codeTimeoutMs !== undefined ? { codeTimeoutMs: input.codeTimeoutMs } : {}),
      defaultTimeoutMs: input.defaultStepTimeoutMs ?? 8000, violations: session.violations, interrupts, stepHooks: session.stepHooks,
    };
    const run = await runSteps(ctx, steps, undefined, { label: 'Proof' });
    await session.idle();
    const shot = () => ctx.page.screenshot({ fullPage: true, mask: screenshotMasks(ctx.page, input.secrets) }).catch(() => undefined);
    if (blockedIn(session.violations)) return await finishBlocked(run.state.rows);
    if (cancelled) { reasons.push('prove cancelled'); return finish(run.state.rows, null); }
    if (timedOut) { reasons.push(`prove ran out of time after ${input.budgetMs} ms`); return finish(run.state.rows, null); }
    if (!run.ok) {
      reasons.push(`${run.failure.intent}: ${run.failure.message}`);
      let failureCode: ErrorCode | undefined;
      if (!skipLogin) {
        const pageText = await maskedPageText(ctx.page, masker);
        const loginConfirmed = Object.values(run.state.detected).includes('logged_in');
        failureCode = toErrorCode(classifyFailure({ violations: session.violations, failure: run.failure, pageText, loginConfirmed }));
      }
      return await traced(finish(run.state.rows, null, await shot(), failureCode));
    }
    let total: number | null = null;
    if (input.expectFile) {
      // A file task: the download step's checks already passed (a failing check failed the step above); there are no rows.
      const [got] = run.state.downloads;
      const n = run.state.downloads.length;
      if (n > 1) reasons.push(`the proof downloaded ${n} files; expected one`);
      else if (!got) reasons.push('the proof downloaded no file');
      else file = fileEvidence({ fileName: got.fileName, mimeType: got.mimeType, bytes: got.data.length, facts: got.facts }, masker);
    } else {
      const v = verifyRows({
        rows: run.state.rows, evidence: run.state.evidence, output: input.output, requireGrounding: true, ungroundedFields: run.state.attributeFields,
      });
      reasons.push(...v.reasons);
      total = v.total;
      // Prove only judges agent-recorded scripts: an empty result is never evidence that a recorded script works.
      if (run.state.rows.length === 0) {
        reasons.length = 0;
        reasons.push('a zero-row proof cannot confirm a recorded script');
        return await traced(finish([], v.total, await shot()));
      }
    }
    if (input.checkFallbacksFrom !== undefined) {
      // Right after recording, the page is the one the candidates were validated on: the primary must match.
      const agentIntents = new Set(flattenSteps(steps.slice(Math.max(0, input.checkFallbacksFrom - offset))).map((s) => s.intent));
      for (const e of run.state.log) {
        if (e.status === 'ok' && (e.candidate ?? 0) > 0 && agentIntents.has(e.intent)) reasons.push(`step "${e.intent}" matched only by fallback ${e.candidate} during prove`);
      }
    }
    return await traced(finish(run.state.rows, total, await shot()));
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
    await session.close();
  }
}
