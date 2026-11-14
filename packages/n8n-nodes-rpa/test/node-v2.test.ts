// Version 2 of the RPA node shows less: Runs On starts at A browser, RPA Redis shows only with Share Login Breaker
// Across Workers on, and Signature and Approved By are on the node's Settings tab. A stored version 1 node shows, keeps
// and runs exactly what it did. Every check runs n8n's own functions (n8n-workflow) on the node's real description and,
// for version 1, on the description as it was before version 2 (fixtures/node-v1-description.json, from f5aae44).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NodeHelpers, type IDataObject, type INode, type INodeParameters, type INodeProperties, type INodeTypeDescription,
} from 'n8n-workflow';
import { CREDENTIALS, NODE_VERSION, NODE_VERSIONS, runsOnDefault, SHARE_ACROSS_WORKERS } from '../nodes/Playwright/config.js';
import { SHARE_ACROSS_WORKERS_PROPERTY } from '../nodes/Playwright/description/runSteps.js';
import { QUEUE_NEEDS_REDIS, QUEUE_NEEDS_REDIS_V2, queueNeedsRedis, redisAttached } from '../nodes/Playwright/guard-store.js';
import { RPA_NODE_TYPE } from '../nodes/Playwright/node-type.js';
import { runsOn, slotNote } from '../nodes/Playwright/operations/common.js';
import { executeImportSteps } from '../nodes/Playwright/operations/importSteps.js';
import { DISPATCH, Playwright } from '../nodes/Playwright/Playwright.node.js';
import { fakeEngine } from './fake-engine.js';
import { nodeContext, siteLoginData } from './feed-fixtures.js';
import { harness } from './harness.js';
import { runParameters } from './n8n-harness.js';

const d = new Playwright().description;
const base = JSON.parse(readFileSync(new URL('fixtures/node-v1-description.json', import.meta.url), 'utf8')) as Pick<INodeTypeDescription, 'version' | 'credentials' | 'properties'>;
/** The node as a version 1 workflow was made with it (feat/simplify f5aae44, the commit before version 2). */
const BEFORE: INodeTypeDescription = { ...d, version: 1, credentials: base.credentials, properties: base.properties };
const OPERATIONS = Object.keys(DISPATCH);
const TYPES = Object.values(CREDENTIALS);
/** Fields only version 2 has. */
const V2_ONLY = [SHARE_ACROSS_WORKERS];
const RUNS_ON_VALUES: (string | undefined)[] = [undefined, 'browserAndDesktop', 'browser', 'desktop', '={{ "desktop" }}'];
/** Values of other fields that show or hide something. */
const EXTRAS: INodeParameters[] = [{}, { aiRepair: true }, { aiRepair: false }, { requireSignedSteps: false }, { source: 'uipath' }, { source: 'recording' }, { inputFrom: 'text' }];

const stored = (parameters: INodeParameters, typeVersion: number, types: string[] = []): INode => ({
  id: 'n1', name: 'RPA', type: RPA_NODE_TYPE, typeVersion, position: [0, 0], parameters,
  credentials: Object.fromEntries(types.map((t) => [t, { id: `id-${t}`, name: t }])),
});
/** The credential types n8n keeps on the node when it is saved (getActiveCredentialTypes). */
const kept = (node: INode, description = d): string[] => {
  const active = NodeHelpers.getActiveCredentialTypes(node, description);
  if (!active) throw new Error('n8n could not work out the active credentials');
  return Object.keys(node.credentials ?? {}).filter((t) => active.has(t));
};
/** Whether n8n hands the run this credential (n8n-core reads it through the first entry of its type). */
const readable = (node: INode, type: string, description = d): boolean => {
  const p = runParameters(node, description);
  return NodeHelpers.displayParameter(p, description.credentials!.find((c) => c.name === type)!, node, description, p);
};
/** The credential slots the editor shows, by display name. */
const slots = (parameters: INodeParameters, typeVersion: number, description = d): string[] => {
  const node = stored(parameters, typeVersion);
  const p = runParameters(node, description);
  return (description.credentials ?? []).filter((c) => NodeHelpers.displayParameter(p, c, node, description)).map((c) => String(c.displayName));
};
/** The fields the editor shows, on the Parameters tab and on the Settings tab (isNodeSetting), as [name, type, default]. */
const fields = (parameters: INodeParameters, typeVersion: number, description = d) => {
  const node = stored(parameters, typeVersion);
  const p = runParameters(node, description);
  const shown = description.properties.filter((f) => f.type !== 'hidden' && NodeHelpers.displayParameter(p, f, node, description, p));
  const row = (f: INodeProperties) => [f.name, f.type, JSON.stringify(f.default)];
  return { params: shown.filter((f) => !f.isNodeSetting).map(row), settings: shown.filter((f) => f.isNodeSetting).map(row) };
};
const names = (rows: unknown[][]) => rows.map((r) => r[0] as string);
const mixes = (types: string[]): string[][] => types.reduce<string[][]>((all, t) => [...all, ...all.map((m) => [...m, t])], [[]]);
const scenarios = (): INodeParameters[] =>
  OPERATIONS.flatMap((operation) => RUNS_ON_VALUES.flatMap((on) => EXTRAS.map((extra) => ({ operation, ...(on === undefined ? {} : { runsOn: on }), ...extra }))));
const BASE_NAMES = new Set(base.properties.map((p) => p.name));
const without = (p: INodeParameters, key: string): INodeParameters => Object.fromEntries(Object.entries(p).filter(([k]) => k !== key));

describe('the node has versions 1 and 2', () => {
  it('a new node gets version 2; the import\'s workflow file and the templates use it', () => {
    expect(d.version).toEqual(NODE_VERSIONS);
    expect(NODE_VERSIONS).toEqual([1, 2]);
    expect(NODE_VERSION).toBe(2);
    expect(d.defaultVersion).toBeUndefined();
    expect(base.version).toBe(1);
  });
});

describe('a stored version 1 node shows, keeps and runs what it did before version 2', () => {
  it('n8n keeps and reads the same credentials, for every operation, Runs On and mix of the six credential types', () => {
    let cases = 0;
    const gained = new Set<string>();
    for (const parameters of OPERATIONS.flatMap((operation) => RUNS_ON_VALUES.map((on) => ({ operation, ...(on === undefined ? {} : { runsOn: on }) })))) {
      for (const mix of mixes(TYPES)) {
        const node = stored(parameters, 1, mix);
        const now = kept(node);
        const before = kept(node, BEFORE);
        // Nothing is ever lost. One stale case keeps more: a Runs On of A Windows desktop app left on an operation that
        // has no Runs On (only a hand-written file holds one). n8n's save rule read that hidden value and dropped RPA
        // Browser (quick operations) or RPA Site Login (Sign Steps), which the run reads; now Runs On has a field per
        // version, and n8n ignores a hidden one on save as the run does. Kept is now what the run reads.
        expect(before.filter((t) => !now.includes(t)), `${JSON.stringify(parameters)} ${mix.join(',')}`).toEqual([]);
        for (const t of now.filter((x) => !before.includes(x))) {
          gained.add(`${String(parameters.operation)} ${String(parameters.runsOn)} ${t}`);
          expect(readable(stored(parameters, 1, TYPES), t, BEFORE)).toBe(true);
        }
        cases++;
      }
      const all = stored(parameters, 1, TYPES);
      for (const type of TYPES) expect(readable(all, type), `${JSON.stringify(parameters)} reads ${type}`).toBe(readable(all, type, BEFORE));
    }
    expect(cases).toBe(OPERATIONS.length * RUNS_ON_VALUES.length * 64);
    const quick = OPERATIONS.filter((o) => !['runSteps', 'signSteps', 'importSteps'].includes(o));
    expect([...gained].sort()).toEqual([...quick.map((o) => `${o} desktop ${CREDENTIALS.browser}`), `signSteps desktop ${CREDENTIALS.siteLogin}`].sort());
  });

  it('the same slots and the same fields show, in the same order, with the same type and default, none on the Settings tab', () => {
    for (const parameters of scenarios()) {
      const what = JSON.stringify(parameters);
      expect(slots(parameters, 1), what).toEqual(slots(parameters, 1, BEFORE));
      const now = fields(parameters, 1);
      const before = fields(parameters, 1, BEFORE);
      // Fields another change adds later may show too; every field shown before shows as it did, and no version 2 field.
      expect(now.params.filter((r) => BASE_NAMES.has(r[0] as string)), what).toEqual(before.params);
      expect(names(now.params).filter((n) => V2_ONLY.includes(n)), what).toEqual([]);
      expect(now.settings, what).toEqual([]);
    }
  });

  it('a run sees the same parameters: n8n fills in the same values, and adds only the hidden switch, always on', () => {
    const values: INodeParameters = {
      steps: '={{ $json.steps }}', signature: '={{ $json.signature }}', approvedBy: '={{ $json.approvedBy }}', startUrl: 'https://example.com/list', stepsName: 'items',
      options: { name: 'items', expectedVersion: '={{ $json.version }}' },
    };
    for (const parameters of scenarios()) {
      const node = stored({ ...parameters, ...values }, 1);
      const now = runParameters(node);
      const before = runParameters(node, BEFORE);
      expect(Object.fromEntries(Object.keys(before).map((k) => [k, now[k]])), JSON.stringify(parameters)).toEqual(before);
      // Nothing that was there before appears: only the switch (and fields a later change may add).
      const added = Object.keys(now).filter((k) => !(k in before));
      for (const k of added) expect(k === SHARE_ACROSS_WORKERS || !BASE_NAMES.has(k), `${JSON.stringify(parameters)} adds ${k}`).toBe(true);
      if (SHARE_ACROSS_WORKERS in now) expect(now[SHARE_ACROSS_WORKERS]).toBe(true);
    }
  });

  it('at run time a version 1 node reads Runs On, RPA Redis and the queue message as before', () => {
    const ctx = (params: IDataObject, credentials: string[] = []) =>
      harness({ params, credentials: Object.fromEntries(credentials.map((t) => [t, {}])), typeVersion: 1 });
    expect(runsOn(ctx({ operation: 'runSteps' }))).toBe('browserAndDesktop');
    expect(runsOn(ctx({ operation: 'importSteps' }))).toBe('browserAndDesktop');
    expect(runsOn(ctx({ operation: 'runSteps', runsOn: '={{ "desktop" }}' }))).toBe('browserAndDesktop');
    expect(redisAttached(ctx({ operation: 'runSteps' }, [CREDENTIALS.redis]).getNode())).toBe(true);
    expect(redisAttached(ctx({ operation: 'runSteps' }).getNode())).toBe(false);
    expect(queueNeedsRedis(ctx({ operation: 'runSteps' }).getNode())).toBe(QUEUE_NEEDS_REDIS);
    expect(slotNote(ctx({ operation: 'runSteps', runsOn: 'browser' }), CREDENTIALS.desktopRunner)).toBe(' Its slot shows when Runs On is A Windows desktop app or Browser and desktop apps.');
  });
});

describe('version 2: a new node shows less', () => {
  const passOn = (n: string) => `${n} (only passed on to the workflow file)`;

  it('Run Steps shows four slots, A Windows desktop app three; RPA Redis only with the switch on', () => {
    const run = (p: INodeParameters = {}) => slots({ operation: 'runSteps', ...p }, 2);
    expect(run()).toEqual(['RPA Browser', 'RPA Site Login', 'RPA Step Signing', 'RPA Secret Variables']);
    expect(run({ runsOn: 'browser' })).toEqual(run());
    expect(run({ runsOn: 'desktop' })).toEqual(['RPA Step Signing', 'RPA Desktop Runner', 'RPA Secret Variables']);
    expect(run({ runsOn: 'browserAndDesktop' })).toEqual(['RPA Browser', 'RPA Site Login', 'RPA Step Signing', 'RPA Desktop Runner', 'RPA Secret Variables']);
    expect(run({ [SHARE_ACROSS_WORKERS]: true })).toEqual(['RPA Browser', 'RPA Site Login', 'RPA Step Signing', 'RPA Redis', 'RPA Secret Variables']);
    // A Windows desktop app hides the switch, and RPA Redis with it, as in version 1.
    expect(run({ runsOn: 'desktop', [SHARE_ACROSS_WORKERS]: true })).toEqual(run({ runsOn: 'desktop' }));
  });

  it('Import Steps the same, with its slots only passed on', () => {
    const imp = (p: INodeParameters = {}) => slots({ operation: 'importSteps', ...p }, 2);
    expect(imp()).toEqual(['RPA Browser', 'RPA Site Login', passOn('RPA Step Signing')]);
    expect(imp({ runsOn: 'browserAndDesktop' })).toEqual(['RPA Browser', 'RPA Site Login', passOn('RPA Step Signing'), passOn('RPA Desktop Runner')]);
    expect(imp({ runsOn: 'desktop' })).toEqual([passOn('RPA Step Signing'), passOn('RPA Desktop Runner')]);
    expect(imp({ runsOn: 'browserAndDesktop', [SHARE_ACROSS_WORKERS]: true })).toEqual(['RPA Browser', 'RPA Site Login', 'RPA Redis', passOn('RPA Step Signing'), passOn('RPA Desktop Runner')]);
  });

  it('Sign Steps and the quick operations show what they show in version 1', () => {
    for (const operation of OPERATIONS.filter((o) => o !== 'runSteps' && o !== 'importSteps')) {
      for (const on of RUNS_ON_VALUES) {
        const parameters = { operation, ...(on === undefined ? {} : { runsOn: on }) };
        expect(slots(parameters, 2), operation).toEqual(slots(parameters, 1));
        expect(fields(parameters, 2), operation).toEqual(fields(parameters, 1));
      }
    }
  });

  it('Signature and Approved By are on the Settings tab, with the same names; Steps stays; the switch is on the Parameters tab', () => {
    const v2 = fields({ operation: 'runSteps' }, 2);
    expect(names(v2.settings)).toEqual(['signature', 'approvedBy']);
    expect(names(v2.params)).toEqual(expect.arrayContaining(['runsOn', 'steps', 'requireSignedSteps', SHARE_ACROSS_WORKERS]));
    expect(names(v2.params)).not.toContain('signature');
    expect(names(fields({ operation: 'runSteps', runsOn: 'desktop' }, 2).params)).not.toContain(SHARE_ACROSS_WORKERS);
    // The run reads them where they always were: the node's parameters.
    const node = stored({ operation: 'runSteps', signature: '={{ $json.signature }}', approvedBy: '={{ $json.approvedBy }}' }, 2);
    expect(runParameters(node)).toMatchObject({ signature: '={{ $json.signature }}', approvedBy: '={{ $json.approvedBy }}', runsOn: 'browser', [SHARE_ACROSS_WORKERS]: false });
  });

  it('the switch is a typed choice, off, named for what RPA Redis is for', () => {
    expect(SHARE_ACROSS_WORKERS_PROPERTY).toMatchObject({
      displayName: 'Share Login Breaker Across Workers (RPA Redis)', name: 'shareAcrossWorkers', type: 'boolean', default: false, noDataExpression: true,
    });
    expect(SHARE_ACROSS_WORKERS_PROPERTY.description).toMatch(/^Whether the login breaker and the run lock are kept in Redis/);
    expect(SHARE_ACROSS_WORKERS_PROPERTY.description).toContain('queue mode');
    expect(String(SHARE_ACROSS_WORKERS_PROPERTY.description)).not.toMatch(/secure|safe|guarantee|[<>]/i);
    expect(QUEUE_NEEDS_REDIS_V2).toContain('Turn on Share Login Breaker Across Workers (RPA Redis)');
    expect(QUEUE_NEEDS_REDIS_V2).not.toMatch(/[<>]/);
  });

  it('with the switch off, RPA Redis is neither kept nor read nor used: the node runs as a version 1 node without it', () => {
    for (const operation of ['runSteps', 'importSteps']) {
      const off = stored({ operation }, 2, TYPES);
      expect(kept(off)).not.toContain(CREDENTIALS.redis);
      expect(readable(off, CREDENTIALS.redis)).toBe(false);
      expect(redisAttached({ ...off, parameters: runParameters(off) })).toBe(false);
      const on = stored({ operation, [SHARE_ACROSS_WORKERS]: true }, 2, TYPES);
      expect(kept(on)).toContain(CREDENTIALS.redis);
      expect(readable(on, CREDENTIALS.redis)).toBe(true);
      expect(redisAttached({ ...on, parameters: runParameters(on) })).toBe(true);
      // A Windows desktop app hides RPA Redis, the switch with it.
      const desk = stored({ operation, runsOn: 'desktop', [SHARE_ACROSS_WORKERS]: true }, 2, TYPES);
      expect(redisAttached({ ...desk, parameters: runParameters(desk) })).toBe(false);
      expect(queueNeedsRedis(off)).toBe(QUEUE_NEEDS_REDIS_V2);
    }
  });

  it('Import Steps in queue mode: version 1 asks for RPA Redis as before, version 2 also for the switch, and with it on goes past the check', async () => {
    const site = { url: 'https://portal.example.com', host: 'portal.example.com' };
    const doc = { name: 'q', version: 1, startUrl: `${site.url}/acme/login`, steps: [{ intent: 'Open', goto: `${site.url}/acme/login` }] };
    const params = (over: IDataObject = {}) => ({
      operation: 'importSteps', source: 'steps', inputFrom: 'text', sourceText: JSON.stringify(doc), stepsName: 'q', aiRepair: false, options: { saveTrace: 'never' }, ...over,
    });
    const credentials = { playwrightBrowserApi: { mode: 'local', headless: true }, playwrightSiteLoginApi: siteLoginData(site), playwrightRedisApi: { host: 'redis.internal' } };
    const opened: unknown[] = [];
    const engine = { ...fakeEngine(() => { throw new Error('no run here'); }), adoptDraft: async () => { throw new Error('stop after the check'); } };
    const run = async (typeVersion: number, over: IDataObject = {}, attach = credentials) => {
      const ctx = nodeContext({ params: params(over), credentials: attach, typeVersion, continueOnFail: true });
      const out = await executeImportSteps(ctx, engine as never, { executionsMode: 'queue', redis: async (c: unknown) => { opened.push(c); throw new Error('stop after the check'); } });
      return JSON.stringify(out);
    };
    const { playwrightRedisApi: _redis, ...noRedis } = credentials;
    expect(await run(1, {}, noRedis as typeof credentials)).toContain(JSON.stringify(QUEUE_NEEDS_REDIS).slice(1, -1));
    expect(await run(1)).not.toContain('n8n runs in queue mode');
    expect(await run(2)).toContain(JSON.stringify(QUEUE_NEEDS_REDIS_V2).slice(1, -1));
    expect(await run(2, { [SHARE_ACROSS_WORKERS]: true })).not.toContain('n8n runs in queue mode');
  });

  it('at run time a version 2 node without Runs On is A browser, as n8n shows it', () => {
    const ctx = (params: IDataObject) => harness({ params, typeVersion: 2 });
    expect(runsOnDefault(2)).toBe('browser');
    expect(runsOn(ctx({ operation: 'runSteps' }))).toBe('browser');
    expect(runsOn(ctx({ operation: 'importSteps', runsOn: 'browserAndDesktop' }))).toBe('browserAndDesktop');
    expect(runsOn(ctx({ operation: 'runSteps', runsOn: '={{ "desktop" }}' }))).toBe('browserAndDesktop');
    expect(runsOn(ctx({ operation: 'signSteps' }))).toBe('browserAndDesktop');
    expect(slotNote(ctx({ operation: 'runSteps' }), CREDENTIALS.desktopRunner)).toBe(' Its slot shows when Runs On is A Windows desktop app or Browser and desktop apps.');
  });
});

describe('the templates\' RPA nodes are version 2, and that changes nothing they do', () => {
  const TEMPLATES = new URL('../templates/', import.meta.url);
  const rpaNodes = readdirSync(TEMPLATES).filter((f) => f.endsWith('.json')).flatMap((file) => {
    const w = JSON.parse(readFileSync(new URL(file, TEMPLATES), 'utf8')) as { nodes: INode[] };
    return w.nodes.filter((n) => n.type === RPA_NODE_TYPE).map((n) => ({ file, node: n }));
  });

  it('every RPA node of every template is version 2; Import steps keeps Browser and desktop apps, typed', () => {
    expect(rpaNodes.length).toBe(7);
    for (const { file, node } of rpaNodes) expect(node.typeVersion, `${file} ${node.name}`).toBe(2);
    const imp = rpaNodes.find(({ node }) => node.parameters.operation === 'importSteps')!.node;
    expect(imp.parameters.runsOn).toBe('browserAndDesktop');
  });

  it('each one reads the same values as at version 1; on screen only RPA Redis goes, and Signature and Approved By move to Settings', () => {
    for (const { file, node } of rpaNodes) {
      const what = `${file} ${node.name}`;
      const v1 = { ...node, typeVersion: 1 };
      // What a run reads: the same values, apart from the version 2 switch, off.
      expect(without(runParameters(node), SHARE_ACROSS_WORKERS), what).toEqual(without(runParameters(v1), SHARE_ACROSS_WORKERS));
      const op = String(node.parameters.operation);
      const slotsNow = slots(node.parameters, 2);
      expect(slotsNow, what).toEqual(slots(node.parameters, 1).filter((s) => s !== 'RPA Redis'));
      const now = fields(node.parameters, 2);
      const then = fields(node.parameters, 1);
      const moved = op === 'runSteps' ? ['signature', 'approvedBy'] : [];
      expect(names(now.params).filter((n) => n !== SHARE_ACROSS_WORKERS), what).toEqual(names(then.params).filter((n) => !moved.includes(n)));
      expect(names(now.params).includes(SHARE_ACROSS_WORKERS), what).toBe(op === 'runSteps' || op === 'importSteps');
      expect(names(now.settings), what).toEqual(moved);
      // Every credential the template's node could be given is kept as at version 1, except RPA Redis behind the switch.
      const all = { ...node, credentials: Object.fromEntries(TYPES.map((t) => [t, { id: t, name: t }])) };
      expect(kept(all), what).toEqual(kept({ ...all, typeVersion: 1 }).filter((t) => t !== CREDENTIALS.redis));
    }
  });
});
