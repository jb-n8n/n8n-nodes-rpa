import type { AgentLoopResult } from '../agent/loop.js';
import type { CompileResult } from '../compile/compile.js';
import { noWritePolicy } from '../policy/derive.js';
import { loginBlockEnd } from '../policy/validate.js';
import { proveScript, type ProveInput, type ProveResult } from '../prove/prove.js';
import type { Row } from '../types.js';
import type { Handoff } from './agent-lane.js';
import { codeSettings, traceOn } from './script-lane.js';
import type { TaskInput } from './task.js';

export const MIN_PROVE_MS = 5_000;

/**
 * Proves the compiled script in a fresh browser under the run's deadline and cancel signal. A full replay (a second
 * credential submission) happens only when the drift was in the login block (or this is a first run) and the agent's
 * own sign_in, or its enter_code after the script's sign-in, succeeded in this run; otherwise prove reuses the session state captured right after the script's
 * login block (or right before its detect, when that detect is what failed and compile re-anchored it), or is skipped with a reason.
 */
export async function runProve(input: TaskInput, h: Handoff, loop: AgentLoopResult, compiled: CompileResult, rows: Row[]): Promise<ProveResult> {
  const { runtime } = h;
  const { masker } = runtime;
  const skip = (reason: string): ProveResult => ({
    ok: false, rows: [], total: null, reasons: [masker.mask(reason)], diff: { missing: [], extra: [] }, policyViolation: false, readPosts: [],
  });
  const remaining = runtime.deadline - Date.now();
  if (remaining < MIN_PROVE_MS) return skip('there was no time left to prove the script');
  const common: ProveInput = {
    script: compiled.script, policy: noWritePolicy(input.policy), secrets: input.secrets, ...codeSettings(input), ...(input.vars ? { vars: input.vars } : {}), output: input.output ?? {},
    endpoint: input.endpoint, masker, ...(input.defaultStepTimeoutMs ? { defaultStepTimeoutMs: input.defaultStepTimeoutMs } : {}),
    budgetMs: remaining, deadlineMs: runtime.deadline, ...(input.signal ? { signal: input.signal } : {}),
    agentRows: rows, checkFallbacksFrom: compiled.suffixFrom, trace: traceOn(input.saveTrace),
    ...(input.viewport ? { viewport: input.viewport } : {}),
    ...(h.kind === 'file' ? { expectFile: true } : {}),
  };
  // An accepted code also counts as the agent completing the sign-in (as when a site release adds TOTP after the base
  // sign-in). enter_code runs only after the credentials were submitted; what shows the sign-in went through is that the
  // agent lane got this far: prove runs only after the agent's rows (or its file) were verified, and those sit behind the login.
  const agentSignedIn = loop.actions.some((a) => a.ok && (a.tool === 'sign_in' || a.tool === 'enter_code'));
  const loginDrift = !h.base || (!!h.failure && h.failure.index <= loginBlockEnd(h.base));
  if (agentSignedIn && loginDrift) {
    const usedCode = loop.actions.some((a) => a.ok && a.tool === 'enter_code');
    if (usedCode && !input.secrets?.totpSecret) return skip('the sign-in needs a one-time code that cannot be generated');
    return proveScript({ ...common, ...(loop.codeSubmittedAt ? { freshTotpAfter: loop.codeSubmittedAt } : {}) });
  }
  if (loginBlockEnd(compiled.script) < 0) return proveScript(common);
  // The base sign-in went through but its detect failed, and compile re-anchored that detect (compiled.resumeAt).
  // Prove resumes the session captured right before the detect, so the new detect and everything after it run in the fresh
  // browser, and the credentials are never submitted a second time.
  if (compiled.resumeAt !== undefined && h.beforeDetect) {
    return proveScript({ ...common, storageState: h.beforeDetect.storageState, postLoginUrl: h.beforeDetect.url, resumeAt: compiled.resumeAt });
  }
  if (!h.postLoginUrl || !h.storageState) return skip('the page reached right after sign-in is unknown, so the healing session cannot be reused');
  return proveScript({ ...common, storageState: h.storageState, postLoginUrl: h.postLoginUrl });
}
