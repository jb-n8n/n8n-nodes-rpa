// The proof of a desktop repair: a new run on the same connection (the repair run ended with a reservation for it, so
// no other run takes the runner in between), a fresh start of the app, and the repaired steps replayed up to where the
// repair stopped: the first declared write, or a changed step held for approval. That step's control is resolved and
// never acted on. Changed steps act as they did in the repair (probe clicks, repair-mode reads), and each must match on
// its primary target. The proof's claims are as the runner reported them.
import { randomUUID } from 'node:crypto';
import type { Masker } from '../../secrets/mask.js';
import { runSteps, type StepContext } from '../../steps/run.js';
import type { DesktopScript, ErrorCode, PortalPolicy, Script, Step, StepLogEntry, StepOutput, DownloadedFile } from '../../types.js';
import type { RunnerClient } from '../client.js';
import { RunnerError } from '../protocol.js';
import { createDesktopSurface, runnerTarget, type DesktopSurface } from '../surface.js';
import { stepTarget, type RepairStop } from './session.js';

/** What the proof showed, in step numbers (1-based), for the proposal and the reviewer. */
export interface DesktopProofEvidence {
  /** Steps 1..replayed ran in a fresh start of the app. */
  replayed: number;
  /** The step the proof resolved and did not run (the repair's stop), or null when every step ran. */
  stoppedAt: number | null;
  stoppedBecause: 'declared write' | 'held for approval' | null;
  /** Steps the repair retargeted, and steps it added. */
  changedSteps: number[];
  addedSteps: number[];
}

export type DesktopProof =
  | { ok: true; evidence: DesktopProofEvidence; outputs: StepOutput[]; files: DownloadedFile[]; log: StepLogEntry[]; surface: DesktopSurface }
  | { ok: false; reason: string; code: ErrorCode; log: StepLogEntry[]; surface?: DesktopSurface };

export interface DesktopProveInput {
  client: RunnerClient;
  /** The run id the repair run reserved the runner for. */
  runId?: string;
  doc: DesktopScript;
  /** 0-based steps the repair retargeted, and steps it added. */
  changed: number[];
  added: number[];
  stop: RepairStop | null;
  vars: Record<string, string>;
  /** The step context's masker for the proof (token, key, secret variables). */
  stepMasker: Masker;
  /** Every secret of the run, for messages. */
  mask(surface?: DesktopSurface): Masker;
  leaseMs: number;
  /** Absolute time until which a busy runner is retried. */
  busyUntil: number;
  defaultStepTimeoutMs: number;
  signed: boolean;
  /** Called with the proof's run id once run.begin answered (the caller's stop and cancel use it). */
  began?(runId: string): void;
  begin(client: RunnerClient, runId: string, leaseMs: number, busyUntil: number): Promise<void>;
  launch(surface: DesktopSurface): Promise<void>;
}

const NO_PAGE = new Proxy({}, { get() { throw new Error('a desktop run has no browser page'); } });
const NO_NETWORK: PortalPolicy = { startUrl: 'about:blank', navHosts: [], subresourceHosts: [], login: [], allowedSubmits: [] };
const END_WAIT_MS = 5_000;

/** Replays the repaired steps in a new run and resolves the step where the repair stopped. Never throws. */
export async function proveDesktopRepair(input: DesktopProveInput): Promise<DesktopProof> {
  const { client, doc } = input;
  const runId = input.runId ?? randomUUID();
  let begun = false;
  let lease: ReturnType<RunnerClient['startLease']> | undefined;
  let surface: DesktopSurface | undefined;
  const stopAt = input.stop ? input.stop.index : doc.steps.length;
  const changed = new Set([...input.changed, ...input.added]);
  const fail = (code: ErrorCode, reason: string, log: StepLogEntry[] = []): DesktopProof =>
    ({ ok: false, code, reason: input.mask(surface).mask(reason).slice(0, 500), log, ...(surface ? { surface } : {}) });
  try {
    await input.begin(client, runId, input.leaseMs, input.busyUntil);
    begun = true;
    input.began?.(runId);
    lease = client.startLease(runId, input.leaseMs);
    surface = createDesktopSurface(client, runId, doc.app);
    await input.launch(surface);
    const ctx: StepContext = {
      page: NO_PAGE as never, surface, script: doc as unknown as Script, policy: NO_NETWORK, vars: input.vars,
      masker: input.stepMasker, defaultTimeoutMs: input.defaultStepTimeoutMs, violations: [], signed: input.signed,
    };
    const s = surface;
    s.trackStep(() => ctx.stepIndex);
    for (const i of changed) s.probeSteps.add(i);
    const res = await runSteps(ctx, doc.steps.slice(0, stopAt) as unknown as Step[], {
      rows: [], evidence: [], downloads: [], outputs: [], detected: {}, lastCheckpoint: -1, log: [], credentialsSubmitted: false, submitClicked: false,
      extractRan: false, attributeFields: [], submitted: false,
    });
    if (!res.ok) return fail('drift_detected', `step ${res.failure.index + 1} (${res.failure.intent}) failed: ${res.failure.message}`, res.state.log);
    if (res.state.submitted) return fail('policy_violation', 'a write step ran during the proof', res.state.log);
    const fallback = res.state.log.find((e) => changed.has(e.index) && e.status === 'ok' && (e.candidate ?? 0) > 0);
    if (fallback) return fail('drift_detected', `step ${fallback.index + 1} matched only by a fallback during the proof`, res.state.log);
    if (input.stop) {
      const target = stepTarget(doc.steps[stopAt]!);
      if (target) {
        try {
          const r = await client.callWithin('resolve', { runId, target: runnerTarget(target), timeoutMs: input.defaultStepTimeoutMs });
          if (changed.has(stopAt) && r.candidate !== 0) return fail('drift_detected', `step ${stopAt + 1} was found only by a fallback during the proof`, res.state.log);
        } catch (err) {
          if (!(err instanceof RunnerError)) throw err;
          return fail('drift_detected', `step ${stopAt + 1} (${doc.steps[stopAt]!.intent}), where the repair stopped, was not found: ${(err as Error).message}`, res.state.log);
        }
      }
    }
    const n = (list: number[]) => [...list].sort((a, b) => a - b).map((i) => i + 1);
    return {
      ok: true, log: res.state.log, outputs: res.state.outputs, files: res.state.downloads, surface: s,
      evidence: {
        replayed: stopAt, stoppedAt: input.stop ? stopAt + 1 : null,
        stoppedBecause: input.stop ? (input.stop.reason === 'write' ? 'declared write' : 'held for approval') : null,
        changedSteps: n(input.changed), addedSteps: n(input.added),
      },
    };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    return fail(begun ? 'drift_detected' : 'runner_unavailable', `the proof could not run: ${message.split('\n')[0]}`);
  } finally {
    lease?.stop();
    if (begun && !client.closed) await client.call('run.end', { runId }, END_WAIT_MS).catch(() => undefined);
  }
}
