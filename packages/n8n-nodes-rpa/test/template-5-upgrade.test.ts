// Template 5 after the upgrade from 0.1.0 (audit 2026-11-16, T5 and F7: behaviour 48, proven live in upgrade-v2 #7 and
// until now pinned only in parts): the form the setup command brings up to date (setup.test.ts "y at a terminal…") and
// template 5's own check, joined. A bot 0.1.0 approved, signed by 0.1.0's code with 0.1.0's key for its Site Login, opened
// on that form to sign it again: it fits, no question page, and the review page says unchanged with no warning.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signScript, verifyScript } from 'n8n-rpa-engine';
import { type IDataObject, type INodeExecutionData } from 'n8n-workflow';
import { executeSignSteps } from '../nodes/Playwright/operations/signSteps.js';
import { siteLoginData } from './feed-fixtures.js';
import { type Cred, type Wf, API_KEY, n8n, runAtTerminal } from './fixtures/fake-n8n-api.js';
import { harness } from './harness.js';
import { template5 as t, COMPARED, NOT_ADOPTABLE, SITE, byName, changePath, compared, evaluate, importEngine, jsonFormFields, nodesRan, reviewFields, reviewHead } from './template-harness.js';

/** 0.1.0's template as the v0.1.0 tag has it (setup.test.ts reads the same file). */
const SHIPPED_010 = JSON.parse(readFileSync(new URL('./fixtures/template-0.1.0-5-import-a-bot.json', import.meta.url), 'utf8'));
// The credentials 0.1.0's guides had people make (n8n names a credential made by hand "<type> account"); made-up values.
const KEY_010: Cred = { id: 'c-010', name: 'RPA Step Signing account', type: 'playwrightScriptSigningApi', data: { secretKey: 'c3'.repeat(32) } };
const BROWSER_010: Cred = { id: 'c-b010', name: 'RPA Browser account', type: 'playwrightBrowserApi', data: { mode: 'playwright', wsUrl: 'ws://browser:3000/', token: 'b'.repeat(64) } };
const SITE_010: Cred = { id: 'c-s010', name: 'RPA Site Login account', type: 'playwrightSiteLoginApi', data: { username: 'u', password: 'made-up-site-pw' } };
const LOGIN_010: Cred = { id: 'c-l010', name: 'Import form login', type: 'httpBasicAuth', data: { user: 'importer', password: 'made-up-form-pw' } };
const CREDS = [KEY_010, BROWSER_010, SITE_010, LOGIN_010];
const ref = (c: Cred) => ({ id: c.id, name: c.name });

/** The form 0.1.0 made, with what its "Set once" note had people pick (setup.test.ts's form010, without the chat model). */
function form010(): Wf {
  const shipped = structuredClone(SHIPPED_010) as { nodes: IDataObject[]; connections: IDataObject };
  const nodes = shipped.nodes.map((n: IDataObject) => {
    if (/\.(formTrigger|form)$/.test(String(n.type))) n.webhookId = `0a1b2c3d-0000-4000-8000-${String(n.id).slice(-12)}`;
    if (n.name === 'Import a bot') n.credentials = { httpBasicAuth: ref(LOGIN_010) };
    if (n.name === 'Import steps') {
      n.credentials = { playwrightBrowserApi: ref(BROWSER_010), playwrightSiteLoginApi: ref(SITE_010) };
      n.parameters = { ...(n.parameters as IDataObject), options: { allowPrivateNetwork: true } };
    }
    if (n.name === 'Chat model') n.disabled = true;
    if (n.name === 'Approve steps') n.parameters = { ...(n.parameters as IDataObject), workflowId: { __rl: true, mode: 'list', value: 'w-t3-010', cachedResultName: 'RPA: 3 Approve steps' } };
    return n;
  });
  return { id: 'w-010', name: 'RPA: 5 Import a bot', active: true, versionId: 'v-010', nodes, connections: shipped.connections, settings: { executionOrder: 'v1' } } as Wf;
}

/**
 * A bot as 0.1.0 approved it: its row in playwright_steps (0.1.0's columns), signed by 0.1.0's own signScript
 * (packages/engine/src/sign.ts at v0.1.0, run once to make these values) with KEY_010 for SITE_010, approved by the
 * approver 0.1.0's setup set. The values are literal so that a change to today's signing that 0.1.0's rows would not
 * survive fails here.
 */
const DOC_010 = { startUrl: 'https://erp.example.com/list', name: 'feed', version: 3, steps: [{ intent: 'Open the list', goto: 'https://erp.example.com/list' }, { intent: 'Click Export', click: { role: 'button', name: 'Export' } }] };
const ROW_010: IDataObject = {
  id: 7, name: 'feed', version: 3, steps: JSON.stringify(DOC_010),
  hash: '9c5225ac1dfa6db7b4ec0f0fc5cc43b28eb2f4598ff0411e3be4f0d3347f382a',
  signature: 'bc4b0146bfbdaeac02158c444055aac11c05e515ea8bcdd603963ab303ec0ee1',
  approvedBy: 'ops@example.com', approvedAt: '2026-10-30T09:00:00.000Z', status: 'active', expiresAt: '',
};

describe('template 5 after the upgrade from 0.1.0', () => {
  it('a 0.1.0 bot signed with the 0.1.0 key fits a 0.1.0 form updated by the setup command', async () => {
    // The 0.1.0 row's signature is 0.1.0's: today's code makes and accepts the same bytes.
    expect(signScript(DOC_010, String(KEY_010.data.secretKey), { approvedBy: 'ops@example.com', siteLoginId: SITE_010.id })).toEqual({ hash: ROW_010.hash, signature: ROW_010.signature });
    expect(verifyScript(DOC_010, String(KEY_010.data.secretKey), { approvedBy: 'ops@example.com', siteLoginId: SITE_010.id, signature: String(ROW_010.signature) })).toBe(true);

    // The guide's setup command at a terminal on the n8n 0.1.0 set up, answered y to the update (setup.test.ts S1).
    const fake = await n8n({ credentials: CREDS, workflows: [form010()] });
    const yes = await runAtTerminal(['setup', '--url', fake.url, '--approver', 'ops@example.com'], { N8N_API_KEY: API_KEY },
      [[/Connect a Windows machine now/, 'n'], [/Update this form to this version\? \(y\/N\) /, 'y']]);
    expect(yes.code, yes.out).toBe(0);
    expect(fake.state.credentials.map((c) => c.id), 'no second key').toEqual(CREDS.map((c) => c.id));
    const [form] = fake.state.workflows;
    expect(form.id).toBe('w-010');
    const node = (name: string) => form.nodes.find((x: { name: string }) => x.name === name) as { parameters: IDataObject; credentials?: Record<string, { id: string; name: string }> };
    // What the updated form signs with, read from the form itself, and the credentials those ids name in n8n.
    const signWith = node('Sign steps').credentials ?? {};
    expect(signWith).toEqual({ playwrightScriptSigningApi: ref(KEY_010), playwrightSiteLoginApi: ref(SITE_010) });
    const key = String(fake.state.credentials.find((c) => c.id === signWith.playwrightScriptSigningApi.id)!.data.secretKey);
    const siteLogin = signWith.playwrightSiteLoginApi;
    // Its expressions on this path are the template's (the harness evaluates the template's): only settings differ.
    for (const name of ['The bot to change', 'The approved version', COMPARED, 'Compared with the running version', 'Review and approve', 'Fits this form?', 'Change page next?']) {
      expect(node(name).parameters, name).toEqual(byName(t, name).parameters);
    }

    /** Sign steps' check (Check Only) as the updated form runs it: its own parameters, its key, its Site Login. */
    const check = async (ran_: Record<string, INodeExecutionData[][]>) => {
      const ran = { ...ran_, 'Compared with the running version': [[{ json: evaluate(String(node('Compared with the running version').parameters.jsonOutput), { $: nodesRan(ran_) }) as IDataObject }]] };
      const $ = nodesRan(ran);
      const item = evaluate(String(node('The approved version').parameters.jsonOutput), { $ }) as IDataObject;
      const sign = node('Sign steps').parameters;
      const params = Object.fromEntries(Object.entries(sign).flatMap(([k, v]) => {
        if (typeof v !== 'string' || !v.startsWith('=')) return [[k, v]];
        try {
          return [[k, evaluate(v, { $, $itemIndex: 0 })]];
        } catch {
          return [];
        }
      }));
      expect(params.checkOnly).toBe(true);
      const out = await executeSignSteps(harness({
        params, rawParameters: sign, items: [{ json: item }], continueOnFail: true,
        credentials: { playwrightScriptSigningApi: { secretKey: key }, playwrightSiteLoginApi: siteLoginData(SITE) },
        credentialIds: { playwrightSiteLoginApi: siteLogin.id }, credentialNames: { playwrightSiteLoginApi: siteLogin.name },
      }), importEngine(() => NOT_ADOPTABLE));
      return { ...ran, 'The approved version': [[{ json: item }]], 'Sign steps': [out[0], []] } as Record<string, INodeExecutionData[][]>;
    };
    const cond = (name: string) => (node(name).parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;

    // The bot's name on the first page, Bot file empty: Sign steps checks the version that runs now. It fits: on to the
    // change page, never the question page.
    const { ran } = changePath('feed', [ROW_010]);
    // (Import steps has not run then: the check's own input only, as template-5-change's IB-4 test takes it.)
    const { 'Import steps': _i, 'Compared with the running version': _r, ...first } = await check({ ...ran, 'Import steps': [[], []] });
    expect(first['Sign steps'][0][0].json).toMatchObject({ checkOnly: true, siteLogin: 'RPA Site Login account', approvedVersion: { version: 3, signatureFits: true } });
    expect(evaluate(cond('Change page next?'), { $: nodesRan(first) })).toBe(true);
    expect(evaluate(cond('Fits this form?'), { $json: first['Sign steps'][0][0].json })).toBe(true);

    // Sign the approved steps again, unchanged (the box left empty): the review page says unchanged, names the Site
    // Login, and has no warning.
    const line = compared(ran, '');
    expect(line.compared).toBe('feed: unchanged from the approved version 3.');
    const next = { json: { name: 'feed', version: 4, baseVersion: 3, steps: { ...DOC_010, version: 4 }, reviewSteps: [], safetyFlags: [] } };
    const reviewed = await check({ ...ran, 'Change or sign again': [[{ json: { changedSteps: '' } }]], [COMPARED]: [[{ json: line as unknown as IDataObject }]], 'Import steps': [[{ json: {} }], [next]] });
    expect(reviewed['Sign steps'][0][0].json).toMatchObject({ approvedVersion: { version: 3, signatureFits: true } });
    const head = reviewHead({ $: nodesRan(reviewed) });
    expect(head).toBe('<p><b>feed: unchanged from the approved version 3.</b></p><p>These steps do not sign in, and are signed for the Site Login named "<b>RPA Site Login account</b>" all the same. The workflow that runs the bot must use this Site Login.</p>');
    const fields = reviewFields({ $: nodesRan(reviewed) });
    expect(fields.map((f) => f.fieldName ?? f.fieldType)).toEqual(['html', 'decision_0']);
    expect(JSON.stringify(jsonFormFields(String(byName(t, 'Review and approve').parameters.jsonOutput), { $: nodesRan(reviewed) }))).not.toMatch(/does not fit|stored version|⚠/);

    // The same check refuses what does not fit: the 0.1.0 row with its steps edited in the table, or a bot 0.1.0 signed
    // for no Site Login, goes to the question page. (So the fit above is the check's answer, not a default.)
    const misfits: IDataObject[] = [
      { ...ROW_010, steps: String(ROW_010.steps).replace('Export', 'Delete') },
      { ...ROW_010, signature: signScript(DOC_010, key, { approvedBy: 'ops@example.com' }).signature },
    ];
    for (const r of misfits) {
      const { 'Import steps': _ii, 'Compared with the running version': _rr, ...c } = await check({ ...changePath('feed', [r]).ran, 'Import steps': [[], []] });
      expect(evaluate(cond('Fits this form?'), { $json: c['Sign steps'][0][0].json })).toBe(false);
    }
  });
});
