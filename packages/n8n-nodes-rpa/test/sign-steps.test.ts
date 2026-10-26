import { describe, expect, it } from 'vitest';
import { NodeOperationError, type IDataObject, type INodeExecutionData } from 'n8n-workflow';
import { describeInterrupt, describeStep, proposalDigest, scriptHash, verifyScript, type Proposal, type Script } from 'n8n-rpa-engine';
import { changeList, evidenceLine, fullSafetyFlags, safetyLine } from '../nodes/Playwright/format.js';
import { CHANGE_LIST_MISMATCH, executeSignSteps, parseRepairedSteps, READ_POSTS_NOT_LISTED } from '../nodes/Playwright/operations/signSteps.js';
import { repairedStepsItem, repairedStepsJson } from '../nodes/Playwright/output.js';
import { rejectedRecord, signedRecord, STEPS_TABLE_COLUMNS } from '../nodes/Playwright/rows.js';
import { fakeEngine } from './fake-engine.js';
import { harness, type HarnessOptions } from './harness.js';

// Golden strings are written out here on purpose.
const KEY = 'sign-steps-signing-key-0123456789abcdef';
const APPROVER = 'approver@example.com';
const NOW = new Date('2026-10-07T09:30:00.000Z');
const USER = 'site-user-7c1';
const PASS = 'site-pass-9f2';
const SIGNING = { playwrightScriptSigningApi: { secretKey: KEY } };
const SITE_LOGIN = { loginUrl: 'https://example.com/login', username: USER, password: PASS };
const STEPS: Script = {
  name: 'items', version: 2, startUrl: 'https://example.com/list',
  steps: [
    { intent: 'Open the list', goto: 'https://example.com/list' },
    { intent: 'Read the items', extract: { scope: { css: 'main' }, idPattern: 'SKU-\\d{4}' } },
  ],
};
const NOT_REPAIRED = 'The input item is not a Repaired steps item from Run Steps (it has no digest). Only Repaired steps items can be signed.';

const engine = fakeEngine(() => {
  throw new Error('Sign Steps never opens a browser');
});
type Evidence = Proposal['evidence'];
const EVIDENCE: Evidence = { count: 3, total: 3, diff: { missing: [], extra: [] } };
/**
 * The engine's proposal for `steps`: a repair of version 1. `flags` are the engine's own flags, relative to the base
 * (a repair on an unchanged host has none); Run Steps replaces them with the full list.
 */
/** The change list a repair of the read step shows: the last step, described from the steps (engine describeStep). */
const changesFor = (steps: Script) => [{ was: 'Read the list (extract rows from css "main")', now: describeStep(steps.steps[steps.steps.length - 1]) }];
const proposalFor = (steps: Script, flags: string[] = [], evidence: Evidence = EVIDENCE): Proposal => ({
  name: steps.name as string, baseVersion: 1, version: steps.version as number, steps, hash: scriptHash(steps),
  evidence, changes: changesFor(steps), safetyFlags: flags, screenshots: {},
});
/** A Repaired steps item exactly as Run Steps emits it (output.ts repairedStepsJson), with `over` applied last. */
function repairedItem(steps: Script, over: IDataObject = {}): IDataObject {
  return { ...repairedStepsJson(engine, proposalFor(steps)), ...over };
}
/** A hand-made item whose digest is valid for the `flags` it carries, and whose lines are formatted from them. */
function craftedItem(steps: Script, flags: string[], evidence: Evidence = EVIDENCE, changes: Proposal['changes'] = changesFor(steps)): IDataObject {
  const p = { ...proposalFor(steps, flags, evidence), changes };
  return {
    name: p.name, baseVersion: p.baseVersion, version: p.version, steps: JSON.parse(JSON.stringify(steps)) as IDataObject, hash: p.hash,
    digest: proposalDigest(p), evidence: JSON.parse(JSON.stringify(evidence)) as IDataObject, changes: JSON.parse(JSON.stringify(changes)) as IDataObject[],
    safetyFlags: flags, evidenceLine: evidenceLine(p, engine), changeList: changeList(p), safetyLine: safetyLine(p), attachmentNames: '',
  };
}
const params = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  operation: 'signSteps', approved: true, approverId: APPROVER, approverAllowlist: `${APPROVER}, lead@example.com`, ...over,
});
async function sign(item: IDataObject, over: Partial<HarnessOptions> = {}): Promise<INodeExecutionData[][]> {
  return executeSignSteps(harness({ params: params(), items: [{ json: item }], credentials: SIGNING, continueOnFail: true, ...over }), engine, () => NOW);
}
const only = (out: INodeExecutionData[][]) => out[0][0];

describe('steps table records', () => {
  it('has the nine v2 columns', () => {
    expect(STEPS_TABLE_COLUMNS).toEqual([
      { name: 'name', type: 'string' }, { name: 'version', type: 'number' }, { name: 'steps', type: 'string' }, { name: 'hash', type: 'string' },
      { name: 'signature', type: 'string' }, { name: 'approvedBy', type: 'string' }, { name: 'approvedAt', type: 'string' },
      { name: 'status', type: 'string' }, { name: 'expiresAt', type: 'string' },
    ]);
  });
  it('builds signed and rejected records shaped as steps-table rows', () => {
    const row = { name: 'items', version: 2, steps: STEPS, hash: 'h2', signature: 's2', approvedBy: APPROVER, approvedAt: NOW.toISOString(), status: 'active' as const };
    expect(signedRecord(row)).toEqual({ name: 'items', version: 2, steps: JSON.stringify(STEPS), hash: 'h2', signature: 's2', approvedBy: APPROVER, approvedAt: NOW.toISOString(), status: 'active' });
    expect(rejectedRecord({ name: 'items', version: 2, hash: 'h2' }, APPROVER, NOW)).toEqual({
      name: 'items', version: 2, steps: '', hash: 'h2', signature: '', approvedBy: APPROVER, approvedAt: NOW.toISOString(), status: 'rejected',
    });
  });
  it('parseRepairedSteps reads the item; steps as JSON text are parsed once; missing fields become null or empty', () => {
    const item = repairedItem(STEPS);
    expect(parseRepairedSteps({ ...item, steps: JSON.stringify(STEPS), version: '2' })).toMatchObject({
      name: 'items', baseVersion: 1, version: 2, steps: STEPS, hash: item.hash, digest: item.digest, safetyFlags: ['host: example.com'],
    });
    expect(parseRepairedSteps({})).toMatchObject({ name: null, version: null, baseVersion: null, hash: '', digest: '', changes: [], safetyFlags: [] });
  });
});

describe('Sign Steps: approve', () => {
  it('signs a Repaired steps item into an active record that verifies with the key and the approver', async () => {
    const out = await sign(repairedItem(STEPS));
    expect(out).toHaveLength(1);
    const rec = only(out).json;
    expect(Object.keys(rec)).toEqual(STEPS_TABLE_COLUMNS.map((c) => c.name).filter((n) => n !== 'expiresAt'));
    expect(rec).toMatchObject({ name: 'items', version: 2, hash: scriptHash(STEPS), approvedBy: APPROVER, approvedAt: NOW.toISOString(), status: 'active' });
    expect(JSON.parse(rec.steps as string)).toEqual(STEPS);
    expect(rec.signature).toMatch(/^[0-9a-f]{64}$/);
    const raw = JSON.parse(rec.steps as string) as unknown;
    expect(verifyScript(raw, KEY, { approvedBy: APPROVER, signature: rec.signature as string })).toBe(true);
    expect(verifyScript(raw, KEY, { approvedBy: APPROVER, siteLoginId: 'site-a', signature: rec.signature as string })).toBe(false);
    expect(only(out).pairedItem).toEqual([{ item: 0 }]);
  });
  it('accepts steps given as JSON text (a value passed through an email or a Data Table)', async () => {
    expect(only(await sign(repairedItem(STEPS, { steps: JSON.stringify(STEPS) }))).json.status).toBe('active');
  });
  it('with a Site Login the signature binds its credential id: it verifies with that id only', async () => {
    const rec = only(await sign(repairedItem(STEPS), {
      credentials: { ...SIGNING, playwrightSiteLoginApi: SITE_LOGIN }, credentialIds: { playwrightSiteLoginApi: 'site-a' },
    })).json;
    expect(rec.status).toBe('active');
    const raw = JSON.parse(rec.steps as string) as unknown;
    const signature = rec.signature as string;
    expect(verifyScript(raw, KEY, { approvedBy: APPROVER, siteLoginId: 'site-a', signature })).toBe(true);
    expect(verifyScript(raw, KEY, { approvedBy: APPROVER, siteLoginId: 'site-b', signature })).toBe(false);
    expect(verifyScript(raw, KEY, { approvedBy: APPROVER, signature })).toBe(false);
  });
  it('without a Site Login, steps that open another host named in their gotos are signed (derived policy)', async () => {
    const steps: Script = { ...STEPS, steps: [...STEPS.steps, { intent: 'Open the archive', goto: 'https://archive.example.org/old' }] };
    expect(only(await sign(repairedItem(steps))).json.status).toBe('active');
  });
  it('without a Site Login, a submit to a host the steps never open is refused', async () => {
    const steps: Script = {
      ...STEPS, steps: [...STEPS.steps, { intent: 'Send the form', submit: { host: 'forms.other.net', path: '/send', button: { role: 'button', name: 'Send' } } }],
    };
    const e = only(await sign(repairedItem(steps))).json;
    expect(e.message).toMatch(/^Sign Steps refused: /);
    expect(e.message).toContain('forms.other.net');
    expect((e.details as IDataObject).code).toBeNull();
  });
});

describe('Sign Steps: refusals', () => {
  it('an item without a digest is refused (a Repaired steps item from Run Steps always carries one)', async () => {
    const { digest: _digest, ...noDigest } = repairedItem(STEPS);
    for (const item of [noDigest, { name: 'items', version: 2, steps: STEPS }]) {
      expect(only(await sign(item)).json).toEqual({
        error: `Sign Steps refused: ${NOT_REPAIRED}`, message: `Sign Steps refused: ${NOT_REPAIRED}`,
        details: { code: null, reasons: [NOT_REPAIRED], name: 'items', version: 2 },
      });
    }
  });
  it('an item without a name or a version is refused', async () => {
    for (const over of [{ name: '' }, { name: undefined }, { version: null }, { version: 'two' }]) {
      expect(only(await sign(repairedItem(STEPS, over))).json.message).toBe('Sign Steps refused: The Repaired steps item has no name or version.');
    }
  });
  it('edited steps, an edited evidence line and edited safety flags are refused', async () => {
    const edited: Script = { ...STEPS, steps: [STEPS.steps[0], { intent: 'Read every item', extract: { scope: { css: 'body' }, idPattern: 'SKU-\\d{4}' } }] };
    const a = only(await sign({ ...repairedItem(STEPS), steps: JSON.parse(JSON.stringify(edited)) as IDataObject })).json;
    expect(a.message).toMatch(/^Sign Steps refused: /);
    expect(a.message).toContain('the steps do not match the hash that was reviewed');
    const b = only(await sign(repairedItem(STEPS, { evidenceLine: 'Proven in a fresh browser: 300 of 300 rows' }))).json;
    expect(b.message).toBe('Sign Steps refused: the evidence, change list or safety line changed after it was reviewed');
    // Recomputed from the steps before the engine runs: the engine's digest check is not reached.
    const c = only(await sign(repairedItem(STEPS, { safetyFlags: [], safetyLine: 'none' }))).json;
    expect(c.message).toBe('Sign Steps refused: the safety flags do not list every host, form submission, download and pop-up handler the steps have');
  });
  it('Approved By off the allowlist is refused, for approvals and for rejections', async () => {
    for (const approved of [true, false]) {
      for (const approverId of ['mallory@example.com', '']) {
        const e = only(await sign(repairedItem(STEPS), { params: params({ approved, approverId }) })).json;
        expect(e.message).toBe('Sign Steps refused: Approved By is not on the Approver Allowlist');
      }
    }
    expect(only(await sign(repairedItem(STEPS), { params: params({ approverId: 'Approver@Example.com' }) })).json.status).toBe('active');
  });
  it('without continue-on-fail a refusal is thrown with its reasons', async () => {
    const run = executeSignSteps(harness({ params: params({ approverId: 'mallory@example.com' }), items: [{ json: repairedItem(STEPS) }], credentials: SIGNING }), engine, () => NOW);
    await expect(run).rejects.toThrow('Sign Steps refused: Approved By is not on the Approver Allowlist');
  });
});

describe('Sign Steps: reject', () => {
  it('Approved off records a rejection with empty steps and signature', async () => {
    expect(only(await sign(repairedItem(STEPS), { params: params({ approved: false }) })).json).toEqual({
      name: 'items', version: 2, steps: '', hash: scriptHash(STEPS), signature: '', approvedBy: APPROVER, approvedAt: NOW.toISOString(), status: 'rejected',
    });
  });
  it('an unknown answer (a timed-out approval, a typo) is a rejection, never an approval', async () => {
    for (const approved of ['maybe', undefined, null]) {
      expect(only(await sign(repairedItem(STEPS), { params: params({ approved }) })).json.status).toBe('rejected');
    }
  });
});

describe('Sign Steps: configuration and secrets', () => {
  it('without a Step Signing credential it is a configuration error', async () => {
    expect(only(await sign(repairedItem(STEPS), { credentials: {} })).json).toEqual({
      error: 'Sign Steps needs an RPA Step Signing credential', message: 'Sign Steps needs an RPA Step Signing credential',
      details: { configError: true, code: null, name: null, version: null, hash: '', lane: null, log: [], submitted: false },
    });
    const run = executeSignSteps(harness({ params: params(), items: [{ json: repairedItem(STEPS) }], credentials: {} }), engine, () => NOW);
    await expect(run).rejects.toThrow('Sign Steps needs an RPA Step Signing credential');
  });
  it('never outputs the signing key or a Site Login secret', async () => {
    const refusedNamedKey = await sign(repairedItem({ ...STEPS, name: KEY }, { digest: '' }));
    const recordWithKey = await sign(repairedItem({ ...STEPS, name: KEY }));
    const typing: Script = { ...STEPS, steps: [...STEPS.steps, { intent: 'Type the code', fill: { field: { label: 'Code' }, value: PASS } }] };
    const typesPassword = await sign(repairedItem(typing), { credentials: { ...SIGNING, playwrightSiteLoginApi: SITE_LOGIN } });
    const text = JSON.stringify([refusedNamedKey, recordWithKey, typesPassword]);
    for (const secret of [KEY, PASS]) expect(text).not.toContain(secret);
    expect(only(refusedNamedKey).json.message).toBe(`Sign Steps refused: ${NOT_REPAIRED}`);
    expect(only(recordWithKey).json.message).toBe('Sign Steps refused: the Repaired steps contain a credential secret');
    expect(only(typesPassword).json.message).toMatch(/^Sign Steps refused: /);
  });
  it('more input items than Options → Max Items fail before anything is signed', async () => {
    const message = 'This node received 2 items, more than Options → Max Items (1). Nothing ran.';
    const out = await sign(repairedItem(STEPS), { items: [{ json: repairedItem(STEPS) }, { json: repairedItem(STEPS) }], params: { ...params(), options: { maxItems: 1 } } });
    expect(out[0].map((d) => d.json.error)).toEqual([message, message]);
    expect(out[0].map((d) => d.pairedItem)).toEqual([[{ item: 0 }], [{ item: 1 }]]);
  });
});

describe('Sign Steps: unexpected errors under continue-on-fail', () => {
  /** A harness whose getNodeParameter throws for one parameter, as n8n does when an expression in it fails. */
  const throwingOn = (name: string, over: Partial<HarnessOptions> = {}) => {
    const h = harness({ params: params(), items: [{ json: repairedItem(STEPS) }, { json: repairedItem(STEPS) }], credentials: SIGNING, ...over });
    const get = h.getNodeParameter.bind(h);
    h.getNodeParameter = (n: string, i: number, fallback?: unknown) => {
      if (n === name && i === 0) throw new Error(`Could not evaluate ${n}`);
      return get(n, i, fallback);
    };
    return h;
  };
  it('a parameter read that throws is a paired configuration error item, never a throw or a copied input item', async () => {
    for (const name of ['approverId', 'approverAllowlist', 'approved']) {
      const [out] = await executeSignSteps(throwingOn(name, { continueOnFail: true }), engine, () => NOW);
      expect(out).toHaveLength(2);
      expect(out[0].json).toMatchObject({ error: `Could not evaluate ${name}`, details: { configError: true } });
      expect(out[0].pairedItem).toEqual([{ item: 0 }]);
      expect(out[1].json.status).toBe('active');
      expect(out[1].pairedItem).toEqual([{ item: 1 }]);
    }
  });
  it('without continue-on-fail the same read throws a NodeOperationError', async () => {
    const err = await executeSignSteps(throwingOn('approved'), engine, () => NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeOperationError);
    expect((err as NodeOperationError).message).toBe('Could not evaluate approved');
  });
});

describe('Sign Steps: flags and digest edge cases', () => {
  const SITE_LOGIN_NO_ID = 'The RPA Site Login credential has no id. Save the credential, then select it again on this node.';
  const SHOWN = 'Sign Steps refused: the evidence, change list or safety line changed after it was reviewed';

  it('a Site Login secret shorter than 4 characters does not block an approval (same rule as the engine)', async () => {
    const steps: Script = { ...STEPS, steps: [{ intent: 'Open the job list', goto: 'https://example.com/list' }, STEPS.steps[1]] };
    const rec = only(await sign(repairedItem(steps), {
      credentials: { ...SIGNING, playwrightSiteLoginApi: { ...SITE_LOGIN, username: 'jo' } }, credentialIds: { playwrightSiteLoginApi: 'site-a' },
    })).json;
    expect(rec.status).toBe('active');
  });
  it('a Site Login secret of 4 characters or more in the steps still blocks the record', async () => {
    const steps: Script = { ...STEPS, steps: [{ intent: `Open the list of ${USER}`, goto: 'https://example.com/list' }, STEPS.steps[1]] };
    const e = only(await sign(repairedItem(steps), {
      credentials: { ...SIGNING, playwrightSiteLoginApi: SITE_LOGIN }, credentialIds: { playwrightSiteLoginApi: 'site-a' },
    })).json;
    expect(e.message).toMatch(/^Sign Steps refused: /);
    expect(JSON.stringify(e)).not.toContain(USER);
  });
  it('a rejection whose hash is not the hash of its steps is refused, so it can never mark another row rejected', async () => {
    for (const over of [{ hash: 'f'.repeat(64) }, { steps: undefined }, { steps: 'not json' }]) {
      const e = only(await sign(repairedItem(STEPS, over), { params: params({ approved: false }) })).json;
      expect(e.message).toBe('Sign Steps refused: the steps do not match the hash that was reviewed');
    }
  });
  it('an attached Site Login without an id is refused (an empty id would sign as "no Site Login")', async () => {
    for (const approved of [true, false]) {
      const e = only(await sign(repairedItem(STEPS), {
        params: params({ approved }), credentials: { ...SIGNING, playwrightSiteLoginApi: SITE_LOGIN }, credentialIds: { playwrightSiteLoginApi: '' },
      })).json;
      expect(e.message).toBe(`Sign Steps refused: ${SITE_LOGIN_NO_ID}`);
      expect((e.details as IDataObject).code).toBeNull();
    }
  });
  it('Approver Allowlist set by an expression is a configuration error (literal only), for approvals and rejections', async () => {
    const message = 'Approver Allowlist must be set directly, not with an expression.';
    for (const approved of [true, false]) {
      const p = params({ approved });
      const e = only(await sign(repairedItem(STEPS), { params: p, rawParameters: { ...p, approverAllowlist: '={{ $json.allowlist }}' } })).json;
      expect(e).toMatchObject({ error: message, message, details: { configError: true, code: null } });
      // Real n8n strips the "=" of a noDataExpression parameter: the stripped form is refused too.
      const stripped = { ...p, approverAllowlist: '{{ $json.allowlist }}' };
      expect(only(await sign(repairedItem(STEPS), { params: stripped, rawParameters: stripped })).json).toMatchObject({ error: message, details: { configError: true } });
    }
    const p = params();
    const run = executeSignSteps(
      harness({ params: p, rawParameters: { ...p, approverAllowlist: '={{ $json.allowlist }}' }, items: [{ json: repairedItem(STEPS) }], credentials: SIGNING }), engine, () => NOW,
    );
    await expect(run).rejects.toThrow(message);
  });
  it('with a Site Login, a goto to a host outside its sites is refused', async () => {
    const steps: Script = { ...STEPS, steps: [...STEPS.steps, { intent: 'Open the archive', goto: 'https://archive.example.org/old' }] };
    const e = only(await sign(repairedItem(steps), {
      credentials: { ...SIGNING, playwrightSiteLoginApi: SITE_LOGIN }, credentialIds: { playwrightSiteLoginApi: 'site-a' },
    })).json;
    expect(e.message).toMatch(/^Sign Steps refused: /);
    expect(e.message).toContain('goto host archive.example.org is not in the allowed hosts');
  });
  it('an item whose change list alone was edited is refused', async () => {
    expect(only(await sign(repairedItem(STEPS, { changeList: 'No step changes' }))).json.message).toBe(SHOWN);
  });
  it('a signing key of 32 or more spaces is refused', async () => {
    const e = only(await sign(repairedItem(STEPS), { credentials: { playwrightScriptSigningApi: { secretKey: ' '.repeat(40) } } })).json;
    expect(e.message).toMatch(/^Sign Steps refused: /);
    expect(e.message).toContain('signing key is empty');
    expect(e).not.toHaveProperty('status');
  });
});

describe('Sign Steps: safety flags list every host, form submission and download', () => {
  const INCOMPLETE = 'Sign Steps refused: the safety flags do not list every host, form submission, download and pop-up handler the steps have';
  const SHOWN = 'Sign Steps refused: the evidence, change list or safety line changed after it was reviewed';
  const TWO_HOSTS: Script = { ...STEPS, steps: [...STEPS.steps, { intent: 'Open the archive', goto: 'https://archive.example.org/old' }] };
  const UNVERIFIED = 'count unverified: the page that was read states no total';
  const NO_TOTAL: Evidence = { count: 3, total: null, diff: { missing: [], extra: [] } };

  it('fullSafetyFlags lists every host, submission and download from the steps, then the two flags only the run knows', () => {
    const steps: Script = {
      ...STEPS, steps: [
        ...STEPS.steps,
        { intent: 'Send the form', submit: { host: 'forms.other.net', path: '/send', button: { role: 'button', name: 'Send' } } },
        { intent: 'Get the file', download: { trigger: { role: 'link', name: 'CSV' } } },
      ],
    };
    expect(fullSafetyFlags(engine, engine.parseScript(steps), { unverifiedCount: true, fieldsDropped: true })).toEqual([
      'form submission: POST forms.other.net/send', 'download step', 'host: example.com', 'host: forms.other.net', 'extract-fields-dropped', UNVERIFIED,
    ]);
    expect(fullSafetyFlags(engine, engine.parseScript(STEPS), { unverifiedCount: false, fieldsDropped: false })).toEqual(['host: example.com']);
  });
  it('Run Steps emits the full list, whatever the engine flagged as new, and the digest covers it', () => {
    const p = proposalFor(TWO_HOSTS, ['new host: archive.example.org']);
    const flags = ['host: example.com', 'host: archive.example.org'];
    expect(repairedStepsJson(engine, p)).toMatchObject({
      safetyFlags: flags, safetyLine: 'host: example.com; host: archive.example.org', digest: proposalDigest({ ...p, safetyFlags: flags }),
    });
    expect(repairedStepsJson(engine, proposalFor(STEPS, [UNVERIFIED], NO_TOTAL)).safetyFlags).toEqual(['host: example.com', UNVERIFIED]);
  });
  it('a Run Steps repair on an unchanged host (no engine flags) round-trips through Sign Steps and is signed', async () => {
    const item = await repairedStepsItem(harness({ params: {} }), engine, proposalFor(STEPS, []));
    expect(item.json).toMatchObject({ safetyFlags: ['host: example.com'], safetyLine: 'host: example.com' });
    const rec = only(await sign(item.json)).json;
    expect(rec.status).toBe('active');
    expect(verifyScript(JSON.parse(rec.steps as string), KEY, { approvedBy: APPROVER, signature: rec.signature as string })).toBe(true);
    const twoHosts = await repairedStepsItem(harness({ params: {} }), engine, proposalFor(TWO_HOSTS, ['new host: archive.example.org']));
    expect(only(await sign(twoHosts.json)).json.status).toBe('active');
    const unverified = await repairedStepsItem(harness({ params: {} }), engine, proposalFor(STEPS, [UNVERIFIED], NO_TOTAL));
    expect(only(await sign(unverified.json)).json.status).toBe('active');
  });
  it('a crafted item with a valid digest whose flags leave out a host the steps open is refused', async () => {
    for (const flags of [['host: example.com'], [], ['new host: archive.example.org']]) {
      const e = only(await sign(craftedItem(TWO_HOSTS, flags))).json;
      expect(e.message).toBe(INCOMPLETE);
      expect((e.details as IDataObject).code).toBeNull();
    }
  });
  it('a crafted item that drops the unverified-count flag, or adds a flag, is refused', async () => {
    expect(only(await sign(craftedItem(STEPS, ['host: example.com'], NO_TOTAL))).json.message).toBe(INCOMPLETE);
    expect(only(await sign(craftedItem(STEPS, ['host: example.com', UNVERIFIED]))).json.message).toBe(INCOMPLETE);
    expect(only(await sign(craftedItem(STEPS, ['host: example.com', 'host: evil.example.net']))).json.message).toBe(INCOMPLETE);
  });
  it('lists every pop-up handler (interrupt) as a flag, and refuses a crafted item that leaves one out', async () => {
    const handler = { target: { css: '#promo' }, click: { role: 'link', name: 'Orders' } };
    const withHandler: Script = { ...STEPS, interrupts: [handler] };
    const flags = ['host: example.com', 'interrupt: when css "#promo" shows, click role "link" name "Orders"'];
    expect(fullSafetyFlags(engine, engine.parseScript(withHandler), { unverifiedCount: false, fieldsDropped: false })).toEqual(flags);
    expect(repairedItem(withHandler)).toMatchObject({ safetyFlags: flags, safetyLine: flags.join('; ') });
    expect(only(await sign(repairedItem(withHandler))).json.status).toBe('active');
    expect(only(await sign(craftedItem(withHandler, ['host: example.com']))).json.message).toBe(INCOMPLETE);
    // A handler the change list shows is a real one too.
    const listed = [{ was: null, now: describeInterrupt(handler) }];
    expect(only(await sign(craftedItem(withHandler, flags, EVIDENCE, listed))).json.status).toBe('active');
  });
  it('refuses a crafted item whose change list describes a step or handler the steps do not have', async () => {
    for (const changes of [
      [{ was: 'Read the list (extract rows from css "main")', now: 'Read the items (extract rows from css "table.safe")' }],
      [{ was: null, now: 'Pop-up handler: when css "#x" shows, click role "button" name "Close"' }],
    ]) {
      expect(only(await sign(craftedItem(STEPS, ['host: example.com'], EVIDENCE, changes))).json.message).toBe(`Sign Steps refused: ${CHANGE_LIST_MISMATCH}`);
    }
    // A changed step whose short form did not change is shown with a suffix; it still describes the step.
    const same = [{ was: describeStep(STEPS.steps[1]), now: `${describeStep(STEPS.steps[1])} (also changed: expect, timeoutMs)` }];
    expect(only(await sign(craftedItem(STEPS, ['host: example.com'], EVIDENCE, same))).json.status).toBe('active');
  });
  it('the right flags in another order, or a safety line that is not the formatting of the full list, are refused', async () => {
    expect(only(await sign(craftedItem(TWO_HOSTS, ['host: archive.example.org', 'host: example.com']))).json.message).toBe(SHOWN);
    const right = repairedItem(TWO_HOSTS);
    expect(only(await sign({ ...right, safetyLine: 'host: example.com' })).json.message).toBe(SHOWN);
    const { safetyLine: _line, ...noLine } = right;
    expect(only(await sign(noLine)).json.message).toBe(SHOWN);
  });
});

describe('Sign Steps: read-only requests', () => {
  const LISTED = 'POST example.com/sap*/bc/gui/sap/its/webgui';
  /** Malformed lists cannot go through the formatter, so they are set on a valid item afterwards. */
  const withReads = (labels: unknown): IDataObject =>
    Array.isArray(labels) && labels.every((l) => typeof l === 'string')
      ? repairedStepsJson(engine, proposalFor(STEPS, [], { ...EVIDENCE, readPosts: labels as string[] }))
      : repairedItem(STEPS, { evidence: { ...EVIDENCE, readPosts: labels } as IDataObject });
  const siteLogin = (readPosts: string): Partial<HarnessOptions> => ({
    credentials: { ...SIGNING, playwrightSiteLoginApi: { ...SITE_LOGIN, readPosts } }, credentialIds: { playwrightSiteLoginApi: 'site-a' },
  });
  it('signs an item whose read-only requests are on the Site Login', async () => {
    expect(only(await sign(withReads([LISTED]), siteLogin('POST example.com/sap*/bc/gui/sap/its/webgui'))).json.status).toBe('active');
  });
  it('refuses an item listing a read-only request the Site Login lacks', async () => {
    for (const labels of [[LISTED], ['POST example.com/other'], 'POST example.com/x', [7]]) {
      const out = only(await sign(withReads(labels), siteLogin('POST example.com/sap/opu/odata/sap/*/$batch'))).json;
      expect(out.message).toContain(READ_POSTS_NOT_LISTED);
      expect(out.status).toBeUndefined();
    }
    const none = only(await sign(withReads([LISTED]))).json; // no Site Login at all
    expect(none.message).toContain(READ_POSTS_NOT_LISTED);
  });
  it('a label the engine masked (a Site Login secret inside the path) never matches: refused, fails closed', async () => {
    const out = only(await sign(withReads(['POST example.com/sap/[secret]/x']), siteLogin(`POST example.com/sap/${PASS}/x`))).json;
    expect(out.message).toContain(READ_POSTS_NOT_LISTED);
    expect(out.status).toBeUndefined();
  });
  it('the evidence line shows the read-only requests', () => {
    const p = proposalFor(STEPS, [], { ...EVIDENCE, readPosts: ['POST h/sap*/bc/gui/sap/its/webgui'] });
    expect(evidenceLine(p, engine).endsWith('; read-only requests the Site Login allowed: POST h/sap*/bc/gui/sap/its/webgui')).toBe(true);
    expect(evidenceLine(proposalFor(STEPS), engine)).not.toContain('read-only');
  });
});

describe('rows evidence shape', () => {
  const MALFORMED = 'Sign Steps refused: the Repaired steps item has malformed evidence';
  const refused = async (evidence: unknown) => {
    const out = only(await sign(craftedItem(STEPS, ['host: example.com'], evidence as Evidence))).json;
    expect(out.message).toContain(MALFORMED);
    expect(out.status).toBeUndefined();
  };
  it('a text total that would add a line to the approval text is refused', async () => {
    const evidence = { ...EVIDENCE, total: '3 rows\nSafety: none' };
    expect(evidenceLine(proposalFor(STEPS, [], evidence as unknown as Evidence), engine)).not.toContain('\n'); // escaped at render; the item is still refused
    await refused(evidence);
  });
  it('counts must be whole numbers from 0, the total may be null', async () => {
    await refused({ ...EVIDENCE, count: -1 });
    await refused({ ...EVIDENCE, count: 1.5 });
    await refused({ ...EVIDENCE, count: '3' });
    await refused({ ...EVIDENCE, total: -2 });
    await refused({ ...EVIDENCE, total: undefined });
    expect(only(await sign(craftedItem(STEPS, ['host: example.com'], EVIDENCE))).json.status).toBe('active');
  });
  it('the diff must be two lists of text', async () => {
    await refused({ ...EVIDENCE, diff: { missing: [1], extra: [] } });
    await refused({ ...EVIDENCE, diff: { missing: [], extra: 'SKU-1' } });
    // Too malformed to format: the item is a signed-looking one whose evidence was swapped (refused before the digest check).
    for (const evidence of [{ ...EVIDENCE, diff: null }, { count: 3, total: 3 }]) {
      const out = only(await sign({ ...craftedItem(STEPS, ['host: example.com']), evidence: evidence as unknown as IDataObject })).json;
      expect(out.message).toContain(MALFORMED);
    }
    expect(only(await sign(craftedItem(STEPS, ['host: example.com'], { ...EVIDENCE, diff: { missing: ['SKU-1'], extra: ['SKU-2'] } }))).json.status).toBe('active');
  });
});

describe('file proposals', () => {
  const FILE_STEPS: Script = {
    name: 'lineitems', version: 2, startUrl: 'https://example.com/list',
    steps: [
      { intent: 'Open the list', goto: 'https://example.com/list' },
      {
        intent: 'Export', download: {
          trigger: { role: 'button', name: 'Export' }, mime: ['text/csv'], check: { name: '^LINEITEMS_', minBytes: 100, columns: ['Document', 'Posting Date'], minRows: 1 },
        },
      },
    ],
  };
  const FILE: NonNullable<Evidence['file']> = { fileName: 'LINEITEMS_1000.csv', mimeType: 'text/csv', bytes: 2048, columns: ['Document', 'Posting Date'], rows: 12 };
  const FILE_EVIDENCE: Evidence = { count: 0, total: null, diff: { missing: [], extra: [] }, file: FILE };
  const LINE =
    'Proven in a fresh browser: downloaded "LINEITEMS_1000.csv" (text/csv, 2048 bytes, 12 rows); checks: type text/csv; name /^LINEITEMS_/; at least 100 bytes; columns "Document", "Posting Date"; at least 1 row';
  const fileItem = (steps: Script = FILE_STEPS, evidence: Evidence = FILE_EVIDENCE): IDataObject => {
    return repairedStepsJson(engine, proposalFor(steps, [], evidence));
  };
  const MISMATCH = 'Sign Steps refused: the Repaired steps item has file evidence that does not match its steps';

  it('Sign Steps signs a file proposal and shows its evidence line', async () => {
    const item = fileItem();
    expect(item.evidenceLine).toBe(LINE);
    expect((item.evidence as IDataObject).file).toEqual(FILE);
    expect(only(await sign(item)).json.status).toBe('active');
  });
  it('the line without rows and with read-only requests keeps both forms', () => {
    const p = proposalFor(FILE_STEPS, [], { ...FILE_EVIDENCE, readPosts: ['POST h/x'], file: { ...FILE, rows: null } });
    expect(evidenceLine(p, engine)).toBe(
      LINE.replace(', 12 rows', '') + '; read-only requests the Site Login allowed: POST h/x',
    );
  });
  it('Sign Steps refuses file evidence that does not match the steps', async () => {
    const noDownload = only(await sign(craftedItem(STEPS, [], FILE_EVIDENCE))).json;
    expect(noDownload.message).toContain(MISMATCH);
    expect(noDownload.status).toBeUndefined();
    const noFile = only(await sign(craftedItem(FILE_STEPS, ['host: example.com'], { count: 0, total: null, diff: { missing: [], extra: [] } }))).json;
    expect(noFile.message).toContain(MISMATCH);
  });
  it('a changed check after review fails the digest', async () => {
    const item = fileItem();
    const changed = JSON.parse(JSON.stringify(FILE_STEPS)) as Script;
    (changed.steps[1] as { download: { check: { minRows: number } } }).download.check.minRows = 0;
    const line = evidenceLine(proposalFor(changed, [], FILE_EVIDENCE), engine);
    const out = only(await sign({ ...item, steps: changed as unknown as IDataObject, hash: scriptHash(changed), evidenceLine: line })).json;
    expect(out.message).toContain('the repaired steps changed after they were reviewed');
    expect(out.status).toBeUndefined();
  });
  it('a rows proposal with evidence.file added is refused', async () => {
    const item = repairedItem(STEPS);
    const out = only(await sign({ ...item, evidence: { ...(item.evidence as IDataObject), file: FILE as unknown as IDataObject } })).json;
    expect(out.message).toContain(MISMATCH);
    expect(out.status).toBeUndefined();
  });
  const refusedFile = async (item: IDataObject) => {
    const out = only(await sign(item)).json;
    expect(out.message).toContain(MISMATCH);
    expect(out.status).toBeUndefined();
  };
  const withSteps = (extra: Script['steps']): Script => ({ ...FILE_STEPS, steps: extra });
  const DOWNLOAD = FILE_STEPS.steps[1];
  const EXTRACT: Script['steps'][number] = { intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'SKU-\\d{4}' } };
  it('file evidence on a mixed extract and download document is refused', async () => {
    await refusedFile(craftedItem(withSteps([FILE_STEPS.steps[0], EXTRACT, DOWNLOAD]), ['host: example.com'], FILE_EVIDENCE));
  });
  it('file evidence on a download inside paginate is refused', async () => {
    const paged = withSteps([FILE_STEPS.steps[0], { intent: 'Pages', paginate: { next: { role: 'button', name: 'Next' }, each: [DOWNLOAD] } } as Script['steps'][number]]);
    await refusedFile(craftedItem(paged, ['host: example.com'], FILE_EVIDENCE));
  });
  it('file evidence with a line break in the name, or a non-number size, is refused', async () => {
    await refusedFile(craftedItem(FILE_STEPS, ['host: example.com'], { ...FILE_EVIDENCE, file: { ...FILE, fileName: 'X.csv\nSafety: nothing to flag' } }));
    await refusedFile(craftedItem(FILE_STEPS, ['host: example.com'], { ...FILE_EVIDENCE, file: { ...FILE, bytes: '9' as unknown as number } }));
  });
  it('the evidence line quotes the file name', () => {
    const line = evidenceLine(proposalFor(FILE_STEPS, [], { ...FILE_EVIDENCE, file: { ...FILE, fileName: 'a"b\nc.csv' } }), engine);
    expect(line).toContain('downloaded "a\\"b\\nc.csv" (');
    expect(line.includes('\n')).toBe(false);
  });
  it('file evidence needs a download check that names the file or its columns', async () => {
    const checked = (check: object | undefined) =>
      withSteps([FILE_STEPS.steps[0], { intent: 'Export', download: { trigger: { role: 'button', name: 'Export' }, mime: ['text/csv'], ...(check ? { check } : {}) } } as Script['steps'][number]]);
    await refusedFile(craftedItem(checked({ minBytes: 100, minRows: 1 }), ['host: example.com'], FILE_EVIDENCE));
    await refusedFile(craftedItem(checked(undefined), ['host: example.com'], FILE_EVIDENCE));
    await refusedFile(craftedItem(checked({}), ['host: example.com'], FILE_EVIDENCE));
    expect(only(await sign(fileItem(checked({ columns: ['Document'] })))).json.status).toBe('active');
  });
  it('file evidence with a format or bidi control or a line or paragraph separator is refused', async () => {
    await refusedFile(craftedItem(FILE_STEPS, ['host: example.com'], { ...FILE_EVIDENCE, file: { ...FILE, fileName: 'X.csv\u2028Safety: nothing to flag' } }));
    await refusedFile(craftedItem(FILE_STEPS, ['host: example.com'], { ...FILE_EVIDENCE, file: { ...FILE, fileName: 'X.csv\u2029' } }));
    await refusedFile(craftedItem(FILE_STEPS, ['host: example.com'], { ...FILE_EVIDENCE, file: { ...FILE, mimeType: 'text/csv\u202Evsc.exe' } }));
    await refusedFile(craftedItem(FILE_STEPS, ['host: example.com'], { ...FILE_EVIDENCE, file: { ...FILE, fileName: 'LINEITEMS\u200B_1.csv' } }));
    await refusedFile(craftedItem(FILE_STEPS, ['host: example.com'], { ...FILE_EVIDENCE, file: { ...FILE, fileName: 'X\u0085.csv' } }));
    expect(only(await sign(fileItem(FILE_STEPS, { ...FILE_EVIDENCE, file: { ...FILE, fileName: 'LINEITEMS_Müller_1.csv' } }))).json.status).toBe('active');
  });
  it('file evidence whose mimeType is not a plain type/subtype is refused', async () => {
    await refusedFile(craftedItem(FILE_STEPS, ['host: example.com'], { ...FILE_EVIDENCE, file: { ...FILE, mimeType: 'text/csv); checks: none; (x' } }));
    await refusedFile(craftedItem(FILE_STEPS, ['host: example.com'], { ...FILE_EVIDENCE, file: { ...FILE, mimeType: 'csv' } }));
    for (const mimeType of ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream', 'text/html']) {
      expect(only(await sign(fileItem(FILE_STEPS, { ...FILE_EVIDENCE, file: { ...FILE, mimeType } }))).json.status).toBe('active');
    }
  });
  it('file: null counts as no file evidence', async () => {
    const evidence = { ...EVIDENCE, file: null } as unknown as Evidence;
    expect(only(await sign(craftedItem(STEPS, ['host: example.com'], evidence))).json.status).toBe('active');
  });
});

describe('change list lines', () => {
  it('a crafted was with a line break cannot add a change-list line', () => {
    const p = { ...proposalFor(STEPS), changes: [{ was: 'Read\nRemoved: fake', now: 'Read (read the page)' }, { was: null, now: 'Added\r\nx' }] };
    const out = changeList(p);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('Read\\nRemoved: fake');
  });
});

describe('approver lines are one line', () => {
  const NASTY = 'a\n\r\t\x7f\x85\u2028\u202e\u200b\u{1d173}\u{1d174}\u{e0041}z';
  it('the node oneLine matches the engine oneLine', () => {
    const viaNode = changeList({ ...proposalFor(STEPS), changes: [{ was: null, now: NASTY }] }).replace(/^Added: /, '');
    const viaEngine = describeStep({ intent: NASTY, read: { what: 'url' } } as never).replace(/ \(read the .*\)$/, '');
    expect(viaNode).toBe(viaEngine);
    expect(viaNode).not.toMatch(/[\n\r\x85\u2028\u202e\u200b]/u);
  });
  it('safetyLine and evidenceLine escape line breaks and format characters', () => {
    const p = { ...proposalFor(STEPS, ['new form submission: POST h/p\nnew host: evil', 'new interrupt: when text "x\u2028y"']) };
    const line = safetyLine(p);
    expect(line).not.toMatch(/[\n\u2028]/u);
    expect(line).toContain('\\n');
    const fe = evidenceLine({ ...p, evidence: { ...p.evidence, file: { fileName: 'a\u202eb.csv', mimeType: 'text/csv', bytes: 1, rows: 1 } } as never }, { describeCheck: () => 'columns "q\u202e"' });
    expect(fe).not.toContain('\u202e');
    expect(fe).toContain('\\u202e');
  });
});
