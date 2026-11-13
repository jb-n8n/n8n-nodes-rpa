// Runs On: the node shows only the credential slots a run uses, and never loses a credential a saved node holds.
// n8n drops a credential whose slot is hidden (n8n-workflow's getActiveCredentialTypes: the editor removes it on save,
// the run's permission check skips it) and refuses to read it (n8n-core reads a credential only when the first entry of
// its type is displayed). Every check here runs n8n's own functions on the node's real description.
import { describe, expect, it } from 'vitest';
import {
  NodeHelpers, Workflow, type ICredentialDataDecryptedObject, type IDataObject, type INode, type INodeCredentialDescription, type INodeParameters, type INodeTypeDescription, type INodeTypes,
} from 'n8n-workflow';
import { CREDENTIALS, HIDDEN_BY_RUNS_ON, type RunsOn } from '../nodes/Playwright/config.js';
import { RUNS_ON_PROPERTY } from '../nodes/Playwright/description/runSteps.js';
import { buildWorkflow, type WorkflowJson } from '../nodes/Playwright/import/workflow.js';
import { RPA_NODE_TYPE } from '../nodes/Playwright/node-type.js';
import { executeQuickOp, type QuickOp } from '../nodes/Playwright/operations/quick.js';
import { DISPATCH, Playwright } from '../nodes/Playwright/Playwright.node.js';
import { fakeEngine } from './fake-engine.js';
import { harness } from './harness.js';
import { okResult, quickParams } from './quick-fixtures.js';

const playwright = new Playwright();
const d = playwright.description;
const OPERATIONS = Object.keys(DISPATCH);
const QUICK: QuickOp[] = ['screenshot', 'getPage', 'pdf', 'extract', 'fillForm', 'download'];
const TYPES = Object.values(CREDENTIALS);
const CHOICES: RunsOn[] = ['browserAndDesktop', 'browser', 'desktop'];

/** The credentials as they were before Runs On (feat/simplify 306f9ee), written out: what a saved node was made with. */
const BEFORE_CREDENTIALS: INodeCredentialDescription[] = [
  { name: 'playwrightBrowserApi', displayOptions: { hide: { operation: ['signSteps'] } } },
  { name: 'playwrightSiteLoginApi', displayOptions: { show: { operation: ['runSteps', 'signSteps', 'importSteps'] } } },
  { name: 'playwrightScriptSigningApi', displayOptions: { show: { operation: ['runSteps', 'signSteps'] } } },
  { name: 'playwrightRedisApi', displayOptions: { show: { operation: ['runSteps', 'importSteps'] } } },
  { name: 'rpaDesktopRunnerApi', displayOptions: { show: { operation: ['runSteps'] } } },
  { name: 'rpaSecretVariablesApi', displayOptions: { show: { operation: ['runSteps'] } } },
  { name: 'playwrightScriptSigningApi', displayOptions: { show: { operation: ['importSteps'] } } },
  { name: 'rpaDesktopRunnerApi', displayOptions: { show: { operation: ['importSteps'] } } },
];
const BEFORE: INodeTypeDescription = { ...d, credentials: BEFORE_CREDENTIALS, properties: d.properties.filter((p) => p.name !== 'runsOn') };

const nodeTypes = (description: INodeTypeDescription): INodeTypes => {
  const type = { description };
  return { getByName: () => type, getByNameAndVersion: () => type, getKnownTypes: () => ({}) } as unknown as INodeTypes;
};
const savedNode = (parameters: INodeParameters, types: string[] = []): INode => ({
  id: 'n1', name: 'RPA', type: RPA_NODE_TYPE, typeVersion: 1, position: [0, 0], parameters,
  credentials: Object.fromEntries(types.map((t) => [t, { id: `id-${t}`, name: t }])),
});
/** n8n-workflow's rule: the credential types n8n keeps on this node (the others are dropped on save and skipped by the run's checks). */
const kept = (node: INode, description = d): string[] => {
  const active = NodeHelpers.getActiveCredentialTypes(node, description);
  if (!active) throw new Error('n8n could not work out the active credentials');
  return Object.keys(node.credentials ?? {}).filter((t) => active.has(t));
};
/** The node's parameters as a run sees them: n8n's Workflow constructor fills the defaults and strips what is not shown. */
const runParameters = (node: INode, description = d): INodeParameters =>
  new Workflow({ nodes: [structuredClone(node)], connections: {}, nodeTypes: nodeTypes(description), active: false }).getNode(node.name)!.parameters;
/** n8n-core's rule for getCredentials: the first entry of the type must be displayed for the run's parameters. */
const readable = (node: INode, type: string, description = d): boolean =>
  NodeHelpers.displayParameter(runParameters(node, description), description.credentials!.find((c) => c.name === type)!, node, description, runParameters(node, description));
/** The slots the editor shows, by display name. */
const slots = (parameters: INodeParameters): string[] => {
  const node = savedNode(parameters);
  const p = runParameters(node);
  return (d.credentials ?? []).filter((c) => NodeHelpers.displayParameter(p, c, node, d)).map((c) => String(c.displayName));
};
/** Every mix of the six credential types. */
const mixes = (types: string[]): string[][] => types.reduce<string[][]>((all, t) => [...all, ...all.map((m) => [...m, t])], [[]]);

describe('Runs On: the field', () => {
  it('is a typed choice on Run Steps and Import Steps, default Browser and desktop apps, that only chooses the credentials asked for', () => {
    expect(d.properties.find((p) => p.name === 'runsOn')).toBe(RUNS_ON_PROPERTY);
    expect(RUNS_ON_PROPERTY).toEqual({
      displayName: 'Runs On', name: 'runsOn', type: 'options', noDataExpression: true, default: 'browserAndDesktop',
      options: [{ name: 'Browser and desktop apps', value: 'browserAndDesktop' }, { name: 'A browser', value: 'browser' }, { name: 'A Windows desktop app', value: 'desktop' }],
      description: 'This only chooses which credentials the node asks for, and the steps themselves decide where they run',
      hint: 'Choosing A browser or A Windows desktop app removes a credential whose slot it hides',
      displayOptions: { show: { operation: ['runSteps', 'importSteps'] } },
    });
  });

  it('shows these slots for each operation and choice', () => {
    const passOn = (n: string) => `${n} (only passed on to the workflow file)`;
    const table = Object.fromEntries(OPERATIONS.map((operation) => [operation, Object.fromEntries(CHOICES.map((runsOn) => [runsOn, slots({ operation, runsOn })]))]));
    expect(table.runSteps).toEqual({
      browserAndDesktop: ['RPA Browser', 'RPA Site Login', 'RPA Step Signing', 'RPA Redis', 'RPA Desktop Runner', 'RPA Secret Variables'],
      browser: ['RPA Browser', 'RPA Site Login', 'RPA Step Signing', 'RPA Redis', 'RPA Secret Variables'],
      desktop: ['RPA Step Signing', 'RPA Desktop Runner', 'RPA Secret Variables'],
    });
    expect(table.importSteps).toEqual({
      browserAndDesktop: ['RPA Browser', 'RPA Site Login', 'RPA Redis', passOn('RPA Step Signing'), passOn('RPA Desktop Runner')],
      browser: ['RPA Browser', 'RPA Site Login', 'RPA Redis', passOn('RPA Step Signing')],
      desktop: [passOn('RPA Step Signing'), passOn('RPA Desktop Runner')],
    });
    // Sign Steps and the quick operations have no Runs On: a value left on them changes nothing.
    for (const runsOn of CHOICES) expect(table.signSteps[runsOn]).toEqual(['RPA Site Login', 'RPA Step Signing']);
    for (const op of QUICK) for (const runsOn of CHOICES) expect(table[op][runsOn], op).toEqual(['RPA Browser']);
  });

  it('HIDDEN_BY_RUNS_ON, which the operations read, says what the credentials\' displayOptions say', () => {
    for (const operation of ['runSteps', 'importSteps']) {
      for (const runsOn of ['browser', 'desktop'] as const) {
        const all = new Set(kept(savedNode({ operation }, TYPES)));
        const narrow = new Set(kept(savedNode({ operation, runsOn }, TYPES)));
        expect([...all].filter((t) => !narrow.has(t)), `${operation} ${runsOn}`).toEqual(HIDDEN_BY_RUNS_ON[runsOn].filter((t) => all.has(t)));
      }
    }
  });
});

describe('a node saved before Runs On loses nothing', () => {
  it('for every operation and every mix of credentials it could hold, n8n keeps and reads exactly what it did before', () => {
    let cases = 0;
    for (const operation of OPERATIONS) {
      for (const mix of mixes(TYPES)) {
        const node = savedNode({ operation }, mix);
        // Kept: the same credentials as under the old description, so every one it could hold before it still holds.
        expect(kept(node), `${operation} ${mix.join(',')}`).toEqual(kept(node, BEFORE));
        cases++;
      }
      // Read at run time: the same answer for every type as before.
      for (const type of TYPES) expect(readable(savedNode({ operation }, TYPES), type), `${operation} reads ${type}`).toBe(readable(savedNode({ operation }, TYPES), type, BEFORE));
    }
    expect(cases).toBe(OPERATIONS.length * 64);
    // On Run Steps, a node saved before keeps all six, and n8n hands all six to the run.
    expect(kept(savedNode({ operation: 'runSteps' }, TYPES))).toEqual(TYPES);
    for (const type of TYPES) expect(readable(savedNode({ operation: 'runSteps' }, TYPES), type), type).toBe(true);
  });

  it('with Runs On set by an expression (typed only, but a hand-written file may hold one), every slot shows', () => {
    for (const operation of ['runSteps', 'importSteps']) {
      const node = savedNode({ operation, runsOn: '={{ "desktop" }}' }, TYPES);
      expect(kept(node), operation).toEqual(kept(savedNode({ operation }, TYPES)));
    }
  });

  it('the quick operations never show the desktop runner or secret variables slots, and never read them: they read only RPA Browser', async () => {
    for (const op of QUICK) {
      for (const runsOn of [undefined, ...CHOICES]) {
        const node = savedNode({ operation: op, ...(runsOn ? { runsOn } : {}) }, TYPES);
        expect(kept(node, BEFORE), op).toEqual([CREDENTIALS.browser]);
        expect(TYPES.filter((t) => readable(node, t)), op).toEqual([CREDENTIALS.browser]);
      }
    }
    // Every quick operation, with all six credentials attached, reads RPA Browser and nothing else.
    const fields: Record<QuickOp, IDataObject> = {
      screenshot: {}, getPage: {}, pdf: {},
      extract: { shape: 'table', table: { locator: { findBy: 'css', css: 'table.results' } } },
      fillForm: { formFields: { field: [{ findBy: 'label', label: 'Name', value: 'Ada' }] }, submitButton: { locator: { findBy: 'css', css: 'button' } } },
      download: { downloadTrigger: { locator: { findBy: 'css', css: 'a.report' } } },
    };
    const all: Record<string, ICredentialDataDecryptedObject> = {
      [CREDENTIALS.browser]: { mode: 'local', headless: true }, [CREDENTIALS.siteLogin]: {}, [CREDENTIALS.signing]: {}, [CREDENTIALS.redis]: {},
      [CREDENTIALS.desktopRunner]: {}, [CREDENTIALS.secretVariables]: {},
    };
    for (const op of QUICK) {
      const ctx = harness({ params: quickParams(op, fields[op]), credentials: all, continueOnFail: true });
      const read: string[] = [];
      const getCredentials = ctx.getCredentials.bind(ctx);
      ctx.getCredentials = async (type, i) => {
        read.push(type);
        return await getCredentials(type, i);
      };
      await executeQuickOp(ctx, fakeEngine(() => okResult()), op);
      expect(read, op).toEqual([CREDENTIALS.browser]);
    }
  });
});

describe('the workflows the import generates', () => {
  const desktopDraft = {
    name: 'g-2', writeCandidates: [], variables: [], secretVariables: [],
    script: { surface: 'desktop' as const, name: 'g-2', version: 1, app: { exe: 'App.exe' }, steps: [{ intent: 'Click', click: { uia: { path: [{ name: 'x' }] } } }] },
  };
  const browserDraft = { name: 'g-1', script: { name: 'g-1', version: 1, startUrl: 'https://portal.example.com/', steps: [{ intent: 'Open', goto: 'https://portal.example.com/' }] } };
  const ref = (t: string) => ({ id: `id-${t}`, name: t });
  const w: WorkflowJson = buildWorkflow(
    { name: 'g', nodes: [{ kind: 'browser', sequence: 1, displayName: 'Web', draft: 'g-1' }, { kind: 'desktop', sequence: 2, displayName: 'Desk', draft: 'g-2' }] },
    [browserDraft as never],
    { name: 'g', desktopDrafts: [desktopDraft as never], credentials: { browser: ref('b'), siteLogin: ref('s'), signing: ref('k'), desktopRunner: ref('r') } },
  );
  const asNode = (name: string, add: string[] = []): INode => {
    const n = w.nodes.find((x) => x.name === name)!;
    return { ...(structuredClone(n) as unknown as INode), credentials: { ...(n.credentials as INode['credentials']), ...Object.fromEntries(add.map((t) => [t, ref(t)])) } };
  };

  it('set Runs On on each Run steps: A browser on browser steps, A Windows desktop app on desktop steps', () => {
    expect(w.nodes.find((n) => n.name === 'Web')!.parameters).toMatchObject({ operation: 'runSteps', runsOn: 'browser' });
    expect(w.nodes.find((n) => n.name === 'Desk')!.parameters).toMatchObject({ operation: 'runSteps', runsOn: 'desktop' });
    expect(slots(w.nodes.find((n) => n.name === 'Desk')!.parameters as INodeParameters)).toEqual(['RPA Step Signing', 'RPA Desktop Runner', 'RPA Secret Variables']);
  });

  it('a generated desktop node keeps its three, a generated browser node its five', () => {
    // As generated, plus the credentials a person adds there (Secret Variables; Redis on a browser node).
    const desk = asNode('Desk', [CREDENTIALS.secretVariables]);
    expect(Object.keys(desk.credentials!).sort()).toEqual([CREDENTIALS.desktopRunner, CREDENTIALS.signing, CREDENTIALS.secretVariables].sort());
    expect(kept(desk).sort()).toEqual(Object.keys(desk.credentials!).sort());
    for (const t of Object.keys(desk.credentials!)) expect(readable(desk, t), t).toBe(true);
    const web = asNode('Web', [CREDENTIALS.redis, CREDENTIALS.secretVariables]);
    expect(Object.keys(web.credentials!).sort()).toEqual([CREDENTIALS.browser, CREDENTIALS.siteLogin, CREDENTIALS.signing, CREDENTIALS.redis, CREDENTIALS.secretVariables].sort());
    expect(kept(web).sort()).toEqual(Object.keys(web.credentials!).sort());
    for (const t of Object.keys(web.credentials!)) expect(readable(web, t), t).toBe(true);
  });
});
