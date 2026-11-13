// `npx n8n-nodes-rpa setup`: sets an n8n up for importing a first bot, through n8n's public API. It creates the RPA Step
// Signing credential and (with a Connection Line) the RPA Desktop Runner credential, imports "RPA: 5 Import a bot" with
// those set and the approver on the allowlist, and publishes it. Without a line it picks the project's RPA Desktop
// Runner when there is exactly one (or the one --desktop-runner names), by id and name only, and asks n8n to test it
// (POST /credentials/{id}/test, n8n 2.18+, scope credential:read). The form opens with n8n's own sign-in; with
// --form-login basic it gets a Basic Auth login (a credential made here) instead. Node 22+, no dependencies:
// scripts/build-setup.mjs bundles this file, setup/n8n-api.mjs and the Connection Line parser of the node into
// dist/setup.mjs, the package's bin.
//
// Secrets: the API key and the Connection Line come from the environment or a prompt that does not echo, never from a
// flag. Every line printed passes through the redactor, which knows every secret (also a server error that echoes a
// request). The form's password (--form-login basic) is printed once, on the line that shows it; the signing key only with
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
  browserCredentialData, clean, type Client, createClient, createRedactor, isLoopback, MIN_BROWSER_TOKEN_LENGTH, parseBrowserUrl, parseN8nUrl,
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
// The names of what this command makes: --site-login names a credential it only picks, never one of these.
const OWN_NAMES = [FORM.name, SIGNING.name, RUNNER.name, BROWSER.name];
// The template's nodes that take what this command makes.
const NODE = { form: 'Import a bot', importSteps: 'Import steps', signSteps: 'Sign steps' };
const DOCS = 'https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs';
const INSTALL_DOC = `${DOCS}/reference/operator.md#install-the-node`;
const LOST_KEY_DOC = `${DOCS}/reference/security.md#if-the-signing-key-is-lost-or-changed`;
const WHERE_KEYS = 'Make an API key in n8n: Settings → n8n API → Create API key (as the owner or an admin), with Scopes All and the shortest expiry, and revoke it when the setup is done.';
/** The stricter key: only the scopes this command uses, as n8n names them under Scopes → Custom. */
const SCOPES = 'workflow:create, workflow:read, workflow:update, workflow:delete, workflow:list, workflow:activate, credential:create, credential:read, credential:update, credential:list, user:read';
const USAGE = [
  'Usage: npx n8n-nodes-rpa setup [--url <n8n address>] [--approver <email>] [options]',
  '',
  'Sets up n8n for importing a bot: the import form, which opens with your n8n sign-in, the RPA Step Signing credential,',
  `and the workflow "${WORKFLOW_NAME}", published. Run it again at any time: it reuses what is there.`,
  '',
  `  --url <address>        n8n's address (default ${DEFAULT_URL}). http:// only on this machine.`,
  '  --approver <email>     the n8n email address of the person who approves: it goes into the Approver Allowlist of Sign steps.',
  "                         Default: the API key owner's address, when n8n tells it; else it asks.",
  "  --form-login basic     give the form a user name and password (Basic Auth) instead of n8n's sign-in, for approvers",
  '                         without an n8n account. The approver is then the address on the allowlist.',
  '  --allow-http           allow http:// to another machine (the API key then crosses the network unencrypted).',
  '  --show-signing-key     print the signing key when this run makes it (n8n never gives a stored key back).',
  '  --replace-signing-key  make a new signing key and print it. Every bot signed with the old key must be approved again:',
  '                         it asks you to type REPLACE, at a terminal only.',
  '  --new-form-password    with --form-login basic: give the form a new password and print it (n8n never shows the old one again).',
  '  --browser-url <ws-url> the browser service for browser bots: creates the RPA Browser credential, with the token from',
  '                         RPA_BROWSER_TOKEN, and sets it on Import steps.',
  '  --site-login <name>    the RPA Site Login of the site your bots open, made in n8n before this runs: picks it by its name',
  '                         on Import steps and Sign steps. It is never made, read or changed here.',
  '  --desktop-runner <name>  the RPA Desktop Runner to pick on Import steps when your project has several. Without it and',
  '                         without a Connection Line, the only one your project has is picked. It is never read. With a',
  '                         Connection Line, it asks at a terminal whether to replace that credential\'s line.',
  '  --allow-private-network  turn on Allow Private Network on Import steps, for a site on this computer or your network.',
  '  --project-id <id>      the n8n project to work in (default: the API key owner\'s personal project). Only what that',
  '                         project owns is reused.',
  '  --reuse-project-credentials  in a shared project, use the credentials and the workflow of these names found there',
  '                         without asking (anyone in the project could have made them).',
  `  --new-workflow         leave a "${WORKFLOW_NAME}" that differs from the template alone and make a fresh one, with the date in its name.`,
  '',
  'Secrets never go in flags. The command asks for them, or reads them from the environment:',
  `  N8N_API_KEY            the n8n API key. ${WHERE_KEYS}`,
  `                         The stricter way, Scopes Custom with only: ${SCOPES}`,
  '  RPA_CONNECTION_LINE    the rpa-runner:// line of a Windows machine (optional): creates the RPA Desktop Runner credential,',
  '                         or, for one your project has (that name, or --desktop-runner), asks whether to replace its line.',
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
  /** How the form signs people in: n8n's own sign-in (the default), or a Basic Auth credential made here. */
  formLogin: 'n8n' | 'basic';
  allowHttp: boolean;
  showSigningKey: boolean;
  replaceSigningKey: boolean;
  newFormPassword: boolean;
  browserUrl?: string;
  /** The name of an RPA Site Login of the project, picked on Import steps and Sign steps. */
  siteLogin?: string;
  /** The name of an RPA Desktop Runner of the project, picked on Import steps. */
  desktopRunner?: string;
  allowPrivateNetwork: boolean;
  projectId?: string;
  newWorkflow: boolean;
  reuseProject: boolean;
}

function readOptions(argv: string[]): Options | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        url: { type: 'string' }, approver: { type: 'string' }, 'form-login': { type: 'string' }, 'allow-http': { type: 'boolean' }, 'show-signing-key': { type: 'boolean' },
        'replace-signing-key': { type: 'boolean' },
        'new-form-password': { type: 'boolean' }, 'browser-url': { type: 'string' }, 'project-id': { type: 'string' },
        'site-login': { type: 'string' }, 'desktop-runner': { type: 'string' }, 'allow-private-network': { type: 'boolean' },
        'new-workflow': { type: 'boolean' }, 'reuse-project-credentials': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
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
  const formLogin = values['form-login'] ?? 'n8n';
  if (formLogin !== 'n8n' && formLogin !== 'basic') throw new Stop("--form-login must be n8n (the default: n8n's own sign-in) or basic (a user name and password).", 2);
  if (values['new-form-password'] && formLogin !== 'basic') throw new Stop("--new-form-password applies only with --form-login basic: with n8n's sign-in the form has no password.", 2);
  const siteLogin = values['site-login'];
  // n8n's credential names are 3 to 128 characters. A control character could change what a printed line looks like.
  const badName = (name: string) => !name.trim() || name.length > 128 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name);
  if (siteLogin !== undefined && badName(siteLogin)) {
    throw new Stop('--site-login must be the name of an RPA Site Login as n8n shows it, such as "RPA Site Login account".', 2);
  }
  if (siteLogin !== undefined && OWN_NAMES.includes(siteLogin)) throw new Stop(`--site-login names a credential this command makes ("${siteLogin}"): give the name of your RPA Site Login.`, 2);
  const desktopRunner = values['desktop-runner'];
  // "RPA Desktop Runner" is allowed: the one an earlier run made from a Connection Line.
  if (desktopRunner !== undefined && (badName(desktopRunner) || (desktopRunner !== RUNNER.name && OWN_NAMES.includes(desktopRunner)))) {
    throw new Stop('--desktop-runner must be the name of an RPA Desktop Runner credential as n8n shows it, such as "RPA Desktop Runner account".', 2);
  }
  return {
    url: values.url ?? DEFAULT_URL,
    approver: values.approver,
    formLogin,
    allowHttp: values['allow-http'] === true,
    showSigningKey: values['show-signing-key'] === true,
    replaceSigningKey: values['replace-signing-key'] === true,
    newFormPassword: values['new-form-password'] === true,
    browserUrl: values['browser-url'],
    siteLogin,
    desktopRunner,
    allowPrivateNetwork: values['allow-private-network'] === true,
    projectId: values['project-id'],
    newWorkflow: values['new-workflow'] === true,
    reuseProject: values['reuse-project-credentials'] === true,
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
  /** When the API key expires (seconds since 1970), from the key itself: null when it never does, undefined when the key does not say. */
  keyExpires?: number | null;
  line?: string;
  browser?: { href: string; token: string };
  /** n8n's own address for its forms, when n8n's environment gives it here (formBase); undefined otherwise. */
  formBase?: string;
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
  // --desktop-runner picks one that exists: nothing to connect, unless RPA_CONNECTION_LINE gives it a new line.
  if (!line && options.desktopRunner === undefined && interactive() && /^y(es)?$/i.test(await ask('Connect a Windows machine now? (y/N) '))) {
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
  const claims = keyClaims(apiKey);
  return {
    options, origin: n8n.origin, plaintext: n8n.plaintext, client: createClient({ base: n8n.base, apiKey, redact }), ...claims, line, browser,
    formBase: formBase(env, new URL(n8n.origin).hostname),
  };
}

/**
 * n8n's own address for its forms, when this command runs where n8n does (it talks to n8n on this machine, as inside
 * n8n's container): WEBHOOK_URL, n8n's address for webhooks and forms, else N8N_EDITOR_BASE_URL. n8n's public API does
 * not tell it. Only an http(s) address without a user, a password, a query or a fragment, ending in "/"; undefined
 * otherwise. Nothing is asked of that address: the form is checked at the address this command reaches n8n at.
 */
function formBase(env: NodeJS.ProcessEnv, reachedHost: string): string | undefined {
  if (!isLoopback(reachedHost)) return undefined;
  for (const value of [env.WEBHOOK_URL, env.N8N_EDITOR_BASE_URL]) {
    const text = (value ?? '').trim();
    if (!text) continue;
    const url = URL.canParse(text) ? new URL(text) : undefined;
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) continue;
    return url.href.endsWith('/') ? url.href : `${url.href}/`;
  }
  return undefined;
}

/**
 * What an n8n API key says about itself: n8n 2.x keys are JWTs whose subject is the user's id, with an expiry (exp) when
 * the key was given one (PublicApiKeyService.generateApiKey). Read without checking the signature (n8n checks it on every
 * call); nothing for a key of any other form. Its scopes are kept in n8n, not in the key.
 */
function keyClaims(apiKey: string): { userId?: string; keyExpires?: number | null } {
  const parts = apiKey.split('.');
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const sub = payload?.sub;
    const exp = payload?.exp;
    return { userId: typeof sub === 'string' && sub ? sub : undefined, keyExpires: typeof exp === 'number' && Number.isFinite(exp) ? exp : null };
  } catch {
    return {};
  }
}

/** The API key owner's email, when n8n tells it (GET /users/{id}: the owner or an admin); undefined otherwise. */
async function keyOwnerEmail(client: Client, userId: string | undefined): Promise<string | undefined> {
  if (!userId) return undefined;
  const r = await client.api('GET', `/users/${encodeURIComponent(userId)}`).catch(() => undefined);
  const email = r?.status === 200 ? r.json?.email : undefined;
  // Only a plain address: one with a control character (it could change what a printed line looks like) is not used.
  return typeof email === 'string' && EMAIL.test(email) && clean(email, '') === email ? email : undefined;
}

/** One line about the API key, at the end of a run: what it can do, when it expires (never the key). */
function keyAdvice(keyExpires: number | null | undefined): string {
  const can = 'The API key you gave can do everything its owner can in n8n, within its scopes';
  // n8n's own labels (2.45): the place, then the action, so that the words still lead there when a label changes.
  const where = "when the setup is done: in n8n, Settings → n8n API, the key's ⋯ menu → Revoke";
  if (typeof keyExpires === 'number') return `${can}, until ${new Date(keyExpires * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC. Revoke it ${where}.`;
  // n8n sets a key's expiry only when the key is made: a key without one is revoked, or the next one made with one.
  if (keyExpires === null) return `${can}, and it never expires. Revoke it ${where}. Make the next one with an expiry.`;
  return `${can}. Revoke it ${where}. Make the next one with an expiry.`;
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

/** The project's owner entry on a workflow read with GET (it carries the project's type and creator). */
const ownerEntryProject = (json: any) => (Array.isArray(json?.shared) ? json.shared.find((s: any) => s?.role === 'workflow:owner')?.project : undefined);

/**
 * Whether this run's project is shared, and what to call it. Only the API key owner's own personal project is not
 * shared; a team project, someone else's personal project, or a project whose type n8n does not tell, is.
 */
const shared = { is: false, label: '', reuse: false, announced: false, basic: false };
function setProject(project: any, id: string, userId: string | undefined, callersOwn = false) {
  // callersOwn: the project n8n put a workflow in that this key made without a projectId, which is the key owner's own.
  const mine = callersOwn || (userId !== undefined && project?.creatorId === userId);
  shared.is = !(project?.id === id && project.type === 'personal' && mine);
  const name = clean(project?.name, '');
  shared.label = name ? `"${name}" (id ${clean(id)})` : `id ${clean(id)}`;
  if (shared.is && !shared.announced) {
    shared.announced = true;
    say(shared.basic
      ? `The project ${shared.label} is shared: everyone in it can use the form's login and the signing key this command sets up there. A personal project keeps them to one person.`
      : `The project ${shared.label} is shared: everyone in it who may run its workflows can open the form, and use the signing key this command sets up there. A personal project keeps them to one person.`);
  }
}

/** The project's details, from a workflow it owns; undefined when it owns none this key can see. */
async function projectOf(client: Client, workflows: any[], id: string) {
  const w = workflows.find((x) => ownerProject(x, 'workflow') === id);
  if (!w) return undefined;
  const r = await client.api('GET', `/workflows/${encodeURIComponent(String(w.id))}`);
  return r.status === 200 ? ownerEntryProject(r.json) : undefined;
}

/**
 * In a shared project, what was found there is used only as one set, and only when the person says so at a terminal or
 * the flag does: listed by name and id, one question. Anywhere else (the key owner's personal project) it is used.
 */
async function useFound(found: { kind: string; name: string; id: string }[]): Promise<boolean> {
  if (!shared.is || !found.length) return true;
  say(`Found in the shared project ${shared.label}:`);
  for (const f of found) say(`  ${f.kind} "${clean(f.name, f.id)}" (id ${clean(f.id)})`);
  if (shared.reuse) return true;
  if (!interactive()) {
    say('Not used: without a terminal they are used only with --reuse-project-credentials.');
    return false;
  }
  return /^y(es)?$/i.test(await ask('Use these? Anyone in that project could have made them. [y/N] '));
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
 * project or user, or an owner n8n does not tell), each said in one line. Stops on a same-name credential of another
 * type in the project, or on two of the same name and type there (it could not tell which one is meant).
 */
function sameName(items: any[], spec: { name: string; type: string }, home: string | undefined) {
  const same = items.filter((c) => c?.name === spec.name);
  const ours = home ? same.filter((c) => ownerProject(c, 'credential') === home) : [];
  const conflict = ours.find((c) => c.type !== spec.type);
  if (conflict) throw new Stop(`A credential named "${spec.name}" (id ${clean(conflict.id)}) has the type ${clean(conflict.type)}, not ${spec.type}. Rename it in n8n, then run this again.`);
  if (ours.length > 1) throw new Stop(`Your project has ${ours.length} credentials named "${spec.name}" (ids ${ours.map((c) => clean(c.id)).join(', ')}), and this command cannot tell which one is meant. Rename or delete all but one in n8n, then run this again.`);
  const others = same.filter((c) => !ours.includes(c));
  for (const o of others) leftAlone('credential', o, clean(o.type), home);
  return { mine: ours[0] as any, others };
}

/**
 * Why --site-login found nothing to pick, with the RPA Site Logins this run's project has, by name and id (cleaned).
 * Those of other projects or users were each named in a line of their own already.
 */
function noSiteLogin(name: string, items: any[], home: string | undefined): string {
  const ours = items.filter((c) => c?.type === CREDENTIALS.siteLogin && home !== undefined && ownerProject(c, 'credential') === home);
  const listed = ours.length ? `Your project's RPA Site Logins: ${ours.map((c) => `"${clean(c.name, c.id)}" (id ${clean(c.id)})`).join(', ')}.` : 'Your project has no RPA Site Login.';
  return `No RPA Site Login named "${clean(name)}" in your project. ${listed} Create it in n8n (+ → New credential → RPA Site Login), or give its name as n8n shows it. Nothing was changed.`;
}

/** This run's project's credentials of a type (the owner n8n names is that project), by id and name only. */
const projectCredentials = (items: any[], type: string, home: string | undefined) => (home === undefined ? [] : items.filter((c) => c?.type === type && ownerProject(c, 'credential') === home));
const byNameAndId = (items: any[]) => items.map((c) => `"${clean(c.name, c.id)}" (id ${clean(c.id)})`).join(', ');

/** Why --desktop-runner found nothing to pick, with the RPA Desktop Runners this run's project has, by name and id. */
function noDesktopRunner(name: string, items: any[], home: string | undefined): string {
  const ours = projectCredentials(items, CREDENTIALS.desktopRunner, home);
  const listed = ours.length ? `Your project's RPA Desktop Runners: ${byNameAndId(ours)}.` : 'Your project has no RPA Desktop Runner.';
  return `No RPA Desktop Runner named "${clean(name)}" in your project. ${listed} Give its name as n8n shows it, or leave --desktop-runner out and give the Windows machine's Connection Line instead. Nothing was changed.`;
}

/** A message from n8n fit for one printed line: control characters removed, spaces collapsed, cut at 300 characters. */
const oneLine = (text: unknown, most = 300) => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, most);

/**
 * Asks n8n to test the RPA Desktop Runner credential (POST /credentials/{id}/test): n8n runs the node's own test, which
 * connects to the Windows machine. One line with the node's message; the credential's values never leave n8n. The test
 * waits up to 60 s for a machine that does not answer, so the call may take 90 s.
 */
async function testRunner(client: Client, ref: Ref): Promise<RunnerTest> {
  const what = `credential "${clean(ref.name, ref.id)}" (id ${clean(ref.id)})`;
  say(`testing  ${what}: n8n connects to the Windows machine (up to a minute)`);
  const r = await client.api('POST', `/credentials/${encodeURIComponent(ref.id)}/test`, undefined, { timeoutMs: 90_000 }).catch(() => undefined);
  const status = r?.status === 200 ? r.json?.status : undefined;
  // The node's own message, whole: the longest ends in the command to run on the Windows machine.
  const message = oneLine(r?.json?.message, 1200);
  if (status === 'OK') {
    say(`tested   ${what}: ${message || 'OK'}`);
    return { result: 'connected', message: message || 'OK' };
  }
  if (status === 'Error') {
    say(`tested   ${what}, and it failed: ${message || 'n8n gave no reason'}`);
    return { result: 'failed', message: message || 'n8n gave no reason' };
  }
  const why = r ? client.reason(r) : 'no answer from n8n';
  const scope = r?.status === 403 ? ' For this command to test it, the API key needs the scope credential:read.' : '';
  say(`not tested ${what} (${why}). To test it, open it in n8n, which tests it as it opens.${scope}`);
  return { result: 'untested', message: `${why}.${scope}` };
}

/** What n8n's test of the RPA Desktop Runner gave, for the closing lines. */
interface RunnerTest { result: 'connected' | 'failed' | 'untested'; message: string }

/**
 * The closing lines about the Windows machine: the form is ready either way (exit 0), and whether the machine is
 * connected. A failed test's message is split into its reason (the first sentence) and what to do (the rest), when the
 * rest says what to do; else what to do is to correct the line and run this again.
 */
function closingRunner(test: RunnerTest, ref: Ref): string[] {
  const name = `"${clean(ref.name, ref.id)}"`;
  if (test.result === 'connected') return [`The import form is ready, and the Windows machine is connected. n8n's test said: ${test.message}${/[.!?]$/.test(test.message) ? '' : '.'}`];
  if (test.result === 'untested') {
    return [
      'The import form is ready. Whether the Windows machine is connected is not known: n8n did not test it.',
      `  Reason:     ${test.message}`,
      `  What to do: open the credential ${name} in n8n, which tests it as it opens.`,
    ];
  }
  // The first sentence ends at a full stop or question mark followed by a space (an address has no space after its dots).
  const cut = /^(.*?[.?])\s+(.*)$/.exec(test.message);
  const reason = cut ? cut[1] : test.message;
  const rest = cut ? cut[2].replace(/^Nothing was sent\.\s*/, '').trim() : '';
  return [
    'The import form is ready, but the Windows machine is not connected yet.',
    `  Reason:     ${reason}`,
    `  What to do: ${rest || `Correct the Connection Line of ${name}.`}`,
    '              Then run this command again, with the new line if you printed one.',
  ];
}

/** One line for something of the same name that this run leaves alone. */
function leftAlone(kind: string, item: any, typeOrNothing: string, home: string | undefined) {
  const owner = ownerProject(item, kind === 'credential' ? 'credential' : 'workflow');
  const why = !home ? 'this run could not tell which project is yours'
    : owner === home ? 'the API key does not say whose it is, so this run could not tell it was yours before it made a new one'
      : owner ? 'it belongs to another project or user' : 'n8n does not say whose it is';
  const id = clean(item.id);
  say(`left alone ${kind} "${clean(item.name, id)}"${typeOrNothing ? ` (${typeOrNothing}, id ${id})` : ` (id ${id})`}: ${why}, so it is not used`);
}

/** The credential this run uses: the one found (mine, when the run uses what it found), else one made in the project. */
async function credential(client: Client, found: { mine?: any; others: any[] }, projectId: string | undefined, spec: { name: string; type: string }, data: () => Record<string, unknown>, keptNote: string) {
  const { mine, others } = found;
  if (mine) {
    say(`reused   credential "${spec.name}" (id ${clean(mine.id)}): ${keptNote}`);
    return { ref: { id: String(mine.id), name: spec.name }, created: false };
  }
  const r = await client.api('POST', '/credentials', { name: spec.name, type: spec.type, data: data(), ...(projectId ? { projectId } : {}) });
  if ((r.status !== 200 && r.status !== 201) || !r.json?.id) throw new Stop(`Could not create the credential "${spec.name}" (${client.reason(r)}).`);
  const id = clean(r.json.id);
  say(`created  credential "${spec.name}" (id ${id})`);
  if (others.length) say(`         n8n now has more than one credential named "${spec.name}": this run's is id ${id}. Do not pick ids ${others.map((o) => clean(o.id)).join(', ')}.`);
  return { ref: { id: String(r.json.id), name: spec.name }, created: true };
}

/**
 * A Connection Line for an RPA Desktop Runner this run's project has: its line is replaced only when the person says yes
 * at a terminal, to a question that names the new line's address and port (never its token or fingerprint). Without a
 * terminal the old line stays, and it says how to replace it. Either way n8n tests the credential afterwards.
 */
async function offerLine(client: Client, ref: Ref, line: string): Promise<Ref> {
  const what = `credential "${clean(ref.name, ref.id)}" (id ${clean(ref.id)})`;
  // The address and port only: parsed by the node's own parser, which already took this line.
  const to = new URL(parseConnectionLine('runner', line).url).host;
  say(`reused   ${what}`);
  if (!interactive()) {
    say(`         its Connection Line stays as it is: this run replaces one only when you say so at a terminal. To use the line for ${to}, run this again in a terminal, or paste the line into the credential's Connection Line in n8n.`);
    return ref;
  }
  if (!/^y(es)?$/i.test(await ask(`Replace the Connection Line of "${clean(ref.name, ref.id)}" with the line for ${to}? (y/N) `))) {
    say('         its Connection Line stays as it is.');
    return ref;
  }
  await replaceData(client, ref, RUNNER.type, { connectionLine: line });
  say(`replaced Connection Line of ${what}: it now names ${to}`);
  return ref;
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

/** The form trigger's Authentication for each --form-login. */
const FORM_AUTH = { n8n: 'n8nUserAuth', basic: 'basicAuth' } as const;
/** How a workflow's form signs people in: its trigger's Authentication (a form saved without one has none). */
const formAuthentication = (workflow: any): unknown => workflow?.nodes?.find((n: any) => n?.name === NODE.form)?.parameters?.authentication;

/**
 * The template's nodes, with the approver on the allowlist and an address for each form page; no credentials. With
 * --form-login basic the form asks for Basic Auth (Sign steps then takes Approved By: its Approver follows the form).
 * With --allow-private-network, Import steps has Options → Allow Private Network on.
 */
function templateNodes(approver: string, formLogin: Options['formLogin'], allowPrivateNetwork: boolean): Record<string, any>[] {
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
    return n;
  });
}

/**
 * The nodes with this run's credentials set on the nodes that use them. Import steps also gets the signing key and the
 * desktop runner in its two "only passed on to the workflow file" slots: it never reads them, it copies their id and
 * name into the workflow file the form hands over, so that file needs nothing picked. The Site Login (--site-login) goes
 * on Import steps and Sign steps, which both use it.
 */
function wire(nodes: Record<string, any>[], refs: { form?: Ref; signing: Ref; browser?: Ref; runner?: Ref; siteLogin?: Ref }) {
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
  for (const name of have.keys()) if (!want.has(name)) return `it has a node "${clean(name)}" that the template does not have`;
  for (const n of workflow.nodes) {
    for (const [type, ref] of Object.entries((n?.credentials ?? {}) as Record<string, any>)) {
      const c = credentials.find((x) => x?.id !== undefined && String(x.id) === String(ref?.id));
      if (!c) return `a credential on "${n.name}" is not one this API key can see`;
      if (c.type !== type) return `a credential on "${n.name}" (id ${clean(c.id)}) is not of the type ${clean(type)}`;
      if (ownerProject(c, 'credential') !== home) return `a credential on "${n.name}" (id ${clean(c.id)}) belongs to another project or user`;
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
  const basic = options.formLogin === 'basic';
  shared.basic = basic;
  if (inputs.plaintext) {
    warn('WARNING: --allow-http: the API key crosses the network unencrypted.');
  }
  // One address for n8n, or two said once with what each is for: the one this command talks to (inside n8n's container,
  // n8n's own port) and the one to open in the browser (n8n's own address, formBase), which the form's address uses.
  const browserBase = inputs.formBase && inputs.formBase !== `${origin}/` ? inputs.formBase : undefined;
  say(browserBase ? `Setting up n8n for RPA. This command talks to n8n at ${origin}; in your browser, n8n is at ${browserBase}.` : `Setting up ${origin} for RPA`);
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
  shared.reuse = options.reuseProject;
  let home = projectId ?? (await personalProject(client, workflows.items, inputs.userId));
  if (projectId) setProject(await projectOf(client, workflows.items, projectId), projectId, inputs.userId);

  // The workflow: one of this project's, of the template's name (or the dated name), that matches the template.
  const named = workflows.items.filter((w) => WORKFLOW_NAMES.test(String(w?.name ?? '')));
  const ours = home ? named.filter((w) => ownerProject(w, 'workflow') === home) : [];
  // Reported once the project is known (it may be learned from the workflow this run makes).
  const reportOthers = () => { for (const w of named.filter((x) => !ours.includes(x))) leftAlone('workflow', w, '', home); };
  let workflow: Record<string, any> | undefined;
  let differs: { id: string; name: string; why: string } | undefined;
  // One that matches the template but signs people in another way (Basic Auth or n8n's sign-in) is not used.
  let otherLogin: Record<string, any> | undefined;
  for (const w of [...ours].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))) {
    const r = await client.api('GET', `/workflows/${encodeURIComponent(String(w.id))}`);
    if (r.status !== 200 || !Array.isArray(r.json?.nodes)) throw new Stop(`Could not read the workflow "${clean(w.name, w.id)}" (${client.reason(r)}).`);
    // Read again, from the workflow itself: it is used only when it still belongs to this project.
    const why = ownerProject(r.json, 'workflow') !== home ? 'n8n does not say it belongs to your project' : templateDifference(r.json, list.items, home as string);
    if (!why) {
      if (formAuthentication(r.json) === FORM_AUTH[options.formLogin]) {
        workflow = r.json;
        break;
      }
      otherLogin ??= r.json;
      continue;
    }
    differs ??= { id: String(w.id), name: String(w.name), why };
  }
  if (!workflow && otherLogin) {
    const auth = formAuthentication(otherLogin);
    const has = auth === FORM_AUTH.basic ? 'Basic Auth' : auth === FORM_AUTH.n8n ? "n8n's sign-in" : 'no sign-in';
    say(`not used workflow "${clean(otherLogin.name, otherLogin.id)}" (id ${clean(otherLogin.id)}): its form uses ${has}, and this run sets up ${basic ? 'Basic Auth (--form-login basic)' : "n8n's sign-in"}. This run makes a fresh one: unpublish the old one in n8n when you no longer use it.`);
  }
  if (!workflow && differs && !options.newWorkflow) {
    reportOthers();
    throw new Stop(`The workflow "${clean(differs.name, differs.id)}" (id ${clean(differs.id)}) in your project differs from the template: ${differs.why}. It was not published, and the form is not ready. Rename or delete that workflow in n8n and run this again, or run this again with --new-workflow to leave it alone and make a fresh one.`);
  }

  // The credentials found in the project, by name (the browser's too without --browser-url: a reused workflow may use it).
  // The Site Login (--site-login) is found the same way, and only picked: it must be there.
  const SITE = options.siteLogin !== undefined ? { name: options.siteLogin, type: CREDENTIALS.siteLogin } : undefined;
  // The RPA Desktop Runner: the one --desktop-runner names; else made from the Connection Line; else, when the project
  // has exactly one, that one, whatever its name (n8n names one made by hand "RPA Desktop Runner account"). A Connection
  // Line for one the project has may replace its line (offerLine).
  const DESKTOP = options.desktopRunner !== undefined ? { name: options.desktopRunner, type: RUNNER.type } : undefined;
  const specs = [...(basic ? [FORM] : []), SIGNING, ...(DESKTOP ? [DESKTOP] : inputs.line ? [RUNNER] : []), BROWSER, ...(SITE ? [SITE] : [])];
  // Its key in `found`: no credential name has a control character (--site-login and --desktop-runner refuse them).
  const ONLY_RUNNER = '\u0000the only RPA Desktop Runner';
  let runners: any[] = [];
  let found = new Map<string, { mine?: any; others: any[] }>();
  const findAll = () => {
    found = new Map(specs.map((spec) => [spec.name, sameName(list.items, spec, home)]));
    if (SITE && !found.get(SITE.name)?.mine) throw new Stop(noSiteLogin(SITE.name, list.items, home), 2);
    if (DESKTOP && !found.get(DESKTOP.name)?.mine) throw new Stop(noDesktopRunner(DESKTOP.name, list.items, home), 2);
    if (!inputs.line && !DESKTOP) {
      runners = projectCredentials(list.items, RUNNER.type, home);
      if (runners.length === 1) found.set(ONLY_RUNNER, { mine: runners[0], others: [] });
    }
  };
  if (home) findAll();

  // In a shared project, one answer for what was found there, as a set: all of it is used, or none of it.
  if (home) {
    const set = [...[...found].filter(([, f]) => f.mine).map(([, f]) => ({ kind: 'credential', name: String(f.mine.name), id: String(f.mine.id) })),
      ...(workflow ? [{ kind: 'workflow', name: String(workflow.name), id: String(workflow.id) }] : [])];
    if (!(await useFound(set))) {
      say(`left alone in the shared project: ${set.map((f) => `${f.kind} id ${clean(f.id)}`).join(', ')}. This run makes its own set.`);
      for (const f of found.values()) { if (f.mine) f.others.push(f.mine); f.mine = undefined; }
      workflow = undefined;
    }
  }

  // A reused workflow must use exactly this run's credentials (the form's login, the signing key, the browser): one that
  // points at any other credential of those types is not relied on, and a fresh one is made.
  if (workflow) {
    const runs: Record<string, string | undefined> = { httpBasicAuth: found.get(FORM.name)?.mine?.id, [SIGNING.type]: found.get(SIGNING.name)?.mine?.id, [BROWSER.type]: found.get(BROWSER.name)?.mine?.id };
    for (const n of workflow.nodes) {
      const required = n.name === NODE.form && basic ? 'httpBasicAuth' : n.name === NODE.signSteps ? SIGNING.type : undefined;
      for (const type of Object.keys(runs)) {
        const ref = n.credentials?.[type]?.id;
        const odd = ref !== undefined ? runs[type] === undefined || String(ref) !== String(runs[type]) : type === required;
        if (odd) {
          say(`not used workflow "${clean(workflow.name, workflow.id)}" (id ${clean(workflow.id)}): its node "${n.name}" does not use the ${type} credential this run uses. This run makes a fresh one.`);
          workflow = undefined;
          break;
        }
      }
      if (!workflow) break;
    }
  }

  // The approver is needed only for a workflow still to create: the API key owner's address when n8n tells it, else
  // asked, before anything is created.
  let approver = options.approver;
  if (!workflow && approver === undefined) {
    approver = await keyOwnerEmail(client, inputs.userId);
    if (approver) say(`approver ${approver}: the API key's owner (another with --approver)`);
    else if (!interactive()) throw new Stop('Give your email address with --approver: it goes into the Approver Allowlist of Sign steps.', 2);
    else approver = checkApprover(await ask(basic ? 'Your email address (recorded as the approver of each bot): ' : 'Your n8n email address (the approver of each bot): '));
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
      // --new-workflow, a set left alone, or another project's of that name: a dated name, so nobody confuses the two.
      const date = new Date().toISOString().slice(0, 10);
      const taken = new Set(workflows.items.map((w) => w?.name));
      workflowName = taken.has(`${WORKFLOW_NAME} (${date})`) ? `${WORKFLOW_NAME} (${date} ${new Date().toISOString().slice(11, 16).replace(':', '-')})` : `${WORKFLOW_NAME} (${date})`;
    }
    nodes = templateNodes(approver as string, options.formLogin, options.allowPrivateNetwork);
    if (!home) {
      made = await createWorkflow(client, workflowName, nodes, projectId);
      halfMade = { client, id: String(made.id) };
      const r = await client.api('GET', `/workflows/${encodeURIComponent(String(made.id))}`);
      home = r.status === 200 ? ownerProject(r.json, 'workflow') : undefined;
      // Made without a projectId, so n8n put it in the key owner's personal project: nothing to ask about there.
      if (home) setProject(ownerEntryProject(r.json), home, inputs.userId, !projectId);
      if (!home) say('Note: n8n does not say which project owns the new workflow, so no credential of the same name is reused: fresh ones are made.');
      if (!home && SITE) throw new Stop(`--site-login: n8n does not say which project owns the new workflow, so this run cannot tell that "${clean(SITE.name)}" is yours. Pick it on "${NODE.importSteps}" and "${NODE.signSteps}" in n8n instead.`);
      findAll();
      if (shared.is && !(await useFound([...found].filter(([, f]) => f.mine).map(([, f]) => ({ kind: 'credential', name: String(f.mine.name), id: String(f.mine.id) }))))) {
        for (const f of found.values()) { if (f.mine) f.others.push(f.mine); f.mine = undefined; }
      }
    }
  }
  reportOthers();

  // The secrets made here are registered at once: from now on no output can print them by mistake.
  let formPassword: string | undefined = basic ? newPassword() : undefined;
  let signingKey: string | undefined = newSigningKey();
  redactor.add(formPassword);
  redactor.add(signingKey);
  const of = (spec: { name: string }) => found.get(spec.name) ?? { others: [] };

  // The form's login: only with --form-login basic. With n8n's sign-in there is nothing to make.
  let formRef: Ref | undefined;
  if (basic) {
    const form = await credential(client, of(FORM), projectId, FORM, () => ({ user: FORM.user, password: formPassword }),
      options.newFormPassword ? 'a new password is set below' : 'its password was made earlier and stays as it is');
    formRef = form.ref;
    if (!form.created) {
      if (options.newFormPassword) await replaceData(client, form.ref, FORM.type, { user: FORM.user, password: formPassword });
      else formPassword = undefined;
    }
  }

  const replaceKey = options.replaceSigningKey;
  const signing = await credential(client, of(SIGNING), projectId, SIGNING, () => ({ secretKey: signingKey }),
    replaceKey ? 'a new key is set below' : 'its key stays as it is');
  if (!signing.created) {
    if (replaceKey) await replaceData(client, signing.ref, SIGNING.type, { secretKey: signingKey });
    else signingKey = undefined;
  }

  let runnerRef: Ref | undefined;
  if (inputs.line) {
    const line = inputs.line;
    // The line is for the RPA Desktop Runner --desktop-runner names, else for the one a line made here before.
    const had = of(DESKTOP ?? RUNNER).mine;
    if (had) runnerRef = await offerLine(client, { id: String(had.id), name: String(had.name) }, line);
    else if (DESKTOP) say(`not used credential "${clean(DESKTOP.name)}": this run does not use what it found in the shared project, so no RPA Desktop Runner is set and the line is not used. Pick one on "${NODE.importSteps}" in n8n.`);
    else runnerRef = (await credential(client, of(RUNNER), projectId, RUNNER, () => ({ connectionLine: line }), '')).ref;
  } else {
    // Picked by id and name, as n8n listed them: its values are never read.
    const pick = DESKTOP ? of(DESKTOP).mine : found.get(ONLY_RUNNER)?.mine;
    if (pick) {
      runnerRef = { id: String(pick.id), name: String(pick.name) };
      say(`picked   credential "${clean(pick.name, pick.id)}" (id ${clean(pick.id)}): ${DESKTOP ? 'the RPA Desktop Runner --desktop-runner names' : 'the only RPA Desktop Runner in your project'}`);
    } else if (DESKTOP || runners.length === 1) {
      // Found in a shared project whose set this run does not use.
      say(`not used credential "${clean(DESKTOP ? DESKTOP.name : runners[0].name)}": this run does not use what it found in the shared project, so no RPA Desktop Runner is set. Pick one on "${NODE.importSteps}" in n8n.`);
    } else if (runners.length > 1) {
      say(`not picked: your project has ${runners.length} RPA Desktop Runners, ${byNameAndId(runners)}, and this run picks one only by --desktop-runner <name>. Pick one on "${NODE.importSteps}" in n8n, so the workflow the form hands over uses it.`);
    }
  }
  let browserRef: Ref | undefined;
  if (inputs.browser) {
    const { href, token } = inputs.browser;
    browserRef = (await credential(client, of(BROWSER), projectId, BROWSER, () => browserCredentialData(href, token), 'its endpoint and token stay as they are')).ref;
  } else if (of(BROWSER).mine) {
    browserRef = { id: String(of(BROWSER).mine.id), name: BROWSER.name };
  }
  // The Site Login is only picked: by id and name, never its values. In a shared project whose set was not used, it is not.
  const siteMine = SITE ? of(SITE).mine : undefined;
  const siteRef: Ref | undefined = SITE && siteMine ? { id: String(siteMine.id), name: SITE.name } : undefined;
  if (SITE && !siteRef) say(`not used credential "${clean(SITE.name)}": this run does not use what it found in the shared project, so no Site Login is set. Pick one on "${NODE.importSteps}" and "${NODE.signSteps}" in n8n.`);

  if (workflow) {
    say(`reused   workflow "${clean(workflow.name, workflow.id)}" (id ${clean(workflow.id)}): it matches the template${workflow.active ? '' : ', publishing it'}`);
    if (options.approver !== undefined) say(`         its Approver Allowlist was left as it is: change it on "${NODE.signSteps}" in n8n.`);
    const onImport = workflow.nodes.find((n: any) => n.name === NODE.importSteps)?.credentials ?? {};
    // The runner by name and id: the one picked may have any name, and Import steps may hold another one.
    const toPick = [inputs.browser && !onImport[BROWSER.type] ? `"${BROWSER.name}"` : '', !onImport[SIGNING.type] ? `"${SIGNING.name}"` : '',
      runnerRef && String(onImport[RUNNER.type]?.id) !== runnerRef.id ? `"${clean(runnerRef.name, runnerRef.id)}" (id ${clean(runnerRef.id)})` : ''].filter(Boolean);
    if (toPick.length) say(`         its credentials were left as they are: pick ${toPick.join(', ')} on "${NODE.importSteps}" in n8n, so the workflow file the form hands over carries them.`);
    // --site-login and --allow-private-network change a workflow only when this run makes it: one it reuses is left as it is.
    const onSign = workflow.nodes.find((n: any) => n.name === NODE.signSteps)?.credentials ?? {};
    const siteOn = (creds: any) => siteRef !== undefined && String(creds?.[CREDENTIALS.siteLogin]?.id) === siteRef.id;
    const wouldSet = [
      siteRef && !(siteOn(onImport) && siteOn(onSign)) ? `pick "${clean(siteRef.name)}" (id ${clean(siteRef.id)}) on "${NODE.importSteps}" and "${NODE.signSteps}"` : '',
      options.allowPrivateNetwork && workflow.nodes.find((n: any) => n.name === NODE.importSteps)?.parameters?.options?.allowPrivateNetwork !== true
        ? `turn on Options → Allow Private Network on "${NODE.importSteps}"` : '',
    ].filter(Boolean);
    if (wouldSet.length) say(`         it was left as it is, without what you asked for: in n8n, ${wouldSet.join(', and ')}, then publish it again.`);
  } else {
    const wired = wire(nodes as Record<string, any>[], { form: formRef, signing: signing.ref, browser: browserRef, runner: runnerRef, siteLogin: siteRef });
    if (made) {
      const r = await client.api('PUT', `/workflows/${encodeURIComponent(String(made.id))}`, { name: workflowName, nodes: wired, connections: made.connections, settings: made.settings ?? { executionOrder: 'v1' } });
      if (r.status !== 200 || !r.json?.id) throw new Stop(`Could not set the credentials on the workflow "${workflowName}" (id ${clean(made.id)}) (${client.reason(r)}). It is not published.`);
      workflow = r.json;
      halfMade = undefined;
    } else {
      workflow = await createWorkflow(client, workflowName, wired, projectId);
    }
    workflow = workflow as Record<string, any>;
    say(`created  workflow "${workflowName}" (id ${clean(workflow.id)}), approver ${approver}`);
    if (siteRef) say(`         with the Site Login "${clean(siteRef.name)}" (id ${clean(siteRef.id)}) on "${NODE.importSteps}" and "${NODE.signSteps}"`);
    const same = named.filter((w) => w.name === workflowName);
    if (same.length) say(`         n8n now has more than one workflow named "${workflowName}": this run's is id ${clean(workflow.id)}.`);
  }
  // The signing key is shown only when this run made it and the workflow it ends with uses it.
  const usesKey = String(workflow.nodes?.find((n: any) => n.name === NODE.signSteps)?.credentials?.[SIGNING.type]?.id) === signing.ref.id;
  const showKey = signingKey !== undefined && usesKey && (options.showSigningKey || options.replaceSigningKey);
  if (!workflow.active) {
    await publish(client, String(workflow.id), workflow.versionId, clean(workflow.name, workflow.id));
    say(`published workflow "${clean(workflow.name, workflow.id)}"`);
  }

  // The form's webhook id comes from n8n: used only when it is an id, never printed otherwise.
  const webhookId = workflow.nodes.find((n: { name: string }) => n.name === NODE.form)?.webhookId;
  const formUrl = typeof webhookId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(webhookId) ? `${origin}/form/${webhookId}` : undefined;
  const shownName = clean(workflow.name, workflow.id);
  if (formUrl) {
    // Without a sign-in the published form answers 401 (Basic Auth), or sends the browser to n8n's sign-in (n8n's
    // sign-in: a redirect to its sign-in or authorize page): anything else means the address is not the form's. n8n
    // registers the form a moment after it publishes the workflow, so it is asked for up to 10 seconds.
    const signsIn = (r: Response | undefined) => (basic ? r?.status === 401
      : r?.status === 302 && /\/(signin|[\w-]*oauth[\w-]*\/authorize)\b/.test(r.headers.get('location') ?? ''));
    let probe: Response | undefined;
    for (let i = 0; i < 20; i++) {
      if (i) await new Promise((resolve) => setTimeout(resolve, 500));
      probe = await fetch(formUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      if (signsIn(probe)) break;
    }
    if (!signsIn(probe)) warn(`Note: the form did not answer as expected at ${formUrl} (${probe ? `HTTP ${probe.status}` : 'no answer'}). In n8n, open "${shownName}", then the node "${NODE.form}", for its production URL.`);
  }
  // Last, as it may wait a minute for a machine that does not answer: the form is ready by then.
  const runnerTest = runnerRef ? await testRunner(client, runnerRef) : undefined;

  // The address to open: n8n's own when its environment gives it here, else the one this command reached n8n at.
  const shownUrl = formUrl && inputs.formBase ? new URL(`form/${webhookId}`, inputs.formBase).href : formUrl;
  say();
  say('The import form is ready.');
  say(`  Address:    ${shownUrl ?? `open "${shownName}" in n8n, then the node "${NODE.form}", for its production URL`}`);
  if (formUrl && !inputs.formBase) say('              Replace the host and port with the ones you open n8n with, if they differ.');
  if (basic) {
    say(`  User name:  ${FORM.user}`);
    if (formPassword) reveal('  Password:   ', formPassword, '   (shown once: keep it in your password manager)');
    else say('  Password:   made earlier, n8n does not show it again. To set a new one, run this again with --new-form-password.');
  } else {
    say('  Sign-in:    the form opens with your n8n sign-in. Who approves is recorded as the n8n user who approved.');
  }
  const privateOn = workflow.nodes.find((n: any) => n.name === NODE.importSteps)?.parameters?.options?.allowPrivateNetwork === true;
  if (options.allowPrivateNetwork && privateOn) say('  Private network: on. Imports may open sites on this computer or your own network, and the workflow the form hands over has it on too.');
  if (showKey && signingKey) reveal(`  Signing key: `, signingKey, '   (shown once: keep a copy where you keep recovery secrets)');
  // Made earlier: bots may be approved with it by now, so a new key is no way to keep a copy.
  else if (signingKey === undefined) say('  Signing key: made earlier and kept in n8n, which does not show it again. A new key (--replace-signing-key) stops every bot signed with this one until it is approved again.');
  // Made now and not shown: a new key now costs nothing, as no bot is signed with this one yet.
  else say('  Signing key: made by this run and kept in n8n, which does not show it again. To have a copy, run this again now, before you approve a bot, with --replace-signing-key --show-signing-key.');
  say();
  say('Next:');
  say('  1. Record a bot, or pick a bot file you have: an RPA recording, a UiPath project, a Chrome Recorder export, Playwright code or a step document.');
  if (basic) say('  2. Open the form address in your browser and sign in with the user name and password above.');
  else say('  2. Open the form address in your browser and sign in to n8n. The first time, n8n asks whether the form may use your n8n login: choose Allow access.');
  say('  3. Upload the file, give the steps a name, and submit. On the next page, review the steps and approve them.');
  if (!basic) say(`  Only the n8n users on "${NODE.signSteps}" → Approver Allowlist may approve: add others there in n8n.`);
  // What the workflow the form hands over carries for a desktop bot: the runner on Import steps, by id and name.
  const handed = workflow.nodes?.find((n: any) => n.name === NODE.importSteps)?.credentials?.[RUNNER.type];
  if (handed?.id !== undefined && handed?.id !== null) {
    say(`The workflow the form gives you already uses the RPA Desktop Runner "${clean(handed.name, handed.id)}" (id ${clean(handed.id)}).`);
  } else if (runnerRef) {
    say(`The workflow the form gives you does not use "${clean(runnerRef.name, runnerRef.id)}" yet: pick it on "${NODE.importSteps}" in n8n (see above).`);
  } else if (!runners.length && !browserRef) {
    // Not said to a browser user: a browser bot's workflow has no runner slot.
    say('No RPA Desktop Runner is set, so a desktop bot\'s workflow asks for one. To connect a Windows machine, run this again and paste its Connection Line when it asks.');
  }
  say();
  say(keyAdvice(inputs.keyExpires));
  // Last, where a reader looks: the form is ready, and whether the Windows machine is connected. The exit code stays 0:
  // the form is set up either way.
  if (runnerTest && runnerRef) {
    say();
    for (const line of closingRunner(runnerTest, runnerRef)) say(line);
  }
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
