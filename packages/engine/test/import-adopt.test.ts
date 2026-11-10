import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptLaneInput, ScriptRun } from '../src/lane/script-lane.js';
import type { ProveInput, ProveResult } from '../src/prove/prove.js';
import { adoptDraft, type AdoptInput } from '../src/import/adopt.js';
import { runDraft } from '../src/lane/draft.js';
import { runTask, type TaskInput, type TaskResult } from '../src/lane/task.js';
import { checkTrust } from '../src/lane/trust.js';
import { buildProposal, proposalDigest } from '../src/proposal/proposal.js';
import { createMasker } from '../src/secrets/mask.js';
import { scriptHash } from '../src/sign.js';
import { CANCELLED } from '../src/lane/script-lane.js';
import { IMPORT_EMPTY, IMPORT_NOT_ADOPTABLE, ROWS_WITHHELD, IMPORT_PROOF_FAILED, IMPORT_REFUSES_WRITES, REPAIR_NEEDS_ID_AND_EXTRACT, UNSIGNED_REQUIRED, UNSIGNED_WRITES } from '../src/messages.js';
import type { PortalPolicy, Script, Step } from '../src/types.js';
import { fakeModel } from './fake-model.js';
import { ERP_CHECK, LOCAL, policyFor, SECRETS, TEST_KEY } from './helpers.js';

// No browser opens in this file: openSession is recorded and refused, the script lane and the proof are scripted per test.
const { sessions, lane, prove, task } = vi.hoisted(() => ({
  sessions: [] as unknown[],
  /** One-shot: the next runTask (draft mode's inner run) returns this result instead of running. */
  task: { next: undefined as unknown },
  /** One-shot: the next startScriptLane returns this run instead of running. Every call's input is recorded. */
  lane: { next: undefined as ScriptRun | undefined, seen: [] as ScriptLaneInput[] },
  /** The next proveScript result (default: a passing file proof). Every call's input is recorded. */
  prove: { next: undefined as ProveResult | undefined, seen: [] as ProveInput[] },
}));
vi.mock('../src/browser/session.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/browser/session.js')>();
  return {
    ...mod,
    openSession: async (opts: unknown) => {
      sessions.push(opts);
      throw new mod.BrowserUnavailableError('no browser in this test');
    },
  };
});
vi.mock('../src/lane/script-lane.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/lane/script-lane.js')>();
  return {
    ...mod,
    startScriptLane: async (input: ScriptLaneInput, opts?: Parameters<typeof mod.startScriptLane>[1]) => {
      lane.seen.push(structuredClone({ ...input, signal: undefined }));
      const next = lane.next;
      lane.next = undefined;
      return next ? { run: next } : mod.startScriptLane(input, opts);
    },
  };
});
vi.mock('../src/lane/task.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/lane/task.js')>();
  return {
    ...mod,
    runTask: async (input: Parameters<typeof mod.runTask>[0]) => {
      const next = task.next;
      task.next = undefined;
      return next ? (next as Awaited<ReturnType<typeof mod.runTask>>) : mod.runTask(input);
    },
  };
});
vi.mock('../src/prove/prove.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/prove/prove.js')>();
  return {
    ...mod,
    proveScript: async (input: ProveInput) => {
      prove.seen.push(input);
      const next = prove.next;
      prove.next = undefined;
      return next ?? passingFileProof();
    },
  };
});

const URL0 = 'http://portal.test';
const POLICY: PortalPolicy = { ...policyFor({ url: URL0, host: 'portal.test' }), allowedSubmits: [{ host: 'portal.test', path: '/acme/reports/export', method: 'POST' }] };
const SIGN_IN: Step = {
  intent: 'Sign in',
  signIn: { username: { label: 'Dealer user ID' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Sign in' } },
};
const DOWNLOAD: Step = { intent: 'Download with Export', download: { trigger: { role: 'button', name: 'Export' }, mime: ['text/csv'], check: ERP_CHECK } };
const EXTRACT: Step = { intent: 'Read the notices', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } };

function draftOf(steps: Step[]): Script {
  return { name: 'imported', version: 1, startUrl: `${URL0}/acme/login`, steps: [{ intent: 'Open the login page', goto: `${URL0}/acme/login` }, SIGN_IN, ...steps] };
}
const fileDraft = (extra: Step[] = []) => draftOf([...extra, DOWNLOAD]);
const adoptInput = (draft: Script, over: Partial<AdoptInput> = {}): AdoptInput => ({ draft, policy: POLICY, secrets: SECRETS, endpoint: LOCAL, ...over });
const taskInput = (script: unknown, over: Partial<TaskInput> = {}): TaskInput => ({ script, trust: { required: false }, policy: POLICY, secrets: SECRETS, endpoint: LOCAL, ...over });

function passingFileProof(): ProveResult {
  return {
    ok: true, rows: [], total: null, reasons: [], diff: { missing: [], extra: [] }, policyViolation: false, readPosts: [],
    file: { fileName: 'LINEITEMS_1000_2026-09-01_2026-09-30.csv', mimeType: 'text/csv', bytes: 120, columns: ['Document'], rows: 3 },
  };
}
const FILE = { fileName: 'LINEITEMS_1000.csv', mimeType: 'text/csv', data: Buffer.from('Document\n1\n'), binaryName: 'file_3' };
/** A script-lane success that read rows, downloaded a file and captured a screenshot. */
function laneSuccess(): ScriptRun {
  return {
    result: {
      ok: true, lane: 'script', name: 'imported', version: 1, hash: 'h', rows: [{ id: 'N26-0001', text: 'row' }], files: [FILE],
      outputs: [{ index: 2, verb: 'screenshot', binary: { name: 'screenshot_2', fileName: 's.png', mimeType: 'image/png', data: Buffer.from('png') } }],
      log: [], violations: [], blockedRequests: [], page: { url: `${URL0}/home`, title: 'Home', status: 200 }, verified: false, confirmed: false,
      writes: [], submitted: false, durationMs: 5,
    },
  };
}
const laneFailureRun = (code: 'policy_violation' | 'drift_detected', message: string): ScriptRun => ({
  result: { ok: false, code, message, violations: [], log: [], blockedRequests: [], durationMs: 5, version: 1, hash: 'h' },
});

beforeEach(() => {
  task.next = undefined;
  sessions.length = 0;
  lane.next = undefined;
  lane.seen.length = 0;
  prove.next = undefined;
  prove.seen.length = 0;
});

describe('adoption never writes', () => {
  const writers: [string, Step][] = [
    ['a submit', { intent: 'Send', submit: { button: { role: 'button', name: 'Send' }, path: '/acme/reports/export' } }],
    ['a download through a form', { intent: 'Export', download: { trigger: { role: 'button', name: 'Export CSV' }, via: { path: '/acme/reports/export' }, check: ERP_CHECK } }],
    ['a submit inside paginate', {
      intent: 'Every page', paginate: { next: { text: 'Next' }, until: 'absent', max: 3, each: [{ intent: 'Send', submit: { button: { text: 'Go' }, path: '/acme/reports/export' } }] },
    } as Step],
  ];
  it.each(writers)('a draft with %s is refused before the browser, without a proposal', async (_name, step) => {
    const r = await adoptDraft(adoptInput(fileDraft([step])));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', message: IMPORT_REFUSES_WRITES });
    expect(r).not.toHaveProperty('proposal');
    // Draft mode on its own refuses it too (defence in depth): no lane, no session.
    const t = await runDraft(taskInput(fileDraft([step])));
    expect(t).toMatchObject({ ok: false, code: 'policy_violation', message: IMPORT_REFUSES_WRITES, configError: true });
    expect(lane.seen).toEqual([]);
    expect(sessions).toEqual([]);
    expect(prove.seen).toEqual([]);
  });

  it('every adoption session uses the no-write policy, and a write the lane hits ends without a proof or proposal', async () => {
    lane.next = laneFailureRun('policy_violation', 'Click Export: a blocked request was attempted (POST portal.test/acme/reports/export)');
    const r = await adoptDraft(adoptInput(fileDraft()));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation' });
    expect(r).not.toHaveProperty('proposal');
    expect(prove.seen).toEqual([]);
    const [seen] = lane.seen;
    expect(seen.policy).toMatchObject({ allowedSubmits: [], writeMode: 'fatal', frameHostWrites: false, submitsFromSteps: false, refuseDestructiveNavigation: true });
    expect(seen.policy.writeWindow).toBeUndefined();
    // The proof runs under the no-write policy too.
    lane.next = laneSuccess();
    await adoptDraft(adoptInput(fileDraft(), { policy: { ...POLICY, writeWindow: { step: 2, maxPosts: 3, hosts: ['portal.test'] } } }));
    expect(prove.seen[0].policy).toMatchObject({ allowedSubmits: [], writeMode: 'fatal', submitsFromSteps: false });
    expect(prove.seen[0].policy.writeWindow).toBeUndefined();
  });

  it('a script-lane success that says a write left the browser never becomes a proposal', async () => {
    const run = laneSuccess();
    if (run.result.ok) run.result.submitted = true;
    lane.next = run;
    const r = await adoptDraft(adoptInput(fileDraft()));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', message: IMPORT_REFUSES_WRITES });
    expect(prove.seen).toEqual([]);
  });

  it('a proof that hits a blocked request is a policy violation without a proposal', async () => {
    lane.next = laneSuccess();
    prove.next = { ...passingFileProof(), ok: false, reasons: ['prove attempted a blocked request'], policyViolation: true };
    const r = await adoptDraft(adoptInput(fileDraft()));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation' });
    expect(r).not.toHaveProperty('proposal');
  });
});

describe('draft mode', () => {
  it('draft mode allows signIn but nothing else unsigned', async () => {
    lane.next = laneSuccess();
    const r = await runDraft(taskInput(fileDraft()));
    expect(r.ok).toBe(true);
    const [seen] = lane.seen;
    expect(seen.trust).toEqual({ required: false, allowUnsignedWrites: true });
    // The gate the lane runs admits the sign-in under that trust...
    expect(checkTrust(seen.script, seen.trust, { policy: seen.policy, firstRun: false })).toEqual({ ok: true, signed: false });
    // ...and the same document outside draft mode, unsigned, is refused before the browser as before.
    const plain = await runTask(taskInput(fileDraft()));
    expect(plain).toMatchObject({ ok: false, code: 'script_untrusted', message: UNSIGNED_WRITES });
    expect(sessions).toEqual([]);
  });

  it('nothing is delivered from an adoption run', async () => {
    lane.next = laneSuccess();
    const r = await runDraft(taskInput(fileDraft()));
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.rows).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.outputs).toEqual([]);
    // adoptDraft returns only the proposal and what describes it.
    lane.next = laneSuccess();
    const a = await adoptDraft(adoptInput(fileDraft()));
    if (!a.ok) throw new Error(JSON.stringify(a));
    expect(Object.keys(a).sort()).toEqual(['digest', 'durationMs', 'lane', 'llmCalls', 'ok', 'proposal']);
    expect(JSON.stringify(a)).not.toContain('N26-0001');
  });

  it('empty or unparseable drafts are refused before the browser', async () => {
    expect(await runDraft(taskInput([]))).toMatchObject({ ok: false, code: 'policy_violation', message: IMPORT_EMPTY, configError: true });
    expect(await runDraft(taskInput({ steps: [{ intent: 'x', bogus: 1 }] }))).toMatchObject({ ok: false, code: 'policy_violation', configError: true });
    expect(await runDraft(taskInput('{"steps":[]}'))).toMatchObject({ ok: false, code: 'policy_violation' });
    expect(lane.seen).toEqual([]);
    expect(sessions).toEqual([]);
  });

  it('trust input never reaches draft mode, and runTask ignores a draft key of any value', async () => {
    lane.next = laneSuccess();
    const bogus = { required: true, signature: 'not-a-signature', approvedBy: 'x', key: TEST_KEY, expect: { name: 'other', version: 9 } };
    // DraftTaskInput has no trust; one smuggled in from untyped code is not read.
    const r = await runDraft({ ...taskInput(fileDraft()), trust: bogus } as never);
    expect(r.ok).toBe(true);
    expect(lane.seen[0].trust).toEqual({ required: false, allowUnsignedWrites: true });
    // runTask has no draft mode: whatever `draft` holds, the document meets the ordinary gate with the caller's trust.
    for (const draft of [true, 'true', 1, {}, [true]]) {
      expect(await runTask({ ...taskInput(fileDraft()), draft } as never)).toMatchObject({ ok: false, code: 'script_untrusted', message: UNSIGNED_WRITES });
      expect(await runTask({ ...taskInput(fileDraft(), { trust: bogus }), draft } as never)).toMatchObject({ ok: false, code: 'script_untrusted', message: UNSIGNED_REQUIRED });
    }
    expect(lane.seen.filter((s) => s.trust.allowUnsignedWrites === true)).toHaveLength(1);
    expect(sessions).toEqual([]);
    // Draft mode is not part of the package: only adoptDraft reaches it.
    const api = await import('../src/index.js');
    expect(api).toHaveProperty('adoptDraft');
    for (const name of ['runDraft', 'draftWrites', 'adoptableKind']) expect(api).not.toHaveProperty(name);
  });
});

describe('what can be adopted', () => {
  const cases: [string, Script, AdoptInput['output']?][] = [
    ['no rows and no file', draftOf([{ intent: 'Open Reports', click: { role: 'link', name: 'Reports' } }])],
    ['rows without an ID Pattern', draftOf([EXTRACT])],
    ['an ID Pattern but no extract step', draftOf([{ intent: 'Open Reports', click: { role: 'link', name: 'Reports' } }]), { idPattern: 'N26-\\d{4}' }],
    ['a download without a check', draftOf([{ intent: 'Export', download: { trigger: { role: 'button', name: 'Export' } } }])],
    ['a check that names neither the file nor its columns', draftOf([{ intent: 'Export', download: { trigger: { role: 'button', name: 'Export' }, check: { minRows: 1 } } }])],
    ['two downloads', draftOf([DOWNLOAD, DOWNLOAD])],
    ['a download and an extract', draftOf([EXTRACT, DOWNLOAD]), { idPattern: 'N26-\\d{4}' }],
    ['a screenshot', draftOf([{ intent: 'Shoot', screenshot: { capture: 'viewport' } }, DOWNLOAD])],
    ['a download inside paginate', draftOf([{ intent: 'Pages', paginate: { next: { text: 'Next' }, until: 'absent', max: 2, each: [DOWNLOAD] } } as Step])],
  ];
  it.each(cases)('a non-adoptable draft (%s) returns IMPORT_NOT_ADOPTABLE', async (_name, draft, output) => {
    const r = await adoptDraft(adoptInput(draft, output ? { output } : {}));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', adoptable: false, configError: true });
    // The golden text first; a draft that has something to prove but in a shape prove cannot judge says what is missing.
    expect((r.ok ? '' : r.message).startsWith(IMPORT_NOT_ADOPTABLE)).toBe(true);
    if (_name === 'no rows and no file') expect(r.ok ? '' : r.message).toBe(IMPORT_NOT_ADOPTABLE);
    else expect(r.ok ? '' : r.message.length).toBeGreaterThan(IMPORT_NOT_ADOPTABLE.length);
    expect(lane.seen).toEqual([]);
    expect(sessions).toEqual([]);
  });

  it('a rows draft with an ID Pattern and an extract step is adopted; its proof judges rows', async () => {
    lane.next = laneSuccess();
    prove.next = { ok: true, rows: [{ id: 'N26-0001' }], total: 1, reasons: [], diff: { missing: [], extra: ['N26-0001'] }, policyViolation: false, readPosts: [] };
    const r = await adoptDraft(adoptInput(draftOf([EXTRACT]), { output: { idPattern: 'N26-\\d{4}' } }));
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(prove.seen[0].expectFile).toBeUndefined();
    expect(prove.seen[0].output).toEqual({ idPattern: 'N26-\\d{4}' });
    // There are no agent rows to compare with: the evidence carries no ID list.
    expect(r.proposal.evidence).toEqual({ count: 1, total: 1, diff: { missing: [], extra: [] } });
  });
});

describe('the adoption flow', () => {
  it('a clean run is proved in a fresh browser with no model and becomes version 1', async () => {
    lane.next = laneSuccess();
    const model = fakeModel([]);
    const r = await adoptDraft(adoptInput(fileDraft(), { vars: { company: '1000' }, saveTrace: 'never', repair: { model, goal: 'export' } }));
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r).toMatchObject({ lane: 'script', llmCalls: 0 });
    expect(model.invocations).toEqual([]);
    expect(prove.seen).toHaveLength(1);
    const p = prove.seen[0];
    expect(p).toMatchObject({ expectFile: true, trace: false, vars: { company: '1000' }, agentRows: [] });
    expect(p.checkFallbacksFrom).toBeUndefined();
    expect(p.storageState).toBeUndefined();
    expect(p.script).toEqual(fileDraft());
    expect(r.proposal).toMatchObject({ name: 'imported', baseVersion: null, version: 1, steps: fileDraft() });
    expect(r.proposal.evidence.file?.rows).toBe(3);
    expect(r.proposal.safetyFlags).toContain('new download step');
    expect(r.proposal.changes.every((c) => c.was === null)).toBe(true);
    expect(r.digest).toBe(proposalDigest(r.proposal));
  });

  it('a draft without a version is proved and proposed as version 1', async () => {
    lane.next = laneSuccess();
    const { version: _v, ...unversioned } = fileDraft();
    const r = await adoptDraft(adoptInput(unversioned as Script));
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(prove.seen[0].script.version).toBe(1);
    expect(r.proposal.version).toBe(1);
  });

  it('a failed proof reports its reason and gives no proposal', async () => {
    lane.next = laneSuccess();
    prove.next = { ...passingFileProof(), ok: false, reasons: ['Download with Export: no file arrived'], failureCode: 'drift_detected' };
    const r = await adoptDraft(adoptInput(fileDraft()));
    expect(r).toMatchObject({ ok: false, code: 'incomplete', lane: 'script', message: `${IMPORT_PROOF_FAILED}. Reason: Download with Export: no file arrived` });
    expect(r).not.toHaveProperty('proposal');
    // A login failure in the proof keeps its code (the node's login breaker).
    lane.next = laneSuccess();
    prove.next = { ...passingFileProof(), ok: false, reasons: ['Sign in: rejected'], failureCode: 'login_failed' };
    expect(await adoptDraft(adoptInput(fileDraft()))).toMatchObject({ ok: false, code: 'login_failed' });
  });

  it('a repair whose proof failed names the proof, not Deliver Unconfirmed Rows', async () => {
    // The scripted run stands in for the agent lane's failure: adoptDraft reads only its message.
    lane.next = { result: { ok: false, code: 'incomplete', message: `${ROWS_WITHHELD}. Reason: a zero-row proof cannot confirm a recorded script`, violations: [], log: [], blockedRequests: [], durationMs: 1 } };
    const r = await adoptDraft(adoptInput(draftOf([EXTRACT]), { output: { idPattern: 'N26-\\d{4}' }, repair: { model: fakeModel([]), goal: 'rows' } }));
    expect(r).toMatchObject({ ok: false, code: 'incomplete', message: `${IMPORT_PROOF_FAILED}. Reason: a zero-row proof cannot confirm a recorded script` });
  });

  it('a cancelled adoption does not start the proof', async () => {
    const ac = new AbortController();
    lane.next = laneSuccess();
    // The run itself finished; the caller cancelled right after.
    const r = adoptDraft(adoptInput(fileDraft(), { signal: ac.signal }));
    ac.abort();
    expect(await r).toMatchObject({ ok: false, code: 'incomplete', message: CANCELLED });
    expect(prove.seen).toEqual([]);
  });

  it('a healed draft is proposed as a first version: the whole document is reviewed', async () => {
    // The agent lane's proposal is built on the draft as its base (version 2, base 1), as runTask's repair path builds it.
    const healed: Script = { ...fileDraft(), version: 2 };
    healed.steps.splice(2, 0, { intent: 'Click G/L Line Items', click: { role: 'button', name: 'G/L Line Items', exact: true } });
    const agentProposal = buildProposal({ base: fileDraft(), script: healed, prove: passingFileProof(), safetyFlags: ['repair flag'], masker: createMasker([]) });
    // Against the draft, the approver would see only the one step the repair added.
    expect(agentProposal.changes).toHaveLength(1);
    expect(agentProposal.baseVersion).toBe(1);
    task.next = {
      ok: true, lane: 'agent', name: 'imported', version: 1, hash: 'h', rows: [], files: [], page: { url: URL0, title: '', status: 200 }, outputs: [],
      confirmed: true, proposal: agentProposal, digest: proposalDigest(agentProposal), agentLog: [], log: [], violations: [], blockedRequests: [],
      tokens: 10, llmCalls: 3, durationMs: 1, note: 'done', transcript: [], submitted: false,
    } satisfies TaskResult;
    const r = await adoptDraft(adoptInput(fileDraft(), { repair: { model: fakeModel([]), goal: 'export' } }));
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r).toMatchObject({ lane: 'agent', llmCalls: 3 });
    const p = r.proposal;
    expect(p).toMatchObject({ name: 'imported', baseVersion: null, version: 1 });
    expect(p.steps).toEqual({ ...healed, version: 1 });
    expect(p.hash).toBe(scriptHash(p.steps));
    expect(p.changes).toHaveLength(p.steps.steps.length);
    expect(p.changes.every((c) => c.was === null)).toBe(true);
    expect(p.safetyFlags).toContain('new download step');
    expect(p.safetyFlags).toContain('new host: portal.test');
    expect(p.safetyFlags).toContain('repair flag');
    expect(new Set(p.safetyFlags).size).toBe(p.safetyFlags.length);
    expect(p.evidence).toEqual(agentProposal.evidence);
    expect(r.digest).toBe(proposalDigest(p));
    expect(r.digest).not.toBe(proposalDigest(agentProposal));
  });

  it('an adoption failure carries no transcript or agent log (page snapshots)', async () => {
    task.next = {
      ok: false, code: 'not_found', message: 'the agent did not find the data: gone', lane: 'agent', violations: [], log: [], blockedRequests: [], durationMs: 1,
      transcript: [{ role: 'user', content: '<page_content>secret page</page_content>' }], agentLog: [{ tool: 'look', ok: true, url: URL0 }], llmCalls: 2, tokens: 5,
    } satisfies TaskResult;
    const r = await adoptDraft(adoptInput(fileDraft(), { repair: { model: fakeModel([]), goal: 'export' } }));
    expect(r).toMatchObject({ ok: false, code: 'not_found', message: 'the agent did not find the data: gone', lane: 'agent', llmCalls: 2 });
    expect(r).not.toHaveProperty('transcript');
    expect(r).not.toHaveProperty('agentLog');
    expect(JSON.stringify(r)).not.toContain('secret page');
  });

  it('a drift without a model returns the step error as drift_detected', async () => {
    lane.next = laneFailureRun('drift_detected', 'Click Line Item Report: no element matches text "Line Item Report"');
    const r = await adoptDraft(adoptInput(fileDraft()));
    expect(r).toMatchObject({ ok: false, code: 'drift_detected', lane: 'script', message: 'Click Line Item Report: no element matches text "Line Item Report"' });
    expect(prove.seen).toEqual([]);
  });

  it('a draft repair cannot work on runs without the model: its drift says why', async () => {
    // A rows draft with a table read is adoptable, but repair records only extract steps.
    const table: Step = { intent: 'Read the grid', extractTable: { table: { role: 'grid' }, idPattern: '19\\d{8}' } };
    lane.next = laneFailureRun('drift_detected', 'Read the grid: no table');
    const model = fakeModel([]);
    const r = await adoptDraft(adoptInput(draftOf([table]), { output: { idPattern: '19\\d{8}' }, repair: { model, goal: 'rows' } }));
    expect(r).toMatchObject({ ok: false, code: 'drift_detected', message: `Read the grid: no table (${REPAIR_NEEDS_ID_AND_EXTRACT})` });
    expect(model.invocations).toEqual([]);
  });

  it('policy violations in the draft end the adoption before the browser', async () => {
    const offsite = draftOf([{ intent: 'Leave', goto: 'https://elsewhere.test/x' }, DOWNLOAD]);
    const r = await adoptDraft(adoptInput(offsite));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation' });
    expect(r.ok ? '' : r.message).toContain('elsewhere.test');
    // signIn without a Site Login is a policy violation too.
    const noLogin = await adoptDraft(adoptInput(fileDraft(), { secrets: undefined }));
    expect(noLogin).toMatchObject({ ok: false, code: 'policy_violation' });
    expect(lane.seen).toEqual([]);
    expect(sessions).toEqual([]);
  });
});
