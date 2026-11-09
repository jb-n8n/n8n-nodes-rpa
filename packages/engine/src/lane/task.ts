// Evaluation order matters: the agent lane (agent tools → sign-in handlers) loads before steps/run.js, exactly as when
// this file imported agent/loop.js first. test/task.test.ts mocks steps/run.js and relies on that order.
import { agentLane, finishLane } from './agent-lane.js';
import type { ChatMessage, ChatModel } from '../agent/model.js';
import type { Session } from '../browser/session.js';
import { PolicyError } from '../steps/errors.js';
import { extractsFields } from '../compile/compile.js';
import type { FileEvidence, Proposal } from '../proposal/proposal.js';
import { installInterrupts } from '../steps/interrupts.js';
import { noWritePolicy } from '../policy/derive.js';
import { downloadTemplateIssues, parseScript } from '../steps/parse.js';
import { shownMessage } from '../steps/urls.js';
import { newRunState, type StepContext } from '../steps/run.js';
import {
  CODE_WORKFLOW_NOT_SET, expectedFileInvalid, FIRST_RUN_NEEDS_NAME, FIRST_RUN_NEEDS_TARGET, NO_STEPS_NO_REPAIR, REPAIR_ALREADY_RAN, REPAIR_DOWNLOAD_NEEDS_CHECK, REPAIR_SIGN_IN_HALF_DONE, REPAIR_NEEDS_ID_AND_EXTRACT, REPAIR_NO_CAPTURES,
  REPAIR_ONE_DOWNLOAD, REPAIR_REFUSED_WRITES,
} from '../messages.js';
import type { SaveTrace } from '../trace/trace.js';
import type {
  BrowserEndpoint, CodeProvider, DownloadedFile, ErrorCode, OutputSpec, PageInfo, PortalPolicy, PortalSecrets, RequestRecord, Row, Script, StepLogEntry,
  StepOutput, Violation,
} from '../types.js';
import {
  CANCELLED, codeSettings, laneFailure, laneMasker, openLaneRuntime, startScriptLane, takesCodeFromWorkflow, traceOn,
  type LaneFailure, type LaneRuntime, type LaneSuccess,
} from './script-lane.js';
import { openStartPage, startPageFailure } from './start-page.js';
import type { DownloadTemplate } from '../steps/file-check.js';
import { isEmptySteps, type TrustInput } from './trust.js';

export { MAX_AGENT_ACTIONS, MAX_AGENT_TOKENS, PROVE_RESERVE_MS } from './agent-lane.js';
export { MIN_PROVE_MS } from './prove-run.js';
/** v1 repair never records field extraction: such runs report drift instead of healing. */
export const FIELDS_UNSUPPORTED = 'repair cannot record field extraction yet: update the script by hand';

/** AI repair settings. Present only when repair is on and a chat model is connected. */
export interface RepairInput {
  model: ChatModel;
  goal: string;
  /** Options → Name: the repaired steps' name when the steps have none; required for a first run. */
  name?: string;
  /** Clamped to 1..200 actions and 1,000..1,000,000 tokens. */
  agentBudget?: { maxActions?: number; maxTokens?: number };
  /** Options → Deliver Unconfirmed Rows: agent-lane rows are returned even when the proof did not pass. */
  deliverUnconfirmed?: boolean;
  /** A repair already ran in this execution: no healing, drift is reported. */
  alreadyRan?: boolean;
  /** A first run's expected file, from the node's Expected File; ignored when the steps are not empty. */
  download?: DownloadTemplate;
}
/** One run. Apart from the model and the abort signal, everything is JSON-serialisable. */
export interface TaskInput {
  /** The raw step document; empty (isEmptySteps) only for a first run with repair. */
  script: unknown;
  trust: TrustInput;
  policy: PortalPolicy;
  secrets?: PortalSecrets;
  /**
   * Supplies the one-time code for a signIn whose totp.source is 'workflow' (in n8n: the One-Time Code Workflow). Steps
   * that need it and have none are a configuration error before any browser opens.
   */
  codeProvider?: CodeProvider;
  /** How long signIn waits for codeProvider, in ms (default 120 000). */
  codeTimeoutMs?: number;
  endpoint: BrowserEndpoint;
  output?: OutputSpec;
  vars?: Record<string, string>;
  budgetMs?: number;
  defaultStepTimeoutMs?: number;
  viewport?: { width: number; height: number };
  saveTrace?: SaveTrace;
  signal?: AbortSignal;
  startStatus?: 'classify' | 'report';
  repair?: RepairInput;
}
export interface AgentActionSummary {
  tool: string;
  ok: boolean;
  url: string;
  intent?: string;
  note?: string;
}
export interface AgentLaneSuccess {
  ok: true;
  lane: 'agent';
  /** The base steps' name, version and hash (the script lane's); null on a first run, which has no base. */
  name: string | null;
  version: number | null;
  hash: string | null;
  rows: Row[];
  /**
   * Rows task: the script lane's downloads before the drift, carried like its captures (`outputs`). File task: only the
   * file the agent downloaded, named after the compiled download step, and only when the proof passed.
   */
  files: DownloadedFile[];
  page: PageInfo;
  /** The script lane's captures before the drift; the agent never captures. */
  outputs: StepOutput[];
  /** True only when prove passed and the page stated a total that matched; for a file task, when prove passed. */
  confirmed: boolean;
  proposal?: Proposal;
  /** proposalDigest(proposal): shown to the reviewer and passed back to signSteps as `reviewedDigest`. */
  digest?: string;
  /**
   * `failureCode` is set when a full replay failed on a step (e.g. login_failed: trip the login breaker). `file`: a file
   * task's proof evidence (the downloaded file, strings masked), as in `proposal.evidence.file`.
   */
  prove?: { ok: boolean; total: number | null; reasons: string[]; diff: { missing: string[]; extra: string[] }; failureCode?: ErrorCode; file?: FileEvidence };
  compileIssues?: string[];
  agentLog: AgentActionSummary[];
  log: StepLogEntry[];
  violations: Violation[];
  /** Writes blocked and logged without ending the run (writeMode 'block'), script lane and agent lane alike (masked). */
  blockedRequests: RequestRecord[];
  tokens: number;
  llmCalls: number;
  durationMs: number;
  note: string;
  transcript: ChatMessage[];
  /** True once a write left the browser in this run. Repair is refused after a write, so false in practice. */
  submitted: boolean;
  trace?: Buffer;
}
export type TaskFailure = LaneFailure & {
  lane: 'script' | 'agent'; configError?: boolean; agentLog?: AgentActionSummary[]; tokens?: number; llmCalls?: number; transcript?: ChatMessage[];
};
export type TaskResult = LaneSuccess | AgentLaneSuccess | TaskFailure;

/** The steps of a raw document (bare array or `{ steps }`), paginate bodies included; [] for anything else. Never throws. */
function rawSteps(raw: unknown): Record<string, unknown>[] {
  const top = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { steps?: unknown }).steps) ? (raw as { steps: unknown[] }).steps : [];
  const out: Record<string, unknown>[] = [];
  const walk = (list: unknown[]) => {
    for (const s of list) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
      const step = s as Record<string, unknown>;
      out.push(step);
      const pages = step.paginate as { each?: unknown } | undefined;
      if (pages && typeof pages === 'object' && Array.isArray(pages.each)) walk(pages.each);
    }
  };
  walk(top);
  return out;
}

/** Steps whose output the agent lane never reproduces (it returns rows or one downloaded file): repair refuses them. */
const CAPTURE_VERBS = ['screenshot', 'pdf', 'read', 'extractTable'];

const downloadOf = (s: Record<string, unknown>) => (s.download && typeof s.download === 'object' ? (s.download as { via?: unknown; check?: unknown }) : undefined);

/** Whether a check can tell the right file from the wrong one: it sets `name` or `columns`. */
const namesFile = (check: unknown): boolean =>
  !!check && typeof check === 'object' && ((check as { name?: unknown }).name !== undefined || (check as { columns?: unknown }).columns !== undefined);

/** Which kind of document repair would work on: one that downloads a checked file, or rows. Never throws. */
export function repairKind(raw: unknown, _output: OutputSpec | undefined, repair: Pick<RepairInput, 'download'>): 'rows' | 'file' {
  if (isEmptySteps(raw)) return repair.download ? 'file' : 'rows';
  return rawSteps(raw).some((s) => downloadOf(s)) ? 'file' : 'rows';
}

/** The single top-level download step's `{ mime, maxBytes, check }`, or undefined when there is not exactly one. */
export function downloadTemplateOf(script: Script): DownloadTemplate | undefined {
  const found = script.steps.filter((s): s is Extract<typeof s, { download: unknown }> => 'download' in s);
  if (found.length !== 1) return undefined;
  const { mime, maxBytes, check } = found[0].download;
  if (!check) return undefined;
  return { ...(mime ? { mime } : {}), ...(maxBytes !== undefined ? { maxBytes } : {}), check };
}

/**
 * Why AI repair cannot run on these steps, or undefined. Checked before any browser opens. Rows documents:
 * an ID Pattern and an extract step (or empty steps); no form submissions; no capture, read or table step (paginate
 * bodies included); a name for a first run. File documents: no writes; one top-level download and no extract; no
 * capture steps; a check that names the file or its columns; a first run's Expected File valid under the download step
 * rules; a name for a first run.
 */
export function repairPrecondition(raw: unknown, output: OutputSpec | undefined, repair: Pick<RepairInput, 'name' | 'download'>): string | undefined {
  const empty = isEmptySteps(raw);
  const steps = empty ? [] : rawSteps(raw);
  if (repairKind(raw, output, repair) === 'file') {
    if (steps.some((s) => 'submit' in s || downloadOf(s)?.via !== undefined)) return REPAIR_REFUSED_WRITES;
    const top = Array.isArray(raw) ? raw : (raw as { steps?: unknown[] } | undefined)?.steps ?? [];
    const topDownloads = top.filter((s) => s && typeof s === 'object' && downloadOf(s as Record<string, unknown>)).length;
    const downloads = steps.filter((s) => downloadOf(s)).length;
    if (!empty && (topDownloads !== 1 || downloads !== 1 || steps.some((s) => 'extract' in s))) return REPAIR_ONE_DOWNLOAD;
    if (steps.some((s) => CAPTURE_VERBS.some((verb) => verb in s))) return REPAIR_NO_CAPTURES;
    if (!empty) {
      if (!namesFile(downloadOf(steps.find((s) => downloadOf(s))!)?.check)) return REPAIR_DOWNLOAD_NEEDS_CHECK;
    }
    if (empty && (output?.idPattern || !namesFile(repair.download?.check))) return FIRST_RUN_NEEDS_TARGET;
    // The Expected File meets the download step rules now: compile would refuse it only after a full paid run.
    const invalid = empty ? downloadTemplateIssues(repair.download) : [];
    if (invalid.length) return expectedFileInvalid(invalid);
    if (empty && !repair.name?.trim()) return FIRST_RUN_NEEDS_NAME;
    return undefined;
  }
  if (empty && !output?.idPattern) return FIRST_RUN_NEEDS_TARGET;
  if (!output?.idPattern || (!empty && !steps.some((s) => 'extract' in s))) return REPAIR_NEEDS_ID_AND_EXTRACT;
  if (steps.some((s) => 'submit' in s)) return REPAIR_REFUSED_WRITES;
  if (steps.some((s) => CAPTURE_VERBS.some((verb) => verb in s))) return REPAIR_NO_CAPTURES;
  if (empty && !repair.name?.trim()) return FIRST_RUN_NEEDS_NAME;
  return undefined;
}

const withoutName = ({ name: _name, ...rest }: RepairInput): RepairInput => rest;
const maskerOf = (input: TaskInput) => laneMasker({ secrets: input.secrets, endpoint: input.endpoint, signingKey: input.trust.key });

/**
 * One run: the script lane, then (on drift, with AI repair) the agent lane on the same session, compile, prove and
 * repaired steps. Empty steps with repair are a first run that explores from the start page. Repair preconditions are
 * configuration errors checked before anything else. One deadline and one cancel signal cover everything; every
 * returned string is masked. Never throws.
 */
export async function runTask(input: TaskInput): Promise<TaskResult> {
  const t0 = Date.now();
  // Options → Name is trimmed once here; every later use (precondition, first-run steps, repaired steps) sees the trimmed name.
  const name = input.repair?.name?.trim();
  const repair: RepairInput | undefined = input.repair
    ? { ...withoutName(input.repair), ...(name ? { name } : {}) }
    : undefined;
  const empty = isEmptySteps(input.script);
  if (repair) {
    const refused = repairPrecondition(input.script, input.output, repair);
    if (refused) return { ...laneFailure(t0, maskerOf(input), 'policy_violation', refused), lane: empty ? 'agent' : 'script', configError: true };
  }
  if (!input.codeProvider && takesCodeFromWorkflow(input.script)) {
    return { ...laneFailure(t0, maskerOf(input), 'policy_violation', CODE_WORKFLOW_NOT_SET), lane: 'script', configError: true };
  }
  if (empty) {
    if (!repair) return { ...laneFailure(t0, maskerOf(input), 'drift_detected', NO_STEPS_NO_REPAIR), lane: 'agent' };
    if (repair.alreadyRan) return { ...laneFailure(t0, maskerOf(input), 'drift_detected', REPAIR_ALREADY_RAN), lane: 'agent' };
    return firstRun(input, repair, t0, repairKind(input.script, input.output, repair));
  }
  const canHeal = !!repair && !repair.alreadyRan;
  // Decided before the run so the healing session is never kept (no model call, no extra login).
  const fieldsBlocked = canHeal && repairKind(input.script, input.output, repair ?? {}) === 'rows'
    && recordsFields(input.output, input.policy.startUrl, input.script);
  const heal = canHeal && !fieldsBlocked;
  const { repair: _repair, ...laneInput } = input;
  const { run, runtime } = await startScriptLane(laneInput, { keepSessionOnDrift: heal, t0 });
  const r = run.result;
  if (r.ok) return r;
  // The same value the script lane reports: its own submits, or any write the session let through (session.writesSent).
  const wrote = r.submitted === true || (runtime?.session.writesSent ?? 0) > 0;
  if (heal && r.code === 'drift_detected' && wrote) {
    // A write already left the browser before the drift: repair is refused like steps that submit, and the
    // result says the run submitted. A runtime event, not a configuration error. The kept session closes
    // with its failure trace, as a plain drift would.
    const refused: TaskFailure = { ...r, lane: 'script', code: 'policy_violation', message: REPAIR_REFUSED_WRITES, submitted: true };
    return runtime ? finishLane(input, runtime, refused) : refused;
  }
  if (!heal || !repair || !runtime || !run.ctx || !run.state || !run.script) {
    await runtime?.dispose();
    const why = r.code !== 'drift_detected' ? undefined : fieldsBlocked ? FIELDS_UNSUPPORTED : repair?.alreadyRan ? REPAIR_ALREADY_RAN : undefined;
    return { ...r, lane: 'script', ...(why ? { message: `${r.message} (${why})` } : {}) };
  }
  if (run.state.credentialsSubmitted && !run.state.submitClicked) {
    // The username was typed but no password was submitted: a drifted password-page locator, or a site that rejected the
    // username inline on the same page. The agent could only act on a half-done sign-in (a click there can post an empty
    // password, a failed attempt toward a lockout), so no repair: the drift stands, and the kept session closes with its
    // failure trace as a plain drift would.
    return finishLane(input, runtime, { ...r, lane: 'script', message: `${r.message} (${REPAIR_SIGN_IN_HALF_DONE})` });
  }
  const kind = repairKind(input.script, input.output, repair);
  // The repair path takes the template from the steps only: the Expected File belongs to a first run.
  const download = downloadTemplateOf(run.script);
  return agentLane(input, repair, {
    kind, ...(download ? { download } : {}),
    runtime, ctx: run.ctx, prior: run.state, base: run.script, failure: r.failure, postLoginUrl: run.postLoginUrl,
    storageState: run.storageState, ...(run.beforeDetect ? { beforeDetect: run.beforeDetect } : {}),
    screenshot: r.screenshot, version: r.version, hash: r.hash, t0,
  });
}

/**
 * Whether healing would have to record field extraction: the output names required fields, or an extract in the base
 * script (paginate bodies included) reads items or fields. The script is parsed exactly as the lane parses it (the
 * run's start URL as the default start), so a document the lane runs never reads as "no fields". An unparseable
 * script reads as false: the script lane refuses it anyway.
 */
function recordsFields(output: OutputSpec | undefined, defaultStartUrl: string, script?: unknown): boolean {
  if (output?.requiredFields?.length) return true;
  if (isEmptySteps(script)) return false;
  try {
    return extractsFields(parseScript(script, { defaultStartUrl }).steps);
  } catch {
    return false;
  }
}

async function firstRun(input: TaskInput, repair: RepairInput, t0: number, kind: 'rows' | 'file'): Promise<TaskResult> {
  const masker = maskerOf(input);
  // No model call happens before agentLane: every failure here reports llmCalls 0.
  // Once the browser is open, a failure carries the session's violations and blocked requests.
  const fail = (code: ErrorCode, message: string, session?: Session): TaskFailure => ({
    ...laneFailure(t0, masker, code, masker.mask(message), session ? { violations: session.violations, blockedRequests: session.blockedRequests } : {}),
    lane: 'agent', llmCalls: 0,
  });
  // Repair preconditions (ID Pattern, name) were checked in runTask. Field extraction cannot be recorded yet.
  if (kind === 'rows' && recordsFields(input.output, input.policy.startUrl)) return fail('drift_detected', FIELDS_UNSUPPORTED);
  if (input.signal?.aborted) return fail('incomplete', CANCELLED);
  let runtime: LaneRuntime;
  try {
    runtime = await openLaneRuntime({
      // A first run is all repair: no writes from the start page on.
      endpoint: input.endpoint, policy: noWritePolicy(input.policy), masker, budgetMs: input.budgetMs, signal: input.signal,
      trace: traceOn(input.saveTrace), ...(input.viewport ? { viewport: input.viewport } : {}),
    });
  } catch (err) {
    if (input.signal?.aborted) return fail('incomplete', CANCELLED);
    return fail(err instanceof PolicyError ? 'policy_violation' : 'browser_unavailable', (err as Error).message);
  }
  try {
    const { session } = runtime;
    const script: Script = { name: repair.name, version: 1, startUrl: input.policy.startUrl, steps: [] };
    const interrupts = await installInterrupts(session.page, []);
    // Same start-page mapping as the script lane.
    const start = await openStartPage(session.page, script.startUrl, { policy: input.policy, masker });
    if (!start.proceed) {
      // Same as the script lane: let a pending redirect-hop address check land first.
      await session.idle();
      const f = startPageFailure(runtime, start);
      return await finishLane(input, runtime, fail(f.code, f.message, session));
    }
    const ctx: StepContext = {
      page: session.page, script, policy: input.policy, secrets: input.secrets, vars: input.vars ?? {},
      masker, defaultTimeoutMs: input.defaultStepTimeoutMs ?? 8000, violations: session.violations, interrupts, stepHooks: session.stepHooks,
      ...codeSettings(input),
    };
    return await agentLane(input, repair, { kind, ...(repair.download ? { download: repair.download } : {}), runtime, ctx, prior: newRunState(), t0 });
  } catch (err) {
    const o = runtime.override();
    const message = shownMessage(String((err as Error)?.message ?? err), masker);
    return finishLane(input, runtime, o ? fail(o.code, o.message, runtime.session) : fail('incomplete', message, runtime.session));
  }
}
