// The desktop lane: one run of a desktop step set on a desktop runner. Parallel to the browser's script lane and
// returning the same result shapes (LaneSuccess, TaskFailure), so the node consumes both alike. n8n stays the trust
// root: the signature is verified here, before anything connects; the runner only enforces its local floor.

import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { shownFailure, stripShownPrefix } from '../classify/classify.js';
import { CANCELLED, clampBudget, laneFailure, type LaneSuccess } from '../lane/script-lane.js';
import type { TaskFailure } from '../lane/task.js';
import { hasSignature, type TrustInput, type TrustResult } from '../lane/trust.js';
import {
  DESKTOP_UNSIGNED_WRITES, desktopNotInteractive, inputTooLong, nameMismatch, RUNNER_BUSY, SIGNATURE_INVALID, SIGNATURE_WITHOUT_KEY, UNSIGNED_REQUIRED,
  versionMismatch,
} from '../messages.js';
import { createMasker, type Masker } from '../secrets/mask.js';
import { MAX_RENDERED } from '../secrets/render.js';
import { scriptHash, verifyScript } from '../sign.js';
import { FILE_CHECK_FAILED_PREFIX } from '../steps/file-check.js';
import { runBinaryProblem } from '../steps/limits.js';
import { parseDesktopScript } from '../steps/parse.js';
import { sleep } from '../steps/poll.js';
import { newRunState, runSteps, type StepContext } from '../steps/run.js';
import type { DesktopScript, ErrorCode, PortalPolicy, RunState, Script, Step, StepLogEntry } from '../types.js';
import { connectRunner, RUNNER_CONNECT_TIMEOUT_MS, type Lease, type RunnerClient, type RunnerEndpoint } from './client.js';
import {
  DesktopUnavailableError, ElementNotFoundError, ElementNotUniqueError, ExpectedFileMissingError, NoRunError, PolicyRefusedError, PROTOCOL_VERSION,
  RunnerBusyError, RunnerConnectError, RunnerDisconnectedError, RunnerTimeoutError,
} from './protocol.js';
import { createDesktopSurface, DesktopDriftError, type DesktopSurface } from './surface.js';
import './handlers.js';

/** One desktop run. Apart from the abort signal, everything is JSON-serialisable. */
export interface DesktopTaskInput {
  /** The raw step document (`surface: "desktop"`). */
  script: unknown;
  trust: TrustInput;
  /** The RPA Desktop Runner credential. */
  runner: RunnerEndpoint;
  vars?: Record<string, string>;
  budgetMs?: number;
  defaultStepTimeoutMs?: number;
  signal?: AbortSignal;
  /** How long run.begin retries a busy runner (default 30 s, never past the budget). 0: fail at the first refusal. */
  busyWaitMs?: number;
  /** The run's lease on the runner, renewed every third of it (5000..600000; default 30 s). */
  leaseMs?: number;
}
export type DesktopTaskResult = LaneSuccess | TaskFailure;

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_BUSY_WAIT_MS = 30_000;
const BUSY_RETRY_MS = 1_000;
const END_WAIT_MS = 5_000;
/** Typed values shorter than this are not masked out of messages (a one-letter value would mask every such letter). */
const MIN_MASKED_TYPED = 4;

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

/** The error code of a desktop failure, from the error the failing step met. */
function codeOf(err: unknown, message: string): ErrorCode {
  if (err instanceof RunnerBusyError) return 'busy';
  if (err instanceof DesktopUnavailableError || err instanceof NoRunError || err instanceof RunnerDisconnectedError || err instanceof RunnerConnectError) {
    return 'runner_unavailable';
  }
  if (err instanceof PolicyRefusedError) return 'policy_violation';
  if (err instanceof ElementNotFoundError || err instanceof ElementNotUniqueError || err instanceof RunnerTimeoutError || err instanceof DesktopDriftError) {
    return 'drift_detected';
  }
  if (err instanceof ExpectedFileMissingError) return 'incomplete';
  if (message.startsWith(FILE_CHECK_FAILED_PREFIX)) return 'drift_detected';
  return 'incomplete';
}

/**
 * Messages and log notes leave the run masked: secrets, and every value typed into a field that is long enough to mask
 * (DesktopSurface.typed). The runner never puts typed values into its messages; this holds even if one did. Intents
 * are the signed steps' own text and stay as written.
 */
function outputMasker(base: (string | undefined)[], surface?: DesktopSurface): Masker {
  return createMasker([...base, ...(surface?.typed ?? []).filter((t) => t.length >= MIN_MASKED_TYPED)]);
}

function maskedLog(log: StepLogEntry[], masker: Masker): StepLogEntry[] {
  return log.map((e) => ({ ...e, ...(e.note !== undefined ? { note: masker.mask(e.note) } : {}) }));
}

/**
 * Runs a desktop step set: trust gate, shape check, connect (certificate pinned before the token is sent), hello,
 * run.begin (a busy runner is retried for busyWaitMs), app.launch, the steps on the desktop surface, and run.end on
 * every path once the run began. One budget and one cancel signal cover everything. Never throws; every returned
 * string is masked (secrets and typed values).
 */
export async function runDesktopTask(input: DesktopTaskInput): Promise<DesktopTaskResult> {
  const t0 = Date.now();
  const secrets = [input.runner?.token, input.trust.key];
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
    const busyUntil = Date.now() + Math.min(Math.max(input.busyWaitMs ?? DEFAULT_BUSY_WAIT_MS, 0), deadline - Date.now());
    const id = randomUUID();
    for (;;) {
      try {
        await client.call('run.begin', { runId: id, leaseMs });
        break;
      } catch (err) {
        if (!(err instanceof RunnerBusyError)) throw err;
        if (Date.now() + BUSY_RETRY_MS >= busyUntil) return fail('busy', RUNNER_BUSY, ids);
        await sleep(BUSY_RETRY_MS);
      }
    }
    runId = id;
    lease = client.startLease(runId, leaseMs);
    surface = createDesktopSurface(client, runId, script.app);
    await surface.rpc('app.launch', { app: script.app });

    const ctx: StepContext = {
      page: NO_PAGE, surface, script: script as unknown as Script, policy: NO_NETWORK, vars: input.vars ?? {},
      masker: createMasker(secrets), defaultTimeoutMs: input.defaultStepTimeoutMs ?? 8000, violations: [],
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
      const code = codeOf(desktop.errors.get(res.failure.index), res.failure.message);
      return fail(code, shownFailure(res.failure.intent, failure.message), base);
    }
    const tail = { ...ids, log: maskedLog(res.state.log, outputMasker(secrets, surface)), ...(res.state.submitted ? { submitted: true } : {}) };
    const o = override();
    if (o) return fail(o.code, o.message, tail);
    const tooMuch = runBinaryProblem(res.state);
    if (tooMuch) return fail('incomplete', stripShownPrefix(tooMuch), tail);
    await desktop.refreshWindow();
    const m = outputMasker(secrets, surface);
    return {
      ok: true, lane: 'script', name: script.name ?? null, version: version ?? null, hash, rows: [], files: res.state.downloads, outputs: res.state.outputs,
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
