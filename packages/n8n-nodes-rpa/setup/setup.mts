// `npx n8n-nodes-rpa setup`: sets an n8n up for importing a first bot, through n8n's public API. It creates the import
// form's login, the RPA Step Signing credential and (with a Connection Line) the RPA Desktop Runner credential, imports
// "RPA: 5 Import a bot" with those set and the approver on the allowlist, and publishes it. Node 22+, no dependencies:
// scripts/build-setup.mjs bundles this file, setup/n8n-api.mjs and the Connection Line parser of the node into
// dist/setup.mjs, the package's bin.
//
// Secrets: the API key and the Connection Line come from the environment or a prompt that does not echo, never from a
// flag. Every line printed passes through the redactor, which knows every secret (also a server error that echoes a
// request). The form's password is printed once, on the line that shows it; the signing key only with
// --show-signing-key on the run that makes it. Nothing is written to a file.
//
// Ownership: it works in one project, the API key owner's personal project or the one --project-id names, and reuses only
// what that project owns. A credential or workflow of the same name owned anywhere else is left alone and reported: on an
// n8n with several users, someone else could have made an "RPA Step Signing" with a key they know. Where n8n's answer
// does not say who owns a thing, it is not reused (fail closed): a fresh one is made, so the user never ends up with a
// signing key they did not make. What n8n 2.45 tells (packages/cli/src/public-api/v1/controllers): a credential list item
// has shared[] = { id: project id, name, role: 'credential:owner' | 'credential:user' }; a workflow list item has
// shared[] = { role: 'workflow:owner' | ..., projectId }; GET /workflows/{id} adds shared[].project = { id, type
// ('personal' | 'team'), creatorId }. The key owner's user id is the subject of the API key, a JWT
// (PublicApiKeyService.generateApiKey), and a personal project's creatorId is its user. /projects needs a license.
//
// It never rewrites what is there on its own: a credential or workflow of its project with the same name is reused as it
// is, and a reused workflow must match the template (node names and types, credentials of its project) before it is
// published. Only a flag made for it changes one: --new-form-password (the form's login) and --replace-signing-key,
// which also asks for the word REPLACE at a terminal, because every bot signed with the old key stops until it is
// approved again. n8n's API never returns a secret, so a second run cannot show a password made earlier.
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CREDENTIALS, parseConnectionLine } from '../nodes/Playwright/config.js';
import {
  browserCredentialData, type Client, createClient, createRedactor, MIN_BROWSER_TOKEN_LENGTH, parseBrowserUrl, parseN8nUrl,
} from './n8n-api.mjs';

const DEFAULT_URL = 'http://localhost:5678';
const WORKFLOW_NAME = 'RPA: 5 Import a bot';
// The template's name, or the dated name --new-workflow gives.
const WORKFLOW_NAMES = /^RPA: 5 Import a bot(?: \(\d{4}-\d{2}-\d{2}(?: \d{2}-\d{2})?\))?$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PROJECT_LOOKUPS = 50;
const TEMPLATE_URL = new URL('../templates/5-import-a-bot.json', import.meta.url);
const FORM = { name: 'RPA import form', type: 'httpBasicAuth', user: 'rpa' };
const SIGNING = { name: 'RPA Step Signing', type: CREDENTIALS.signing };
const RUNNER = { name: 'RPA Desktop Runner', type: CREDENTIALS.desktopRunner };
const BROWSER = { name: 'RPA Browser', type: CREDENTIALS.browser };
// The template's nodes that take what this command makes.
const NODE = { form: 'Import a bot', importSteps: 'Import steps', signSteps: 'Sign steps' };
const DOCS = 'https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs';
const INSTALL_DOC = `${DOCS}/reference/operator.md#install-the-node`;
const LOST_KEY_DOC = `${DOCS}/reference/security.md#if-the-signing-key-is-lost-or-changed`;
const WHERE_KEYS = 'Make an API key in n8n: Settings → n8n API → Create an API key (as the owner or an admin).';
const USAGE = [
  'Usage: npx n8n-nodes-rpa setup [--url <n8n address>] [--approver <email>] [options]',
  '',
  'Sets up n8n for importing a bot: the import form and its login, the RPA Step Signing credential, and the workflow',
  `"${WORKFLOW_NAME}", published. Run it again at any time: it reuses what is there.`,
  '',
  `  --url <address>        n8n's address (default ${DEFAULT_URL}). http:// only on this machine.`,
  '  --approver <email>     your email address: it goes into the Approver Allowlist of Sign steps.',
  '  --allow-http           allow http:// to another machine (the API key then crosses the network unencrypted).',
  '  --show-signing-key     print the signing key when this run makes it (n8n never gives a stored key back).',
  '  --replace-signing-key  make a new signing key and print it. Every bot signed with the old key must be approved again:',
  '                         it asks you to type REPLACE, at a terminal only.',
  '  --new-form-password    give the form a new password and print it (n8n never shows the old one again).',
  '  --browser-url <ws-url> the browser service for browser bots: creates the RPA Browser credential, with the token from',
  '                         RPA_BROWSER_TOKEN, and sets it on Import steps.',
  '  --project-id <id>      the n8n project to work in (default: the API key owner\'s personal project). Only what that',
  '                         project owns is reused.',
  `  --new-workflow         leave a "${WORKFLOW_NAME}" that differs from the template alone and make a fresh one, with the date in its name.`,
  '',
  'Secrets never go in flags. The command asks for them, or reads them from the environment:',
  `  N8N_API_KEY            the n8n API key. ${WHERE_KEYS}`,
  '  RPA_CONNECTION_LINE    the rpa-runner:// line of a Windows machine (optional): creates the RPA Desktop Runner credential.',
  '  RPA_BROWSER_TOKEN      the browser service token, with --browser-url.',
].join('\n');

const redactor = createRedactor();
const { redact } = redactor;
const say = (line = '') => process.stdout.write(`${redact(line)}\n`);
const warn = (line: string) => process.stderr.write(`${redact(line)}\n`);
/** The one line that shows a secret: the words around it are redacted, the secret itself is not. */
const reveal = (before: string, secret: string, after = '') => process.stdout.write(`${redact(before)}${secret}${redact(after)}\n`);

/** A problem the user fixes: printed, exit 2 (wrong input) or 1 (n8n's answer), nothing more is done. */
class Stop extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

interface Options {
  url: string;
  approver?: string;
  allowHttp: boolean;
  showSigningKey: boolean;
  replaceSigningKey: boolean;
  newFormPassword: boolean;
  browserUrl?: string;
  projectId?: string;
  newWorkflow: boolean;
}

function readOptions(argv: string[]): Options | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        url: { type: 'string' }, approver: { type: 'string' }, 'allow-http': { type: 'boolean' }, 'show-signing-key': { type: 'boolean' },
        'replace-signing-key': { type: 'boolean' },
        'new-form-password': { type: 'boolean' }, 'browser-url': { type: 'string' }, 'project-id': { type: 'string' },
        'new-workflow': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    // Never echo the arguments: someone may have typed a secret as a flag (--api-key ..., --token ...).
    const flag = /'(--?[A-Za-z0-9-]+)/.exec(String((err as Error).message))?.[1];
    throw new Stop(`${flag ? `Unknown option ${flag}.` : 'Unexpected argument.'} Secrets go in the environment or the prompts, never in flags.\n\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals[0] === 'help') return 'help';
  if (positionals.length !== 1 || positionals[0] !== 'setup') {
    throw new Stop(`${positionals.length ? 'Unknown command.' : 'Say what to do: setup.'}\n\n${USAGE}`, 2);
  }
  return {
    url: values.url ?? DEFAULT_URL,
    approver: values.approver,
    allowHttp: values['allow-http'] === true,
    showSigningKey: values['show-signing-key'] === true,
    replaceSigningKey: values['replace-signing-key'] === true,
    newFormPassword: values['new-form-password'] === true,
    browserUrl: values['browser-url'],
    projectId: values['project-id'],
    newWorkflow: values['new-workflow'] === true,
  };
}

const interactive = () => process.stdin.isTTY === true && process.stdout.isTTY === true;

/** Asks for a line, echoed (an email address, yes or no). */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return (await rl.question(redact(question))).trim();
  } finally {
    rl.close();
  }
}

/** Asks for a secret without echo: the terminal shows nothing while it is typed or pasted. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    let value = '';
    const finish = (err?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Stop('Stopped: nothing was changed.', 130));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    // Echo off before the question shows, so that a line pasted the moment it shows is never echoed.
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdout.write(redact(question));
    stdin.resume();
    stdin.on('data', onData);
  });
}

const EMAIL = /^[^\s@,;<>"'{}=]+@[^\s@,;<>"'{}]+\.[^\s@,;<>"'{}]+$/;
function checkApprover(value: string): string {
  if (!EMAIL.test(value)) throw new Stop('--approver must be one email address, such as you@example.com: it is recorded as the approver of each bot.', 2);
  return value;
}

interface Inputs {
  options: Options;
  origin: string;
  plaintext: boolean;
  client: Client;
  /** The API key owner's user id, from the key itself; undefined when the key does not say. */
  userId?: string;
  line?: string;
  browser?: { href: string; token: string };
}

/** Everything typed or set before anything is sent: the address, the API key, the Connection Line, the browser. */
async function readInputs(options: Options, env: NodeJS.ProcessEnv): Promise<Inputs> {
  // Registered first, so that no message below can print them.
  for (const s of [env.N8N_API_KEY, env.RPA_CONNECTION_LINE, env.RPA_BROWSER_TOKEN]) redactor.add(s);
  const n8n = parseN8nUrl(options.url, '--url');
  if (n8n.problem !== undefined) throw new Stop(n8n.problem, 2);
  if (n8n.plaintext && !options.allowHttp) {
    throw new Stop(`${options.url} is http:// to another machine: the API key would cross the network unencrypted. Use n8n's https:// address, or add --allow-http if this network is yours.`, 2);
  }
  if (options.approver !== undefined) checkApprover(options.approver);
  if (options.projectId !== undefined && !PROJECT_ID.test(options.projectId)) throw new Stop('--project-id must be an n8n project id (letters, digits, _ and -).', 2);

  let browser: Inputs['browser'];
  if (options.browserUrl !== undefined) {
    const url = parseBrowserUrl(options.browserUrl, '--browser-url');
    if (url.problem !== undefined) throw new Stop(url.problem, 2);
    const token = env.RPA_BROWSER_TOKEN ?? '';
    if (!token) throw new Stop('--browser-url needs the browser service token in RPA_BROWSER_TOKEN (read -rs RPA_BROWSER_TOKEN && export RPA_BROWSER_TOKEN).', 2);
    if (token.length < MIN_BROWSER_TOKEN_LENGTH) throw new Stop(`RPA_BROWSER_TOKEN is shorter than ${MIN_BROWSER_TOKEN_LENGTH} characters: the browser service refuses such a token.`, 2);
    browser = { href: url.href, token };
  }

  let apiKey = (env.N8N_API_KEY ?? '').trim();
  if (!apiKey) {
    if (!interactive()) throw new Stop(`No API key: set N8N_API_KEY (read -rs N8N_API_KEY && export N8N_API_KEY), or run this in a terminal to be asked. ${WHERE_KEYS}`, 2);
    say(WHERE_KEYS);
    apiKey = await askHidden('n8n API key (not shown): ');
    redactor.add(apiKey);
    if (!apiKey) throw new Stop('No API key given: nothing was changed.', 2);
  }

  let line = (env.RPA_CONNECTION_LINE ?? '').trim() || undefined;
  if (!line && interactive() && /^y(es)?$/i.test(await ask('Connect a Windows machine now? (y/N) '))) {
    say('On that machine, in an administrator PowerShell: & "C:\\Program Files\\RPA Runner\\rpa.cmd" connection -ShowTokens');
    line = (await askHidden('Paste the line that starts with rpa-runner:// (not shown): ')) || undefined;
    redactor.add(line);
    if (!line) say('No line given: the Windows machine can be connected later, in an RPA Desktop Runner credential.');
  }
  if (line) {
    try {
      // The node's own parser; its messages never repeat any part of the line.
      redactor.add(parseConnectionLine('runner', line).token);
    } catch (err) {
      throw new Stop(`${(err as Error).message} Nothing was sent to n8n.`, 2);
    }
  }
  return { options, origin: n8n.origin, plaintext: n8n.plaintext, client: createClient({ base: n8n.base, apiKey, redact }), userId: keyUserId(apiKey), line, browser };
}

/**
 * The user an n8n API key belongs to: n8n 2.x keys are JWTs whose subject is the user's id. Read without checking the
 * signature (n8n checks it on every call); undefined for a key of any other form.
 */
function keyUserId(apiKey: string): string | undefined {
  const parts = apiKey.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const sub = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))?.sub;
    return typeof sub === 'string' && sub ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** The project that owns a list item: its one shared entry with the owner role, or undefined when n8n does not say. */
function ownerProject(item: any, kind: 'credential' | 'workflow'): string | undefined {
  if (!Array.isArray(item?.shared)) return undefined;
  const owners = item.shared.filter((s: any) => s?.role === `${kind}:owner`);
  if (owners.length !== 1) return undefined;
  const id = kind === 'credential' ? owners[0].id : owners[0].projectId;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * The API key owner's personal project: the owner project of a visible workflow whose project is personal and was made
 * for that user. Undefined when no visible workflow lives there, or the key or n8n's answers do not say.
 */
async function personalProject(client: Client, workflows: any[], userId: string | undefined): Promise<string | undefined> {
  if (!userId) return undefined;
  const asked = new Set<string>();
  for (const w of workflows) {
    const pid = ownerProject(w, 'workflow');
    if (!pid || asked.has(pid)) continue;
    if (asked.size >= MAX_PROJECT_LOOKUPS) return undefined;
    asked.add(pid);
    const r = await client.api('GET', `/workflows/${encodeURIComponent(String(w.id))}`);
    const project = r.status === 200 && Array.isArray(r.json?.shared) ? r.json.shared.find((s: any) => s?.role === 'workflow:owner')?.project : undefined;
    if (project?.id === pid && project.type === 'personal' && project.creatorId === userId) return pid;
  }
  return undefined;
}

/** n8n answers, the key works, the node is installed (n8n knows its credential types), with the fields used here. */
async function checkN8n({ client, origin }: Inputs, types: { type: string; fields: string[] }[]) {
  let r;
  try {
    r = await client.api('GET', '/workflows?limit=1');
  } catch (err) {
    throw new Stop(`n8n does not answer at ${origin} (${(err as Error).message.replace(/^.* failed: /, '')}). Check that n8n runs and the address is right (--url).`);
  }
  if (r.status === 401 || r.status === 403) throw new Stop(`n8n refused the API key (${client.reason(r)}). ${WHERE_KEYS}`);
  if (r.status === 404) throw new Stop(`${origin} has no n8n public API (${client.reason(r)}). Check the address (--url), and that the API is on (N8N_PUBLIC_API_DISABLED is not true).`);
  if (r.status !== 200) throw new Stop(`n8n answered ${client.reason(r)} at ${origin}. Check the address (--url) and try again.`);
  for (const { type, fields } of types) {
    const schema = await client.api('GET', `/credentials/schema/${type}`);
    if (schema.status === 404) {
      throw new Stop(`The RPA node is not installed in this n8n (it does not know the credential type ${type}). Install the package n8n-nodes-rpa (${INSTALL_DOC}), restart n8n, then run this again.`);
    }
    if (schema.status !== 200) throw new Stop(`Could not read the ${type} credential schema (${client.reason(schema)}). This needs n8n 2.41 or later.`);
    const known = Object.keys(schema.json?.properties ?? {});
    const missing = fields.filter((f) => !known.includes(f));
    if (missing.length) throw new Stop(`The installed RPA node is too old: its ${type} credential has no field ${missing.join(', ')}. Update n8n-nodes-rpa, then run this again.`);
  }
}

interface Ref { id: string; name: string }

/**
 * The credentials of this name: the one this run's project owns (mine), and those it leaves alone (others: another
 * project or user, or an owner n8n does not tell). Stops on a same-name credential of another type in the project, or
 * on two of the same name and type there (it could not tell which one is meant).
 */
function sameName(items: any[], spec: { name: string; type: string }, home: string | undefined) {
  const same = items.filter((c) => c?.name === spec.name);
  const ours = home ? same.filter((c) => ownerProject(c, 'credential') === home) : [];
  const conflict = ours.find((c) => c.type !== spec.type);
  if (conflict) throw new Stop(`A credential named "${spec.name}" (id ${conflict.id}) has the type ${conflict.type}, not ${spec.type}. Rename it in n8n, then run this again.`);
  if (ours.length > 1) throw new Stop(`Your project has ${ours.length} credentials named "${spec.name}" (ids ${ours.map((c) => c.id).join(', ')}), and this command cannot tell which one is meant. Rename or delete all but one in n8n, then run this again.`);
  return { mine: ours[0], others: same.filter((c) => !ours.includes(c)) };
}

/** One line for something of the same name that this run leaves alone. */
function leftAlone(kind: string, item: any, typeOrNothing: string, home: string | undefined) {
  const owner = ownerProject(item, kind === 'credential' ? 'credential' : 'workflow');
  const why = !home ? 'this run could not tell which project is yours'
    : owner === home ? 'the API key does not say whose it is, so this run could not tell it was yours before it made a new one'
      : owner ? 'it belongs to another project or user' : 'n8n does not say whose it is';
  say(`left alone ${kind} "${item.name}"${typeOrNothing ? ` (${typeOrNothing}, id ${item.id})` : ` (id ${item.id})`}: ${why}, so it is not used`);
}

/** The credential with this name in this run's project: reused when it is there (said so), created there when not. */
async function credential(client: Client, items: any[], home: string | undefined, projectId: string | undefined, spec: { name: string; type: string }, data: () => Record<string, unknown>, keptNote: string) {
  const { mine, others } = sameName(items, spec, home);
  for (const o of others) leftAlone('credential', o, String(o.type), home);
  if (mine) {
    say(`reused   credential "${spec.name}" (id ${mine.id}): ${keptNote}`);
    return { ref: { id: String(mine.id), name: spec.name }, created: false };
  }
  const r = await client.api('POST', '/credentials', { name: spec.name, type: spec.type, data: data(), ...(projectId ? { projectId } : {}) });
  if ((r.status !== 200 && r.status !== 201) || !r.json?.id) throw new Stop(`Could not create the credential "${spec.name}" (${client.reason(r)}).`);
  say(`created  credential "${spec.name}" (id ${r.json.id})`);
  if (others.length) say(`         n8n now has more than one credential named "${spec.name}": this run's is id ${r.json.id}. Do not pick ids ${others.map((o) => o.id).join(', ')}.`);
  return { ref: { id: String(r.json.id), name: spec.name }, created: true };
}

/** Replaces the data of a credential made earlier (n8n keeps its id, so every node that uses it keeps it). */
async function replaceData(client: Client, ref: Ref, type: string, data: Record<string, unknown>) {
  const r = await client.api('PATCH', `/credentials/${encodeURIComponent(ref.id)}`, { name: ref.name, type, data });
  if (r.status !== 200) throw new Stop(`Could not change the credential "${ref.name}" (${client.reason(r)}). Nothing else was changed.`);
}

const newPassword = () => randomBytes(24).toString('base64url'); // 32 characters
const newSigningKey = () => randomBytes(32).toString('hex'); // 64 hex characters

function loadTemplate() {
  const t = JSON.parse(readFileSync(TEMPLATE_URL, 'utf8'));
  for (const name of Object.values(NODE)) {
    if (!t.nodes.some((n: { name: string }) => n.name === name)) throw new Stop(`The template ${WORKFLOW_NAME} has no node "${name}": this package is broken, reinstall it.`);
  }
  return t;
}

/** The template's nodes, with the approver on the allowlist and an address for each form page; no credentials. */
function templateNodes(approver: string): Record<string, any>[] {
  return loadTemplate().nodes.map((node: Record<string, any>) => {
    const n: Record<string, any> = { ...node, parameters: { ...node.parameters } };
    delete n.credentials;
    // The form's address is its webhook id: n8n's editor gives one on import, the API does not.
    if (/\.(formTrigger|form)$/.test(n.type) && !n.webhookId) n.webhookId = randomUUID();
    if (n.name === NODE.signSteps) n.parameters.approverAllowlist = approver;
    return n;
  });
}

/** The nodes with this run's credentials set on the nodes that use them. */
function wire(nodes: Record<string, any>[], refs: { form: Ref; signing: Ref; browser?: Ref }) {
  return nodes.map((node) => {
    const n = { ...node };
    if (n.name === NODE.form) n.credentials = { httpBasicAuth: refs.form };
    if (n.name === NODE.signSteps) n.credentials = { [SIGNING.type]: refs.signing };
    if (n.name === NODE.importSteps && refs.browser) n.credentials = { [BROWSER.type]: refs.browser };
    return n;
  });
}

/**
 * How a workflow differs from the template, in words that repeat no parameter value: a node missing, added or of another
 * type, or a credential on a node that is not of that node's credential type in this run's project. Undefined when it
 * matches.
 */
function templateDifference(workflow: any, credentials: any[], home: string): string | undefined {
  const want = new Map<string, string>(loadTemplate().nodes.map((n: any) => [n.name, n.type]));
  const have = new Map<string, string>((Array.isArray(workflow?.nodes) ? workflow.nodes : []).map((n: any) => [String(n?.name), String(n?.type)]));
  for (const [name, type] of want) {
    if (!have.has(name)) return `it has no node "${name}"`;
    if (have.get(name) !== type) return `its node "${name}" is not a ${type} node`;
  }
  for (const name of have.keys()) if (!want.has(name)) return `it has a node "${name}" that the template does not have`;
  for (const n of workflow.nodes) {
    for (const [type, ref] of Object.entries((n?.credentials ?? {}) as Record<string, any>)) {
      const c = credentials.find((x) => x?.id !== undefined && String(x.id) === String(ref?.id));
      if (!c) return `a credential on "${n.name}" is not one this API key can see`;
      if (c.type !== type) return `a credential on "${n.name}" (id ${c.id}) is not of the type ${type}`;
      if (ownerProject(c, 'credential') !== home) return `a credential on "${n.name}" (id ${c.id}) belongs to another project or user`;
    }
  }
  return undefined;
}

async function createWorkflow(client: Client, name: string, nodes: Record<string, any>[], projectId: string | undefined): Promise<Record<string, any>> {
  const t = loadTemplate();
  const r = await client.api('POST', '/workflows', { name, nodes, connections: t.connections, settings: t.settings ?? { executionOrder: 'v1' }, ...(projectId ? { projectId } : {}) });
  if ((r.status !== 200 && r.status !== 201) || !r.json?.id) throw new Stop(`Could not create the workflow "${name}" (${client.reason(r)}).`);
  return r.json;
}

async function publish(client: Client, id: string, versionId: unknown, name: string) {
  const r = await client.api('POST', `/workflows/${encodeURIComponent(id)}/activate`, typeof versionId === 'string' ? { versionId } : undefined);
  if (r.status !== 200 || r.json?.active !== true) {
    throw new Stop(`The workflow "${name}" (id ${id}) is in n8n but not published (${client.reason(r)}). Open it in n8n and click Publish, or run this again.`);
  }
}

/** Says what a new signing key means and goes on only when the person types REPLACE at a terminal. */
async function confirmReplace() {
  const what = `A new signing key stops every bot signed with the old one (script_untrusted) until it is approved again: ${LOST_KEY_DOC}`;
  if (!interactive()) throw new Stop(`--replace-signing-key needs you at a terminal, to type REPLACE. ${what} Run it by hand. Nothing was changed.`, 2);
  say(what);
  if ((await ask('Type REPLACE to make a new key, anything else to stop: ')) !== 'REPLACE') throw new Stop('Nothing was changed.');
}

async function run(inputs: Inputs): Promise<number> {
  const { client, options, origin } = inputs;
  if (inputs.plaintext) {
    warn('WARNING: --allow-http: the API key crosses the network unencrypted.');
  }
  say(`Setting up ${origin} for RPA`);
  await checkN8n(inputs, [
    { type: SIGNING.type, fields: ['secretKey'] },
    ...(inputs.line ? [{ type: RUNNER.type, fields: ['connectionLine'] }] : []),
    ...(inputs.browser ? [{ type: BROWSER.type, fields: ['mode', 'wsUrl', 'token', 'privateNetwork'] }] : []),
  ]);

  const list = await client.listAll('/credentials');
  if (!list.ok) {
    const r = list.response;
    throw new Stop(r.status === 403 || r.status === 404
      ? 'This API key may not list credentials, so this command cannot tell what exists already. Make the API key as the owner or an admin of n8n.'
      : `Could not list the credentials (${client.reason(r)}).`);
  }
  const workflows = await client.listAll('/workflows');
  if (!workflows.ok) throw new Stop(`Could not list the workflows (${client.reason(workflows.response)}).`);

  // The project this run works in. Without --project-id, the key owner's personal project, learned from a workflow that
  // lives there; when none does, it is learned from the workflow this run makes, before any credential is chosen.
  const projectId = options.projectId;
  let home = projectId ?? (await personalProject(client, workflows.items, inputs.userId));

  // The workflow: one of this project's, of the template's name (or the dated name), that matches the template.
  const named = workflows.items.filter((w) => WORKFLOW_NAMES.test(String(w?.name ?? '')));
  const ours = home ? named.filter((w) => ownerProject(w, 'workflow') === home) : [];
  // Reported once the project is known (it may be learned from the workflow this run makes).
  const reportOthers = () => { for (const w of named.filter((x) => !ours.includes(x))) leftAlone('workflow', w, '', home); };
  let workflow: Record<string, any> | undefined;
  let differs: { id: string; name: string; why: string } | undefined;
  for (const w of [...ours].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))) {
    const r = await client.api('GET', `/workflows/${encodeURIComponent(String(w.id))}`);
    if (r.status !== 200 || !Array.isArray(r.json?.nodes)) throw new Stop(`Could not read the workflow "${w.name}" (${client.reason(r)}).`);
    // Read again, from the workflow itself: it is used only when it still belongs to this project.
    const why = ownerProject(r.json, 'workflow') !== home ? 'n8n does not say it belongs to your project' : templateDifference(r.json, list.items, home as string);
    if (!why) {
      workflow = r.json;
      break;
    }
    differs ??= { id: String(w.id), name: String(w.name), why };
  }
  if (!workflow && differs && !options.newWorkflow) {
    reportOthers();
    throw new Stop(`The workflow "${differs.name}" (id ${differs.id}) in your project differs from the template: ${differs.why}. It was not published, and the form is not ready. Rename or delete that workflow in n8n and run this again, or run this again with --new-workflow to leave it alone and make a fresh one.`);
  }

  // The approver is needed only for a workflow still to create; asked before anything is created.
  let approver = options.approver;
  if (!workflow && approver === undefined) {
    if (!interactive()) throw new Stop('Give your email address with --approver: it goes into the Approver Allowlist of Sign steps.', 2);
    approver = checkApprover(await ask('Your email address (recorded as the approver of each bot): '));
  }

  // An existing signing key is replaced only with --replace-signing-key and the typed word, asked before anything is
  // changed. Nothing else decides it: a key may sign bots this command cannot see. Only this project's key is replaced.
  if (options.replaceSigningKey && list.items.some((c) => c?.name === SIGNING.name && c?.type === SIGNING.type)) await confirmReplace();

  // A workflow to make: made first without credentials when the project is not known yet, so that its project is.
  let made: Record<string, any> | undefined;
  let nodes: Record<string, any>[] | undefined;
  let workflowName = WORKFLOW_NAME;
  if (!workflow) {
    if (differs || named.some((w) => w.name === WORKFLOW_NAME)) {
      // --new-workflow, or another project's of that name: a dated name, so that nobody confuses the two.
      const date = new Date().toISOString().slice(0, 10);
      const taken = new Set(workflows.items.map((w) => w?.name));
      workflowName = taken.has(`${WORKFLOW_NAME} (${date})`) ? `${WORKFLOW_NAME} (${date} ${new Date().toISOString().slice(11, 16).replace(':', '-')})` : `${WORKFLOW_NAME} (${date})`;
    }
    nodes = templateNodes(approver as string);
    if (!home) {
      made = await createWorkflow(client, workflowName, nodes, projectId);
      halfMade = { client, id: String(made.id) };
      const r = await client.api('GET', `/workflows/${encodeURIComponent(String(made.id))}`);
      home = r.status === 200 ? ownerProject(r.json, 'workflow') : undefined;
      if (!home) say('Note: n8n does not say which project owns the new workflow, so no credential of the same name is reused: fresh ones are made.');
    }
  }
  reportOthers();

  // The secrets made here are registered at once: from now on no output can print them by mistake.
  let formPassword: string | undefined = newPassword();
  let signingKey: string | undefined = newSigningKey();
  redactor.add(formPassword);
  redactor.add(signingKey);

  const form = await credential(client, list.items, home, projectId, FORM, () => ({ user: FORM.user, password: formPassword }),
    options.newFormPassword ? 'a new password is set below' : 'its password was made earlier and stays as it is');
  if (!form.created) {
    if (options.newFormPassword) await replaceData(client, form.ref, FORM.type, { user: FORM.user, password: formPassword });
    else formPassword = undefined;
  }

  const replaceKey = options.replaceSigningKey;
  const signing = await credential(client, list.items, home, projectId, SIGNING, () => ({ secretKey: signingKey }),
    replaceKey ? 'a new key is set below' : 'its key stays as it is');
  if (!signing.created) {
    if (replaceKey) await replaceData(client, signing.ref, SIGNING.type, { secretKey: signingKey });
    else signingKey = undefined;
  }
  // Shown when asked for on the run that made it, and always when it was replaced on purpose.
  const showKey = signingKey !== undefined && (options.showSigningKey || options.replaceSigningKey);

  if (inputs.line) {
    const line = inputs.line;
    await credential(client, list.items, home, projectId, RUNNER, () => ({ connectionLine: line }), 'its Connection Line stays as it is (to change it, paste the new line in n8n)');
  }
  let browserRef: Ref | undefined;
  if (inputs.browser) {
    const { href, token } = inputs.browser;
    browserRef = (await credential(client, list.items, home, projectId, BROWSER, () => browserCredentialData(href, token), 'its endpoint and token stay as they are')).ref;
  }

  if (workflow) {
    say(`reused   workflow "${workflow.name}" (id ${workflow.id}): it matches the template${workflow.active ? '' : ', publishing it'}`);
    if (options.approver !== undefined) say(`         its Approver Allowlist was left as it is: change it on "${NODE.signSteps}" in n8n.`);
    if (browserRef) say(`         its credentials were left as they are: pick "${BROWSER.name}" on "${NODE.importSteps}" in n8n.`);
    const usesForm = workflow.nodes.find((n: { name: string }) => n.name === NODE.form)?.credentials?.httpBasicAuth?.id;
    if (formPassword && String(usesForm) !== form.ref.id) {
      warn(`Note: the form in "${workflow.name}" does not use the credential "${FORM.name}" (id ${form.ref.id}): pick it on the node "${NODE.form}" for the new password to apply.`);
    }
  } else {
    const wired = wire(nodes as Record<string, any>[], { form: form.ref, signing: signing.ref, browser: browserRef });
    if (made) {
      const r = await client.api('PUT', `/workflows/${encodeURIComponent(String(made.id))}`, { name: workflowName, nodes: wired, connections: made.connections, settings: made.settings ?? { executionOrder: 'v1' } });
      if (r.status !== 200 || !r.json?.id) throw new Stop(`Could not set the credentials on the workflow "${workflowName}" (id ${made.id}) (${client.reason(r)}). It is not published.`);
      workflow = r.json;
      halfMade = undefined;
    } else {
      workflow = await createWorkflow(client, workflowName, wired, projectId);
    }
    workflow = workflow as Record<string, any>;
    say(`created  workflow "${workflowName}" (id ${workflow.id}), approver ${approver}`);
    const same = named.filter((w) => w.name === workflowName);
    if (same.length) say(`         n8n now has more than one workflow named "${workflowName}": this run's is id ${workflow.id}.`);
  }
  if (!workflow.active) {
    await publish(client, String(workflow.id), workflow.versionId, String(workflow.name));
    say(`published workflow "${workflow.name}"`);
  }

  const webhookId = workflow.nodes.find((n: { name: string }) => n.name === NODE.form)?.webhookId;
  const formUrl = webhookId ? `${origin}/form/${webhookId}` : undefined;
  if (formUrl) {
    // Without the login the published form answers 401: anything else means the address is not the form's. n8n
    // registers the form a moment after it publishes the workflow, so it is asked for up to 10 seconds.
    let probe: Response | undefined;
    for (let i = 0; i < 20; i++) {
      if (i) await new Promise((resolve) => setTimeout(resolve, 500));
      probe = await fetch(formUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      if (probe?.status === 401) break;
    }
    if (probe?.status !== 401) warn(`Note: the form did not answer as expected at ${formUrl} (${probe ? `HTTP ${probe.status}` : 'no answer'}). In n8n, open "${workflow.name}", then the node "${NODE.form}", for its production URL.`);
  }

  say();
  say('The import form is ready.');
  say(`  Address:    ${formUrl ?? `open "${workflow.name}" in n8n, then the node "${NODE.form}", for its production URL`}`);
  say(`  User name:  ${FORM.user}`);
  if (formPassword) reveal('  Password:   ', formPassword, '   (shown once: keep it in your password manager)');
  else say('  Password:   made earlier, n8n does not show it again. To set a new one, run this again with --new-form-password.');
  if (showKey && signingKey) reveal(`  Signing key: `, signingKey, '   (shown once: keep a copy where you keep recovery secrets)');
  else {
    if (options.showSigningKey) say('  Signing key: made earlier. n8n does not give a stored key back, so it cannot be shown, and the key was not changed.');
    say(`Your signing key is kept in n8n only ("${SIGNING.name}"), and n8n never shows it again. A lost key means approving every bot again. To keep a copy, run this again with --replace-signing-key before you approve a bot: it makes a new key and shows it. Later, see ${LOST_KEY_DOC}`);
  }
  say();
  say('Next:');
  say('  1. Record a bot, or pick a bot file you have: an RPA recording, a UiPath project, a Chrome Recorder export, Playwright code or a step document.');
  say('  2. Open the form address in your browser and sign in with the user name and password above.');
  say('  3. Upload the file, give the steps a name, and submit. On the next page, review the steps and approve them.');
  if (inputs.line) say('The Windows machine is connected: pick "RPA Desktop Runner" on the RPA node of the workflow the form gives you.');
  return 0;
}

/** A workflow this run made without credentials, until they are set: removed again when the run stops before that. */
let halfMade: { client: Client; id: string } | undefined;
async function removeHalfMade() {
  if (!halfMade) return;
  const { client, id } = halfMade;
  halfMade = undefined;
  const archived = await client.api('POST', `/workflows/${encodeURIComponent(id)}/archive`).catch(() => undefined);
  const removed = archived?.status === 200 ? await client.api('DELETE', `/workflows/${encodeURIComponent(id)}`).catch(() => undefined) : undefined;
  if (removed?.status !== 200) warn(`The workflow this run started (id ${id}) has no credentials and is not published: delete it in n8n.`);
}

async function main(): Promise<number> {
  process.title = 'n8n-nodes-rpa setup';
  let options;
  try {
    options = readOptions(process.argv.slice(2));
    if (options === 'help') {
      say(USAGE);
      return 0;
    }
    return await run(await readInputs(options, process.env));
  } catch (err) {
    if (err instanceof Stop) {
      warn(err.message);
      await removeHalfMade();
      return err.code;
    }
    await removeHalfMade();
    warn(`Setup failed: ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
