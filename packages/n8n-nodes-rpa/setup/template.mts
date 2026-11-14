// The template "RPA: 5 Import a bot": its nodes with this run's settings and credentials, the form's address and
// name, and how a workflow in n8n differs from this version's template. No request is made here.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CREDENTIALS } from '../nodes/Playwright/config.js';
import { clean } from './n8n-api.mjs';
import { Stop } from './io.mjs';
import { BROWSER, type Options, RUNNER, SIGNING, WORKFLOW_NAME } from './options.mjs';
import { ownerProject, type Ref } from './ownership.mjs';

// The template's name, or the dated name --new-workflow gives.
export const WORKFLOW_NAMES = /^RPA: 5 Import a bot(?: \(\d{4}-\d{2}-\d{2}(?: \d{2}-\d{2})?\))?$/;

const TEMPLATE_URL = new URL('../templates/5-import-a-bot.json', import.meta.url);

// The template's nodes that take what this command makes.
export const NODE = { form: 'Import a bot', importSteps: 'Import steps', signSteps: 'Sign steps' };

export function loadTemplate() {
  const t = JSON.parse(readFileSync(TEMPLATE_URL, 'utf8'));
  for (const name of Object.values(NODE)) {
    if (!t.nodes.some((n: { name: string }) => n.name === name)) throw new Stop(`The template ${WORKFLOW_NAME} has no node "${name}": this package is broken, reinstall it.`);
  }
  return t;
}

/**
 * The form's readable address, /form/rpa-import, typed on the Windows machine by hand. n8n 2.45's Form Trigger (2.2 and
 * later) takes it as Options → Form Path; without one the address is the node's webhook id. The form's sign-in (n8n's
 * or Basic Auth) is what protects it, not its address, and the pages after it keep their own signed addresses.
 */
export const FORM_PATH = 'rpa-import';
/** The Form Path a workflow's form trigger answers at (Options → Form Path, or the older Form Path field), or ''. */
export const formPathOf = (node: any): string => String(node?.parameters?.options?.path || node?.parameters?.path || '').trim().replace(/^\/+|\/+$/g, '');
/**
 * Why /form/rpa-import cannot be this form's, or undefined when no form n8n lists uses it: a workflow (published or not,
 * as publishing it would take the address) with a form trigger at that path. One whose nodes n8n does not list counts as
 * using it, since this run cannot tell.
 */
export function formPathTaken(workflows: any[], path: string): string | undefined {
  for (const w of workflows) {
    if (!Array.isArray(w?.nodes)) return `n8n does not list the nodes of the workflow "${clean(w?.name, w?.id)}" (id ${clean(w?.id)})`;
    if (w.nodes.some((n: any) => /\.formTrigger$/.test(String(n?.type)) && formPathOf(n).toLowerCase() === path)) {
      return `the workflow "${clean(w.name, w.id)}" (id ${clean(w.id)}) has a form at /form/${path}`;
    }
  }
  return undefined;
}

/**
 * A Site Login's own form (--new-workflow --site-login): the workflow "RPA: 5 Import a bot (<Site Login>)", its form
 * titled for that Site Login, at /form/rpa-import-<slug>. n8n's workflow names are at most 128 characters: the Site
 * Login's name is cut so that the dated name still fits.
 */
export const siteFormName = (siteLogin: string) => `${WORKFLOW_NAME} (${siteLogin.length > 80 ? `${siteLogin.slice(0, 79)}…` : siteLogin})`;
export const siteFormTitle = (siteLogin: string) => `Import a bot for ${siteLogin}`;
/** The Site Login's name as the last part of an address: lowercase letters and digits joined by "-", at most 40; '' when none. */
export function siteSlug(siteLogin: string): string {
  const words = siteLogin.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.join('-').slice(0, 40).replace(/-+$/, '');
}
/** A workflow name as an exact pattern, with the date --new-workflow may add. */
const DATED = String.raw`(?: \(\d{4}-\d{2}-\d{2}(?: \d{2}-\d{2})?\))?$`;
export const namesFor = (base: string) => new RegExp(`^${base.replace(/[\\^$.*+?()[\]{}|/-]/g, (c) => `\\${c}`)}${DATED}`);

/** The form trigger's Authentication for each --form-login. */
export const FORM_AUTH = { n8n: 'n8nUserAuth', basic: 'basicAuth' } as const;
/** How a workflow's form signs people in: its trigger's Authentication (a form saved without one has none). */
export const formAuthentication = (workflow: any): unknown => workflow?.nodes?.find((n: any) => n?.name === NODE.form)?.parameters?.authentication;

/**
 * The template's nodes, with the approver on the allowlist and an address for each form page; no credentials. With
 * --form-login basic the form asks for Basic Auth (Sign steps then takes Approved By: its Approver follows the form).
 * With --allow-private-network, Import steps has Options → Allow Private Network on. With formPath, the form answers at
 * /form/<formPath> instead of its webhook id. With formTitle (a Site Login's own form), the form shows that title.
 */
export function templateNodes(approver: string, formLogin: Options['formLogin'], allowPrivateNetwork: boolean, formPath?: string, formTitle?: string): Record<string, any>[] {
  return loadTemplate().nodes.map((node: Record<string, any>) => {
    const n: Record<string, any> = { ...node, parameters: { ...node.parameters } };
    delete n.credentials;
    // --allow-private-network: a typed true (Import Steps refuses an expression there).
    if (n.name === NODE.importSteps && allowPrivateNetwork) n.parameters.options = { ...n.parameters.options, allowPrivateNetwork: true };
    // The form's address is its webhook id: n8n's editor gives one on import, the API does not.
    if (/\.(formTrigger|form)$/.test(n.type) && !n.webhookId) n.webhookId = randomUUID();
    if (n.name === NODE.signSteps) n.parameters.approverAllowlist = approver;
    if (n.name === NODE.form && formLogin === 'basic') {
      delete n.parameters.requireExecuteAccess;
      n.parameters.authentication = FORM_AUTH.basic;
    }
    if (n.name === NODE.form && formPath) n.parameters.options = { ...n.parameters.options, path: formPath };
    if (n.name === NODE.form && formTitle) n.parameters.formTitle = formTitle;
    return n;
  });
}

/**
 * The nodes with this run's credentials set on the nodes that use them. Import steps also gets the signing key and the
 * desktop runner in its two "only passed on to the workflow file" slots: it never reads them, it copies their id and
 * name into the workflow file the form hands over, so that file needs nothing picked. The Site Login (--site-login) goes
 * on Import steps and Sign steps, which both use it.
 */
export function wire(nodes: Record<string, any>[], refs: { form?: Ref; signing: Ref; browser?: Ref; runner?: Ref; siteLogin?: Ref }) {
  const site = refs.siteLogin ? { [CREDENTIALS.siteLogin]: refs.siteLogin } : {};
  return nodes.map((node) => {
    const n = { ...node };
    if (n.name === NODE.form && refs.form) n.credentials = { httpBasicAuth: refs.form };
    if (n.name === NODE.signSteps) n.credentials = { [SIGNING.type]: refs.signing, ...site };
    if (n.name === NODE.importSteps) {
      n.credentials = {
        ...(refs.browser ? { [BROWSER.type]: refs.browser } : {}), ...site, [SIGNING.type]: refs.signing, ...(refs.runner ? { [RUNNER.type]: refs.runner } : {}),
      };
    }
    return n;
  });
}

/** The first way a workflow's nodes differ from the template's by name and type, in words that repeat no value; undefined when none. */
export function structuralDifference(workflow: any): string | undefined {
  const want = new Map<string, string>(loadTemplate().nodes.map((n: any) => [n.name, n.type]));
  const have = new Map<string, string>((Array.isArray(workflow?.nodes) ? workflow.nodes : []).map((n: any) => [String(n?.name), String(n?.type)]));
  for (const [name, type] of want) {
    if (!have.has(name)) return `it has no node "${name}"`;
    if (have.get(name) !== type) return `its node "${name}" is not a ${type} node`;
  }
  for (const name of have.keys()) if (!want.has(name)) return `it has a node "${clean(name)}" that the template does not have`;
  return undefined;
}

/** Why a workflow cannot be relied on: a credential on a node that is not of that node's credential type in this run's project. */
export function credentialProblem(workflow: any, credentials: any[], home: string): string | undefined {
  for (const n of Array.isArray(workflow?.nodes) ? workflow.nodes : []) {
    for (const [type, ref] of Object.entries((n?.credentials ?? {}) as Record<string, any>)) {
      const c = credentials.find((x) => x?.id !== undefined && String(x.id) === String(ref?.id));
      if (!c) return `a credential on "${clean(n.name)}" is not one this run can see`;
      if (c.type !== type) return `a credential on "${clean(n.name)}" (id ${clean(c.id)}) is not of the type ${clean(type)}`;
      if (ownerProject(c, 'credential') !== home) return `a credential on "${clean(n.name)}" (id ${clean(c.id)}) belongs to another project or user`;
    }
  }
  return undefined;
}

/** The template's nodes every form this command makes has, by name and type: a workflow without them is not one it made. */
const OWN_NODES: [string, RegExp][] = [[NODE.form, /\.formTrigger$/], [NODE.importSteps, /^n8n-nodes-rpa\.playwright$/], [NODE.signSteps, /^n8n-nodes-rpa\.playwright$/]];
export const isOwnForm = (w: any) => Array.isArray(w?.nodes) && OWN_NODES.every(([name, type]) => w.nodes.some((n: any) => n?.name === name && type.test(String(n?.type))));

/**
 * Whether a value the template sets is what the workflow holds: every key the template gives has the same value, lists
 * have the same length. A key the workflow does not have counts as held: n8n's editor leaves out a parameter that has its
 * default value when it saves a workflow.
 */
function holds(have: unknown, want: unknown): boolean {
  if (have === undefined) return true;
  if (Array.isArray(want)) return Array.isArray(have) && have.length === want.length && want.every((w, i) => holds(have[i], w));
  if (want && typeof want === 'object') {
    return !!have && typeof have === 'object' && !Array.isArray(have) && Object.entries(want).every(([k, v]) => holds((have as Record<string, unknown>)[k], v));
  }
  return have === want;
}

/** A workflow's connections as a set of "from|output|index|to|input|index" lines, so that their order does not count. */
function edges(connections: any): Set<string> {
  const out = new Set<string>();
  for (const [from, kinds] of Object.entries(connections ?? {})) {
    for (const [kind, outputs] of Object.entries((kinds ?? {}) as Record<string, any>)) {
      (Array.isArray(outputs) ? outputs : []).forEach((targets: any, index: number) => {
        for (const t of Array.isArray(targets) ? targets : []) out.add(JSON.stringify([from, kind, index, t?.node, t?.type, t?.index ?? 0]));
      });
    }
  }
  return out;
}

/** How a form this command made differs from this version's template, by node name. `older`: at an older node version. */
export interface Changes { added: string[]; removed: string[]; changed: string[]; older: string[]; connections: boolean }

/**
 * The workflow's nodes as this version's template has them, keeping what the person set: the Approver Allowlist, the
 * form's sign-in (Authentication, Require Execute Permission), its address (Form Path, and every form node's webhook id,
 * its address without one) and title, every credential picked on a node, Allow Private Network, the values of the
 * template's Settings node and the workflow picked on Approve steps (both set for approval by email).
 */
export function updatedNodes(workflow: any): Record<string, any>[] {
  const old = new Map<string, any>((workflow.nodes as any[]).map((n) => [String(n?.name), n]));
  return loadTemplate().nodes.map((node: Record<string, any>) => {
    const n: Record<string, any> = structuredClone(node);
    delete n.credentials;
    const o = old.get(n.name);
    if (o?.webhookId) n.webhookId = o.webhookId;
    if (/\.(formTrigger|form)$/.test(n.type) && !n.webhookId) n.webhookId = randomUUID();
    if (!o) return n;
    if (o.credentials && o.type === n.type) n.credentials = structuredClone(o.credentials);
    const op = o.parameters ?? {};
    const p = n.parameters;
    if (n.name === NODE.signSteps && op.approverAllowlist !== undefined) p.approverAllowlist = op.approverAllowlist;
    if (n.name === NODE.form) {
      for (const key of ['authentication', 'requireExecuteAccess', 'formTitle']) {
        if (op[key] === undefined) delete p[key];
        else p[key] = op[key];
      }
      p.options = { ...p.options };
      if (op.options?.path === undefined) delete p.options.path;
      else p.options.path = op.options.path;
    }
    if (n.name === NODE.importSteps && op.options?.allowPrivateNetwork !== undefined) p.options = { ...p.options, allowPrivateNetwork: op.options.allowPrivateNetwork };
    // An RPA Redis picked on Import steps stays in use: from node version 2 its slot shows only with this switch on.
    if (n.name === NODE.importSteps && n.typeVersion >= 2 && n.credentials?.playwrightRedisApi && (o.typeVersion < 2 || op.shareAcrossWorkers === true)) p.shareAcrossWorkers = true;
    if (n.name === 'Settings' && Array.isArray(op.assignments?.assignments) && Array.isArray(p.assignments?.assignments)) {
      for (const a of p.assignments.assignments) {
        const was = op.assignments.assignments.find((x: any) => x?.name === a.name && x?.type === a.type);
        if (was) a.value = was.value;
      }
    }
    if (n.name === 'Approve steps' && op.workflowId?.value) p.workflowId = op.workflowId;
    return n;
  });
}

/** How a workflow differs from this version's template with what the person set kept; undefined when it holds the template. */
export function templateChanges(workflow: any): Changes | undefined {
  const want = updatedNodes(workflow);
  const have = new Map<string, any>((Array.isArray(workflow?.nodes) ? workflow.nodes : []).map((n: any) => [String(n?.name), n]));
  const wantNames = new Set(want.map((n) => n.name));
  const added = want.filter((n) => !have.has(n.name)).map((n) => n.name);
  const removed = [...have.keys()].filter((name) => !wantNames.has(name));
  // A node of the template's type at an older version is said on a line of its own; any other version difference is a setting.
  const older = want.filter((n) => {
    const h = have.get(n.name);
    return h && h.type === n.type && typeof h.typeVersion === 'number' && h.typeVersion < n.typeVersion;
  }).map((n) => n.name);
  const changed = want.filter((n) => {
    const h = have.get(n.name);
    return h && (h.type !== n.type || (h.typeVersion !== n.typeVersion && !older.includes(n.name)) || !holds(h.parameters ?? {}, n.parameters ?? {}));
  }).map((n) => n.name);
  const a = edges(workflow?.connections);
  const b = edges(loadTemplate().connections);
  const connections = a.size !== b.size || [...a].some((e) => !b.has(e));
  return added.length || removed.length || changed.length || older.length || connections ? { added, removed, changed, older, connections } : undefined;
}
