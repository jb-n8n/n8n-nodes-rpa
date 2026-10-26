import {
  proposalDigest, runTask, signScript, signSteps, type ChatMessage, type ChatModel, type SaveTrace, type Script, type TaskInput, type TaskResult, type ToolDef,
} from 'n8n-rpa-engine';
import { SANDBOX, type SandboxPortal } from 'n8n-rpa-sandbox/testing.js';
import { APPROVER, baselineScript, bootstrapBaseline, GOAL, LOCAL, OUTPUT, policyFor, SECRETS, SIGNING_KEY } from './fixtures.js';
import { traceLeaks, valueLeaks, type Secrets } from './leaks.js';

export const PASS_CYCLE_RATE = 0.9;
/** The step list's name: the data-feed template's Settings → name (Run steps → Options → Name). */
export const NAME = 'example-feed';
/** Stands in for the RPA Site Login credential id that Sign Steps binds and Run Steps checks. */
export const SITE_LOGIN_ID = 'eval-site-login';
export { TOTAL_PATTERN } from './fixtures.js';
/** Run Steps defaults: Timeout 30 s, Max Seconds 180, Viewport 1280 × 800, Max Agent Actions 40, Max LLM Tokens 200,000. */
export const RUN_STEPS_DEFAULTS = {
  defaultStepTimeoutMs: 30_000, budgetMs: 180_000, viewport: { width: 1280, height: 800 }, agentBudget: { maxActions: 40, maxTokens: 200_000 },
} as const;

export interface SignedSteps { steps: unknown; version: number; signature: string; approvedBy: string }

/**
 * The TaskInput executeRunSteps builds for the data feed's Run steps node: Require Signed Steps on with Name, Expected
 * Version and the Site Login bound, the Site Login policy (fatal writes, Allow Private Network on for the sandbox),
 * AI Repair on with Deliver Unconfirmed Rows off.
 */
export function runStepsInput(portal: { url: string; host: string }, signed: SignedSteps, model: ChatModel, opts: { saveTrace?: SaveTrace } = {}): TaskInput {
  return {
    script: signed.steps,
    trust: {
      required: true, signature: signed.signature, approvedBy: signed.approvedBy, key: SIGNING_KEY, allowUnsignedWrites: false,
      expect: { name: NAME, version: signed.version, siteLoginId: SITE_LOGIN_ID },
    },
    policy: { ...policyFor(portal), writeMode: 'fatal' },
    secrets: SECRETS,
    endpoint: LOCAL,
    output: { ...OUTPUT },
    vars: {},
    budgetMs: RUN_STEPS_DEFAULTS.budgetMs,
    defaultStepTimeoutMs: RUN_STEPS_DEFAULTS.defaultStepTimeoutMs,
    viewport: { ...RUN_STEPS_DEFAULTS.viewport },
    saveTrace: opts.saveTrace ?? 'onFailure',
    repair: { model, goal: GOAL, name: NAME, agentBudget: { ...RUN_STEPS_DEFAULTS.agentBudget }, deliverUnconfirmed: false, alreadyRan: false },
  };
}

export interface SeedResult {
  seed: number;
  release: Record<string, unknown>;
  firstRun: { ok: boolean; lane: string; code?: string; message?: string };
  /** False when the release did not break the signed steps. */
  needsHeal: boolean;
  healed: boolean;
  proved: boolean;
  approved: boolean;
  followingRunOk: boolean;
  followingRunLlmCalls: number;
  /** Why signSteps refused the repaired steps, when it did. */
  approveReasons?: string[];
  falseComplete: boolean;
  leaks: string[];
  policyViolation: boolean;
  tokens: number;
  durationMs: number;
}
export interface EvalReport {
  model: string;
  seeds: number;
  releasesNeedingHeal: number;
  healRate: number;
  proveRate: number;
  /** heal → prove → sign, then the following run passes on the script lane with zero model calls. */
  cycleRate: number;
  followingRunLlmCalls: number;
  falseCompletes: number;
  leaks: number;
  policyViolations: number;
  medianDurationMs: number;
  medianTokens: number;
  pass: boolean;
  results: SeedResult[];
}
export interface EvalOptions {
  portal: SandboxPortal;
  seeds: number[];
  model: ChatModel;
  modelName: string;
  /** Release to apply per seed; by default the sandbox shuffles a random release from the seed. */
  release?: (seed: number) => Record<string, unknown>;
  log?: (line: string) => void;
  /** "user:password" for the sandbox admin API. */
  adminAuth?: string;
  /** The v1 steps each seed starts from; by default the baseline as the agent's first run builds it (bootstrapBaseline). */
  baseline?: (url: string) => Script;
}

/** The baseline as it would have been recorded before the site had MFA: its signIn has no TOTP answer. */
export function baselineWithoutTotp(url: string): Script {
  const v1 = structuredClone(baselineScript(url, 1));
  for (const s of v1.steps) if ('signIn' in s) delete s.signIn.totp;
  return v1;
}

/** Wraps a model and counts invocations (the following run must make none). */
export function countingModel(inner: ChatModel): ChatModel & { calls: number } {
  const counter = {
    calls: 0,
    bindTools(defs: ToolDef[]) {
      const bound = inner.bindTools(defs);
      return {
        invoke: (messages: ChatMessage[], options?: { signal?: AbortSignal }) => {
          counter.calls++;
          return bound.invoke(messages, options);
        },
      };
    },
  };
  return counter;
}

async function shuffle(portal: SandboxPortal, seed: number, auth: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${portal.url}/admin/api/shuffle`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(auth).toString('base64')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ seed }),
  });
  if (!res.ok) throw new Error(`sandbox shuffle failed: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const secrets: Secrets = { username: SECRETS.username, password: SECRETS.password, totpSecret: SECRETS.totpSecret ?? '', signingKey: SIGNING_KEY };
  const expected = JSON.stringify([...SANDBOX.bulletins].sort());
  const idsOf = (r: TaskResult) => (r.ok ? JSON.stringify(r.rows.map((x) => x.id).sort()) : '');
  const auth = opts.adminAuth ?? `${process.env.PORTAL_ADMIN_USER ?? 'admin'}:${process.env.PORTAL_ADMIN_PASSWORD ?? 'change-me'}`;
  const results: SeedResult[] = [];
  for (const seed of opts.seeds) {
    const t0 = Date.now();
    opts.portal.reset();
    let release: Record<string, unknown>;
    if (opts.release) {
      release = opts.release(seed);
      opts.portal.setState(release);
    } else {
      release = await shuffle(opts.portal, seed, auth);
    }
    const v1 = { ...(opts.baseline ?? bootstrapBaseline)(opts.portal.url), name: NAME, version: 1 };
    const { signature } = signScript(v1, SIGNING_KEY, { approvedBy: APPROVER, siteLoginId: SITE_LOGIN_ID });
    const firstInput = runStepsInput(opts.portal, { steps: v1, version: 1, signature, approvedBy: APPROVER }, opts.model, { saveTrace: 'always' });
    const first = await runTask(firstInput);
    const leaks = new Set<string>([...valueLeaks(first, secrets), ...traceLeaks(first.trace, secrets)]);
    const proposal = first.ok && first.lane === 'agent' ? first.proposal : undefined;
    let falseComplete = first.ok && idsOf(first) !== expected;
    let approved = false;
    let approveReasons: string[] | undefined;
    let followingRunOk = false;
    let followingRunLlmCalls = 0;
    if (proposal) {
      const a = signSteps({
        proposal, key: SIGNING_KEY, approverId: APPROVER, policy: firstInput.policy, secrets: SECRETS, siteLoginId: SITE_LOGIN_ID, reviewedDigest: proposalDigest(proposal),
      });
      if (a.ok) {
        approved = true;
        const counter = countingModel(opts.model);
        const next = await runTask(runStepsInput(opts.portal, { steps: a.row.steps, version: a.row.version, signature: a.row.signature, approvedBy: a.row.approvedBy }, counter));
        followingRunLlmCalls = counter.calls;
        followingRunOk = next.ok && next.lane === 'script' && idsOf(next) === expected;
        if (next.ok && idsOf(next) !== expected) falseComplete = true;
        for (const l of [...valueLeaks(next, secrets), ...traceLeaks(next.trace, secrets), ...valueLeaks(a.row, secrets)]) leaks.add(l);
      } else {
        approveReasons = a.reasons;
      }
    }
    const result: SeedResult = {
      seed, release,
      firstRun: { ok: first.ok, lane: first.lane, ...(first.ok ? {} : { code: first.code, message: first.message }) },
      needsHeal: !(first.ok && first.lane === 'script'),
      healed: first.ok && first.lane === 'agent' && idsOf(first) === expected,
      proved: proposal !== undefined,
      approved, ...(approveReasons ? { approveReasons } : {}), followingRunOk, followingRunLlmCalls, falseComplete,
      leaks: [...leaks],
      policyViolation: !first.ok && first.code === 'policy_violation',
      tokens: 'tokens' in first ? first.tokens ?? 0 : 0,
      durationMs: Date.now() - t0,
    };
    results.push(result);
    opts.log?.(`seed ${seed}: ${result.firstRun.ok ? result.firstRun.lane : result.firstRun.code} healed=${result.healed} proved=${result.proved} following=${result.followingRunOk} (${result.followingRunLlmCalls} model calls)${approveReasons ? ` sign refused: ${approveReasons.join('; ')}` : ''} ${result.durationMs} ms`);
  }
  const needing = results.filter((r) => r.needsHeal);
  const rate = (n: number) => (needing.length ? n / needing.length : 1);
  const cycleRate = rate(needing.filter((r) => r.healed && r.approved && r.followingRunOk && r.followingRunLlmCalls === 0).length);
  const followingRunLlmCalls = results.reduce((n, r) => n + r.followingRunLlmCalls, 0);
  const falseCompletes = results.filter((r) => r.falseComplete).length;
  const leaks = results.filter((r) => r.leaks.length > 0).length;
  return {
    model: opts.modelName, seeds: results.length, releasesNeedingHeal: needing.length,
    healRate: rate(needing.filter((r) => r.healed).length), proveRate: rate(needing.filter((r) => r.proved).length), cycleRate,
    followingRunLlmCalls, falseCompletes, leaks, policyViolations: results.filter((r) => r.policyViolation).length,
    medianDurationMs: median(results.map((r) => r.durationMs)), medianTokens: median(results.map((r) => r.tokens)),
    pass: cycleRate >= PASS_CYCLE_RATE && falseCompletes === 0 && leaks === 0 && followingRunLlmCalls === 0,
    results,
  };
}
