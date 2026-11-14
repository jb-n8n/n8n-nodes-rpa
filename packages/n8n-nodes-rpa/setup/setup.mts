// `npx n8n-nodes-rpa setup`: sets an n8n up for importing a first bot, through n8n's public API. It creates the RPA Step
// Signing credential and (with a Connection Line) the RPA Desktop Runner credential, imports "RPA: 5 Import a bot" with
// those set and the approver on the allowlist, and publishes it. Without a line it picks the project's RPA Desktop
// Runner when there is exactly one (or the one --desktop-runner names), by id and name only, and asks n8n to test it
// (POST /credentials/{id}/test, n8n 2.18+, scope credential:read). The form opens with n8n's own sign-in; with
// --form-login basic it gets a Basic Auth login (a credential made here) instead. Node 22+, no dependencies:
// scripts/build-setup.mjs bundles this file, the modules beside it (io, options, ownership, runner, template, n8n-cli),
// setup/n8n-api.mjs and the Connection Line parser of the node into dist/setup.mjs, the package's bin. This file keeps
// what a run reads first (readInputs), the checks of n8n, and the run itself.
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
// Through n8n's command line (setup/n8n-cli.mts) the same rule holds: n8n's own tables (export:entities) name the owner,
// the owner's personal project (where n8n's import puts things by default, and this run's project unless --project-id
// names another), and each credential's and workflow's project with its role. Only what this run's project owns is
// reused; a credential merely shared into it is not.
//
// It never rewrites what is there on its own: a credential or workflow of its project with the same name is reused as it
// is, and a reused workflow must match the template (node names and types, credentials of its project) before it is
// published. Only a flag made for it changes one: --new-form-password (the form's login) and --replace-signing-key,
// which also asks for the word REPLACE at a terminal, because every bot signed with the old key stops until it is
// approved again. n8n's API never returns a secret, so a second run cannot show a password made earlier.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS, parseConnectionLine } from '../nodes/Playwright/config.js';
import { ask, askHidden, interactive, redact, redactor, reveal, say, Stop, warn } from './io.mjs';
import {
  browserCredentialData, clean, type Client, createClient, isLoopback, MIN_BROWSER_TOKEN_LENGTH, parseBrowserUrl, parseN8nUrl,
} from './n8n-api.mjs';
import { checkSameN8n, CliError, cliClient, createCli, findN8n, n8nFolderOf, removeSecretDirs, type Ownership } from './n8n-cli.mjs';
import {
  BROWSER, checkApprover, FORM, type Inputs, type Options, readOptions, RUNNER, SIGNING, USAGE, WHERE_KEYS, WORKFLOW_NAME,
} from './options.mjs';
import {
  byNameAndId, credential, keyAdvice, keyClaims, keyOwnerEmail, leftAlone, noDesktopRunner, noSiteLogin, ownerEntryProject, ownerProject,
  personalProject, projectCredentials, projectOf, type Ref, replaceData, sameName, setProject, shared, useFound,
} from './ownership.mjs';
import { closingRunner, correctLine, NO_ANSWER, offerLine, removeTrial, testRunner } from './runner.mjs';
import {
  type Changes, credentialProblem, FORM_AUTH, FORM_PATH, formAuthentication, formPathOf, formPathTaken, isOwnForm, loadTemplate, namesFor, NODE,
  siteFormName, siteFormTitle, siteSlug, structuralDifference, templateChanges, templateNodes, updatedNodes, wire, WORKFLOW_NAMES,
} from './template.mjs';

const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DOCS = 'https://github.com/jb-n8n/n8n-nodes-rpa/blob/main/docs';
const INSTALL_DOC = `${DOCS}/reference/operator.md#install-the-node`;
const LOST_KEY_DOC = `${DOCS}/reference/security.md#if-the-signing-key-is-lost-or-changed`;

/** How to reach the way without an API key, said when it is not possible. */
const CLI_HOW = "Run this as n8n's user where n8n runs, with n8n's settings (in the compose stack: docker compose exec n8n /opt/n8n-rpa/node_modules/.bin/n8n-nodes-rpa setup), or use an API key (--api-key).";

/**
 * Which way this run takes: n8n's own command line when no API key was given or asked for, the n8n command is here, and
 * it provably works on the database of the n8n that runs here (checkSameN8n); else the API key way, with the reason.
 */
function chooseWay(options: Options, env: NodeJS.ProcessEnv): { command: string; database: string } | { why: string; chosen: boolean } {
  if (options.apiKey) return { why: '--api-key was given', chosen: true };
  if ((env.N8N_API_KEY ?? '').trim()) return { why: 'N8N_API_KEY is set', chosen: true };
  const command = findN8n(env);
  if (!command) return { why: 'the command n8n is not here', chosen: false };
  // Tests give a made-up /proc: one cannot be made on another system. Whoever sets it can only fool their own run.
  const same = checkSameN8n(env, process.cwd(), env.N8N_RPA_SETUP_TEST_PROC || '/proc');
  if (!same.ok) return { why: same.why, chosen: false };
  return { command, database: same.database };
}

/** Everything typed or set before anything is sent: the address, the API key, the Connection Line, the browser. */
async function readInputs(options: Options, env: NodeJS.ProcessEnv): Promise<Inputs> {
  // Registered first, so that no message below can print them.
  for (const s of [env.N8N_API_KEY, env.RPA_CONNECTION_LINE, env.RPA_BROWSER_TOKEN]) redactor.add(s);
  const n8n = parseN8nUrl(options.url, '--url');
  if (n8n.problem !== undefined) throw new Stop(n8n.problem, 2);
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

  const way = chooseWay(options, env);
  if ('command' in way) {
    say("Setting up n8n for RPA through n8n's own command line: no API key is needed.");
    say(`  Why this way: no API key was given, the command n8n is here, and it works on the database of the n8n that runs here (${way.database}).`);
  } else if (options.noApiKey) {
    throw new Stop(`--no-api-key: n8n's command line cannot be used here: ${way.why}. ${CLI_HOW} Nothing was changed.`, 2);
  } else {
    say(way.chosen ? `This run uses an n8n API key: ${way.why}.` : `This run uses an n8n API key, because ${way.why}. Where n8n runs, as n8n's user, it needs none.`);
  }
  const cliWay = 'command' in way ? way : undefined;
  let cli: { client: Client; ownership: Ownership } | undefined;
  if (cliWay) {
    const commandLine = createCli({ command: cliWay.command, env, redact, clean });
    // Who owns what, from n8n's own tables, before anything is asked or decided: the project this run works in, and
    // which credentials and workflows that project owns (not merely has shared into it).
    let ownership: Ownership;
    try {
      ownership = await commandLine.ownership();
    } catch (err) {
      throw new Stop(`${err instanceof CliError ? err.message : `n8n's command line could not say who owns what (${clean(redact((err as Error)?.message))})`}. Use an API key (--api-key). Nothing was changed.`);
    }
    const project = options.projectId !== undefined ? ownership.projects.get(options.projectId) : ownership.ownerProject;
    if (!project) throw new Stop(`--project-id: n8n has no project with the id ${clean(options.projectId)}. Nothing was changed.`, 2);
    say(options.projectId !== undefined
      ? `  Your project: ${nameAndId(project)}, as --project-id says.`
      : `  Your project: n8n's owner's personal project ${nameAndId(project)}, where n8n's command line puts what it imports.`);
    cli = { client: cliClient(commandLine, ownership, redact, clean), ownership };
  }
  if (n8n.plaintext && !options.allowHttp && !cliWay) {
    throw new Stop(`${options.url} is http:// to another machine: the API key would cross the network unencrypted. Use n8n's https:// address, or add --allow-http if this network is yours.`, 2);
  }

  let apiKey = (env.N8N_API_KEY ?? '').trim();
  if (!apiKey && !cliWay) {
    if (!interactive()) throw new Stop(`No API key: set N8N_API_KEY (read -rs N8N_API_KEY && export N8N_API_KEY), or run this in a terminal to be asked. ${WHERE_KEYS}`, 2);
    say(WHERE_KEYS);
    apiKey = await askHidden('n8n API key (not shown): ');
    redactor.add(apiKey);
    if (!apiKey) throw new Stop('No API key given: nothing was changed.', 2);
  }

  let line = (env.RPA_CONNECTION_LINE ?? '').trim() || undefined;
  // --desktop-runner picks one that exists: nothing to connect, unless RPA_CONNECTION_LINE gives it a new line. A Site
  // Login's own form (--new-workflow --site-login) is not asked: the first form's answer stands (B6-4).
  const siteForm = options.newWorkflow && options.siteLogin !== undefined;
  if (!line && options.desktopRunner === undefined && interactive() && siteForm) {
    say("  Windows machine: not asked for a Site Login's own form. It uses your project's RPA Desktop Runner when the project has exactly one (--desktop-runner names another).");
  } else if (!line && options.desktopRunner === undefined && interactive() && /^y(es)?$/i.test(await ask('Connect a Windows machine now? (y/N) '))) {
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
  if (cliWay && cli) {
    return {
      options, origin: n8n.origin, plaintext: false, client: cli.client, line, browser, userId: cli.ownership.owner.id,
      formBase: formBase(env, new URL(n8n.origin).hostname),
      cli: { ownership: cli.ownership, folder: n8nFolderOf(env, process.cwd()) },
    };
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

const newPassword = () => randomBytes(24).toString('base64url'); // 32 characters
const newSigningKey = () => randomBytes(32).toString('hex'); // 64 hex characters

/** A project, credential or workflow as a printed line names it: its name (cleaned) in quotes, then its id. */
const nameAndId = (x: any) => `"${clean(x.name, x.id)}" (id ${clean(x.id)})`;

/** Names for one printed line: cleaned, at most eight, then how many more. */
const someNames = (names: string[]) => `${names.slice(0, 8).map((n) => `"${clean(n)}"`).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''}`;

/**
 * Says how a form this command made differs from this version's template and asks whether to update it. Default no;
 * without a terminal it asks nothing and changes nothing.
 */
async function askUpdate(workflow: any, changes: Changes): Promise<boolean> {
  const what = nameAndId(workflow);
  say(`The form ${what} was made by this command, and differs from this version's template:`);
  if (changes.added.length) say(`  Added in the template:     ${someNames(changes.added)}`);
  if (changes.removed.length) say(`  Not in the template:       ${someNames(changes.removed)}`);
  if (changes.changed.length) say(`  Set differently:           ${someNames(changes.changed)}`);
  if (changes.older.length) say(`  At an older node version:  ${someNames(changes.older)}`);
  if (changes.connections) say('  Connected differently:     the links between its nodes');
  say("An update gives it this version's nodes and connections. It keeps the Approver Allowlist, the form's sign-in, address and title, the credentials picked on its nodes, Allow Private Network, the Settings node's values, the workflow picked on Approve steps, and the workflow's name and id. Anything else changed by hand in this workflow is lost.");
  if (changes.removed.length) say(`  Lost with it: the node${changes.removed.length > 1 ? 's' : ''} ${someNames(changes.removed)}, which the template does not have.`);
  if (!interactive()) {
    say('Not updated: without a terminal this command does not ask. To update it, run this command again at a terminal and answer y.');
    return false;
  }
  return /^y(es)?$/i.test(await ask('Update this form to this version? (y/N) '));
}

/** The closing lines when a form is left as it is: whether it answers at its address, and that nothing was changed. */
async function closeUnchanged(workflow: any, inputs: Inputs) {
  const basic = formAuthentication(workflow) === FORM_AUTH.basic;
  const formNode = workflow.nodes.find((n: any) => n?.name === NODE.form);
  const webhookId = formPathOf(formNode) || formNode?.webhookId;
  const formUrl = typeof webhookId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(webhookId) ? `${inputs.origin}/form/${webhookId}` : undefined;
  const shownUrl = formUrl && inputs.formBase ? new URL(`form/${webhookId}`, inputs.formBase).href : formUrl;
  const answered = formUrl && workflow.active ? await waitForForm(formUrl, basic, 3) : undefined;
  say();
  say(`The form "${clean(workflow.name, workflow.id)}" was not changed, and nothing else was made or changed.`);
  if (answered?.ready) say(`  It is published, and answers at ${shownUrl}.`);
  else if (workflow.active) say(`  It is published${shownUrl ? `, but did not answer as expected at ${shownUrl} (${answered?.status ?? 'no answer'})` : ''}.`);
  else say('  It is not published: open it in n8n and publish it, or run this again and answer y to bring it up to date.');
}

/**
 * Asks the form's address until it answers as a published form does without a sign-in: 401 (Basic Auth), or a redirect
 * to n8n's sign-in or authorize page (n8n's sign-in). Anything else means the address is not (yet) the form's.
 */
async function waitForForm(url: string, basic: boolean, seconds: number): Promise<{ ready: boolean; status?: string; seconds: number }> {
  const signsIn = (r: Response | undefined) => (basic ? r?.status === 401
    : r?.status === 302 && /\/(signin|[\w-]*oauth[\w-]*\/authorize)\b/.test(r.headers.get('location') ?? ''));
  const start = Date.now();
  let probe: Response | undefined;
  for (let i = 0; i < seconds * 2; i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 500));
    probe = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (signsIn(probe)) return { ready: true, seconds: Math.max(1, Math.round((Date.now() - start) / 1000)) };
  }
  return { ready: false, status: probe ? `HTTP ${probe.status}` : 'no answer', seconds };
}

/**
 * The way through n8n's command line: n8n answers at the address (where the form is checked), and the RPA node is
 * installed in n8n's folder with the credential types this run writes. n8n's command line does not check a credential's
 * type or fields on import, so this does.
 */
async function checkCli(inputs: Inputs, types: { type: string; fields: string[] }[]) {
  const health = await fetch(`${inputs.origin}/healthz`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  if (health?.status !== 200) throw new Stop(`n8n does not answer at ${inputs.origin} (${health ? `HTTP ${health.status}` : 'no answer'}), where this command checks the form. Check the address (--url). Nothing was changed.`);
  const folder = (inputs.cli as NonNullable<Inputs['cli']>).folder;
  const manifest = join(folder, 'nodes', 'node_modules', 'n8n-nodes-rpa', 'package.json');
  let pkg: any;
  try {
    pkg = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : undefined;
  } catch {
    pkg = undefined;
  }
  if (!pkg) throw new Stop(`The RPA node is not installed in n8n's folder (${join(folder, 'nodes')}). Install the package n8n-nodes-rpa (${INSTALL_DOC}), restart n8n, then run this again. Nothing was changed.`);
  const files: string[] = Array.isArray(pkg?.n8n?.credentials) ? pkg.n8n.credentials : [];
  for (const { type } of types) {
    const file = `${type[0].toUpperCase()}${type.slice(1)}.credentials.js`;
    if (!files.some((f) => String(f).endsWith(`/${file}`))) {
      throw new Stop(`The RPA node installed in n8n (version ${clean(pkg.version)}) has no credential type ${type}. Update n8n-nodes-rpa, restart n8n, then run this again. Nothing was changed.`);
    }
  }
  say(`  The RPA node in n8n: version ${clean(pkg.version)}.`);
}

async function createWorkflow(client: Client, name: string, nodes: Record<string, any>[], projectId: string | undefined): Promise<Record<string, any>> {
  const t = loadTemplate();
  const r = await client.api('POST', '/workflows', { name, nodes, connections: t.connections, settings: t.settings ?? { executionOrder: 'v1' }, ...(projectId ? { projectId } : {}) });
  if ((r.status !== 200 && r.status !== 201) || !r.json?.id) throw new Stop(`Could not create the workflow "${name}" (${client.reason(r)}).`);
  return r.json;
}

async function publish(client: Client, id: string, versionId: unknown, name: string, retry?: (r: Awaited<ReturnType<Client['api']>>) => Promise<{ versionId: unknown } | undefined>) {
  const r = await client.api('POST', `/workflows/${encodeURIComponent(id)}/activate`, typeof versionId === 'string' ? { versionId } : undefined);
  if (r.status !== 200 || r.json?.active !== true) {
    // One more try, when the caller can change what n8n refused (a form path another workflow holds).
    const again = retry ? await retry(r) : undefined;
    if (again) return publish(client, id, again.versionId, name);
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
  // --new-workflow --site-login: a form of the Site Login's own, beside the first one, which this run never touches. It
  // has its own name, title and address, and signs with the same RPA Step Signing credential (never a new key).
  const siteForm = options.newWorkflow && options.siteLogin !== undefined;
  const baseName = siteForm ? siteFormName(options.siteLogin as string) : WORKFLOW_NAME;
  const slug = siteForm ? siteSlug(options.siteLogin as string) : '';
  const wantPath = !siteForm ? FORM_PATH : slug ? `${FORM_PATH}-${slug}` : undefined;
  if (inputs.plaintext) {
    warn('WARNING: --allow-http: the API key crosses the network unencrypted.');
  }
  // One address for n8n, or two said once with what each is for: the one this command talks to (inside n8n's container,
  // n8n's own port) and the one to open in the browser (n8n's own address, formBase), which the form's address uses.
  const browserBase = inputs.formBase && inputs.formBase !== `${origin}/` ? inputs.formBase : undefined;
  if (inputs.cli) {
    if (browserBase) say(`  This command checks the form at ${origin}; in your browser, n8n is at ${browserBase}.`);
  } else {
    say(browserBase ? `Setting up n8n for RPA. This command talks to n8n at ${origin}; in your browser, n8n is at ${browserBase}.` : `Setting up ${origin} for RPA`);
  }
  await (inputs.cli ? checkCli : checkN8n)(inputs, [
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

  // The workflows of this run's names: the template's name (or the dated name). A Site Login's own form is found by its
  // name, or by the Site Login's credential id on its node Import steps (the credential may have been renamed since).
  const names = siteForm ? namesFor(baseName) : WORKFLOW_NAMES;
  const siteIds = new Set(siteForm ? list.items.filter((c) => c?.type === CREDENTIALS.siteLogin && c?.name === options.siteLogin).map((c) => String(c.id)) : []);
  const carriesSite = (w: any) => String(w?.name ?? '').startsWith(WORKFLOW_NAME)
    && siteIds.has(String(w?.nodes?.find((n: any) => n?.name === NODE.importSteps)?.credentials?.[CREDENTIALS.siteLogin]?.id));
  const named = workflows.items.filter((w) => names.test(String(w?.name ?? '')) || carriesSite(w));

  // The project this run works in. Without --project-id, the key owner's personal project, learned from a workflow that
  // lives there; when none does, it is learned from the workflow this run makes, before any credential is chosen. Through
  // n8n's command line, the personal project that holds these workflows, when the person says it is theirs.
  const projectId = options.projectId;
  shared.reuse = options.reuseProject;
  // Through n8n's command line, its owner's personal project, named by n8n's own tables (readInputs): what its import uses
  // by default. A project found holding these names is never taken for this run's: what another project holds goes
  // through the same question as on the API key way.
  const own = inputs.cli?.ownership;
  let home = projectId ?? (own ? own.ownerProject.id : await personalProject(client, workflows.items, inputs.userId));
  if (own) setProject(projectId ? own.projects.get(projectId) : own.ownerProject, home as string, inputs.userId, !projectId);
  else if (projectId) setProject(await projectOf(client, workflows.items, projectId), projectId, inputs.userId);

  // The workflow: one of this project's that matches the template.
  const ours = home ? named.filter((w) => ownerProject(w, 'workflow') === home) : [];
  // Reported once the project is known (it may be learned from the workflow this run makes).
  const reportOthers = () => { for (const w of named.filter((x) => !ours.includes(x))) leftAlone('workflow', w, '', home); };
  let workflow: Record<string, any> | undefined;
  let differs: { id: string; name: string; why: string; active: boolean; own?: { json: any; changes: Changes } } | undefined;
  // One that matches the template but signs people in another way (Basic Auth or n8n's sign-in) is not used.
  let otherLogin: Record<string, any> | undefined;
  for (const w of [...ours].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))) {
    const r = await client.api('GET', `/workflows/${encodeURIComponent(String(w.id))}`);
    if (r.status !== 200 || !Array.isArray(r.json?.nodes)) throw new Stop(`Could not read the workflow "${clean(w.name, w.id)}" (${client.reason(r)}).`);
    // Read again, from the workflow itself: it is used only when it still belongs to this project.
    const notMine = ownerProject(r.json, 'workflow') !== home ? 'n8n does not say it belongs to your project' : undefined;
    const credentialWhy = notMine ?? credentialProblem(r.json, list.items, home as string);
    const changes = credentialWhy ? undefined : templateChanges(r.json);
    if (!credentialWhy && !changes) {
      if (formAuthentication(r.json) === FORM_AUTH[options.formLogin]) {
        workflow = r.json;
        break;
      }
      otherLogin ??= r.json;
      continue;
    }
    // One this command made (its name, its project, the template's three nodes, credentials of the project) that
    // differs from this version's template: it may be brought up to date (askUpdate), when it signs in as asked.
    const own = !credentialWhy && changes && isOwnForm(r.json);
    if (own && formAuthentication(r.json) !== FORM_AUTH[options.formLogin]) {
      otherLogin ??= r.json;
      continue;
    }
    differs ??= {
      id: String(w.id), name: String(w.name), active: r.json.active === true,
      why: credentialWhy ?? structuralDifference(r.json) ?? "its nodes' settings or connections differ from this version's template",
      ...(own ? { own: { json: r.json, changes } } : {}),
    };
  }
  // The form to bring up to date, when the person agrees (asked below, before anything is written).
  let updating: Changes | undefined;
  if (!workflow && differs?.own && (!options.newWorkflow || siteForm)) {
    workflow = differs.own.json;
    updating = differs.own.changes;
  }
  if (!workflow && otherLogin) {
    const auth = formAuthentication(otherLogin);
    const has = auth === FORM_AUTH.basic ? 'Basic Auth' : auth === FORM_AUTH.n8n ? "n8n's sign-in" : 'no sign-in';
    say(`not used workflow ${nameAndId(otherLogin)}: its form uses ${has}, and this run sets up ${basic ? 'Basic Auth (--form-login basic)' : "n8n's sign-in"}. This run makes a fresh one: unpublish the old one in n8n when you no longer use it.`);
  }
  if (!workflow && differs && !options.newWorkflow) {
    reportOthers();
    const state = differs.active ? 'This run changed nothing: that form is still published at its address.' : 'It is not published, and this run changed nothing.';
    throw new Stop(`The workflow ${nameAndId(differs)} in your project differs from the template: ${differs.why}. ${state} To keep its address, undo that change in n8n, or delete that workflow, and run this again. --new-workflow makes another form at a new address${options.siteLogin !== undefined ? ", with --site-login a form of that Site Login's own" : ''}.`);
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
          say(`not used workflow ${nameAndId(workflow)}: its node "${n.name}" does not use the ${type} credential this run uses. This run makes a fresh one.`);
          workflow = undefined;
          break;
        }
      }
      if (!workflow) break;
    }
  }
  if (!workflow) updating = undefined;
  // A form this command made that differs from this version's template: brought up to date only when the person says
  // yes at a terminal. Otherwise it stays exactly as it is, and nothing else is made or changed.
  if (workflow && updating && !(await askUpdate(workflow, updating))) {
    await closeUnchanged(workflow, inputs);
    return 0;
  }

  // The approver is needed only for a workflow still to create: the API key owner's address when n8n tells it, else
  // asked, before anything is created.
  let approver = options.approver;
  if (!workflow && approver === undefined) {
    approver = await keyOwnerEmail(client, inputs.userId);
    if (approver) say(`approver ${approver}: ${inputs.cli ? "n8n's owner" : "the API key's owner"} (another with --approver)`);
    else if (!interactive()) throw new Stop('Give your email address with --approver: it goes into the Approver Allowlist of Sign steps.', 2);
    else approver = checkApprover(await ask(basic ? 'Your email address (recorded as the approver of each bot): ' : 'Your n8n email address (the approver of each bot): '));
  }

  // An existing signing key is replaced only with --replace-signing-key and the typed word, asked before anything is
  // changed. Nothing else decides it: a key may sign bots this command cannot see. Only this project's key is replaced.
  if (options.replaceSigningKey && list.items.some((c) => c?.name === SIGNING.name && c?.type === SIGNING.type)) await confirmReplace();

  // A workflow to make: made first without credentials when the project is not known yet, so that its project is.
  let made: Record<string, any> | undefined;
  let nodes: Record<string, any>[] | undefined;
  // Why a workflow made here keeps the address with an id, when /form/rpa-import is not free.
  let pathTaken: string | undefined;
  let workflowName = baseName;
  if (!workflow) {
    if (differs || named.some((w) => w.name === baseName)) {
      // --new-workflow, a set left alone, or another project's of that name: a dated name, so nobody confuses the two.
      const date = new Date().toISOString().slice(0, 10);
      const taken = new Set(workflows.items.map((w) => w?.name));
      workflowName = taken.has(`${baseName} (${date})`) ? `${baseName} (${date} ${new Date().toISOString().slice(11, 16).replace(':', '-')})` : `${baseName} (${date})`;
    }
    pathTaken = wantPath ? formPathTaken(workflows.items, wantPath) : "the Site Login's name has no letters or digits for an address";
    nodes = templateNodes(approver as string, options.formLogin, options.allowPrivateNetwork, pathTaken ? undefined : wantPath, siteForm ? siteFormTitle(options.siteLogin as string) : undefined);
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
  if (siteForm) {
    // A second form signs with the key the first one uses: this run never makes another key beside one the project has.
    const keyThere = list.items.find((c) => c?.name === SIGNING.name && c?.type === SIGNING.type && (!home || ownerProject(c, 'credential') === home));
    if (!of(SIGNING).mine && keyThere) {
      throw new Stop(`A form for a Site Login signs with the RPA Step Signing key your other forms use, and this run does not use that credential (id ${clean(keyThere.id)}). In a shared project, answer y when asked, or add --reuse-project-credentials. No key or form was made.`);
    }
    if (SITE && !of(SITE).mine) throw new Stop(`A form for the Site Login "${clean(SITE.name)}" needs that credential, and this run does not use what it found in the shared project. Answer y when asked, or add --reuse-project-credentials. Nothing was made.`);
  }

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

  // A Windows machine is tested, and reported on at the end, only when this run is given one: a Connection Line, or
  // --desktop-runner. Without either (the answer n, a browser-only setup, a retired machine) nothing is said about one.
  const testsRunner = inputs.line !== undefined || DESKTOP !== undefined;
  let runnerRef: Ref | undefined;
  if (inputs.line) {
    const line = inputs.line;
    // The line is for the RPA Desktop Runner --desktop-runner names, else for the one a line made here before.
    const had = of(DESKTOP ?? RUNNER).mine;
    if (had) runnerRef = await offerLine(inputs, { id: String(had.id), name: String(had.name) }, line, projectId);
    else if (DESKTOP) say(`not used credential "${clean(DESKTOP.name)}": this run does not use what it found in the shared project, so no RPA Desktop Runner is set and the line is not used. Pick one on "${NODE.importSteps}" in n8n.`);
    else runnerRef = (await credential(client, of(RUNNER), projectId, RUNNER, () => ({ connectionLine: line }), '')).ref;
  } else {
    // Picked by id and name, as n8n listed them: its values are never read.
    const pick = DESKTOP ? of(DESKTOP).mine : found.get(ONLY_RUNNER)?.mine;
    if (pick) {
      runnerRef = { id: String(pick.id), name: String(pick.name) };
      say(`picked   credential ${nameAndId(pick)}: ${DESKTOP ? 'the RPA Desktop Runner --desktop-runner names' : 'the only RPA Desktop Runner in your project. Not tested: this run tests a Windows machine only when you give its Connection Line or name it with --desktop-runner'}`);
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

  const reused = workflow !== undefined;
  let updated = false;
  if (workflow && updating) {
    // Its nodes and connections become this version's template's, with what the person set kept (updatedNodes). The
    // public API keeps the published version live until the new one is published; n8n's command line unpublishes it
    // on import, so the publish follows at once.
    const old = workflow;
    const r = await client.api('PUT', `/workflows/${encodeURIComponent(String(old.id))}`, { name: old.name, nodes: updatedNodes(old), connections: loadTemplate().connections, settings: old.settings ?? { executionOrder: 'v1' } });
    if (r.status !== 200 || !r.json?.id) throw new Stop(`Could not update the workflow "${clean(old.name, old.id)}" (id ${clean(old.id)}) (${client.reason(r)}). ${old.active ? 'n8n keeps its published version until another is published.' : ''}`.trim());
    workflow = { ...r.json, active: inputs.cli ? false : r.json.active };
    updated = true;
    say(`updated  workflow ${nameAndId(old)}: its nodes and connections are this version's template, with what you set kept`);
  } else if (workflow) {
    say(`reused   workflow ${nameAndId(workflow)}: it matches the template${workflow.active ? '' : ', publishing it'}`);
  }
  if (workflow) {
    if (options.approver !== undefined) say(`         its Approver Allowlist was left as it is: change it on "${NODE.signSteps}" in n8n.`);
    const onImport = workflow.nodes.find((n: any) => n.name === NODE.importSteps)?.credentials ?? {};
    // The runner by name and id: the one picked may have any name, and Import steps may hold another one.
    const toPick = [inputs.browser && !onImport[BROWSER.type] ? `"${BROWSER.name}"` : '', !onImport[SIGNING.type] ? `"${SIGNING.name}"` : '',
      runnerRef && String(onImport[RUNNER.type]?.id) !== runnerRef.id ? nameAndId(runnerRef) : ''].filter(Boolean);
    if (toPick.length) say(`         its credentials were left as they are: pick ${toPick.join(', ')} on "${NODE.importSteps}" in n8n, so the workflow file the form hands over carries them.`);
    // --site-login and --allow-private-network change a workflow only when this run makes it: one it reuses is left as it is.
    const onSign = workflow.nodes.find((n: any) => n.name === NODE.signSteps)?.credentials ?? {};
    const siteOn = (creds: any) => siteRef !== undefined && String(creds?.[CREDENTIALS.siteLogin]?.id) === siteRef.id;
    const wouldSet = [
      siteRef && !(siteOn(onImport) && siteOn(onSign)) ? `pick "${clean(siteRef.name)}" (id ${clean(siteRef.id)}) on "${NODE.importSteps}" and "${NODE.signSteps}"` : '',
      options.allowPrivateNetwork && workflow.nodes.find((n: any) => n.name === NODE.importSteps)?.parameters?.options?.allowPrivateNetwork !== true
        ? `turn on Options → Allow Private Network on "${NODE.importSteps}"` : '',
    ].filter(Boolean);
    if (wouldSet.length) say(`         ${updated ? 'what it had was kept' : 'it was left as it is'}, without what you asked for: in n8n, ${wouldSet.join(', and ')}, then publish it again.`);
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
    if (pathTaken) say(`         its form keeps an address with an id${wantPath ? `, not /form/${wantPath}` : ''}: ${pathTaken}.`);
    const same = named.filter((w) => w.name === workflowName);
    if (same.length) say(`         n8n now has more than one workflow named "${workflowName}": this run's is id ${clean(workflow.id)}.`);
  }
  // The signing key is shown only when this run made it and the workflow it ends with uses it.
  const usesKey = String(workflow.nodes?.find((n: any) => n.name === NODE.signSteps)?.credentials?.[SIGNING.type]?.id) === signing.ref.id;
  const showKey = signingKey !== undefined && usesKey && (options.showSigningKey || options.replaceSigningKey);
  let publishedNow = false;
  if (!workflow.active || updated) {
    const made = workflow;
    // A form path held by a workflow this API key cannot see: n8n refuses to publish. The form then keeps the address
    // with its webhook id, and the run says why.
    const dropPath = !reused && wantPath !== undefined && formPathOf(made.nodes.find((n: any) => n.name === NODE.form)) === wantPath
      ? async (r: Awaited<ReturnType<Client['api']>>) => {
        if (!/already taken|conflict with one of the webhooks/i.test(client.reason(r))) return undefined;
        const without = made.nodes.map((n: any) => (n.name === NODE.form ? { ...n, parameters: { ...n.parameters, options: Object.fromEntries(Object.entries(n.parameters?.options ?? {}).filter(([k]) => k !== 'path')) } } : n));
        const put = await client.api('PUT', `/workflows/${encodeURIComponent(String(made.id))}`, { name: made.name, nodes: without, connections: made.connections, settings: made.settings ?? { executionOrder: 'v1' } });
        if (put.status !== 200 || !put.json?.id) return undefined;
        workflow = put.json;
        say(`         its form keeps an address with an id, not /form/${wantPath}: n8n says that address is taken (${client.reason(r)}).`);
        return { versionId: put.json.versionId };
      }
      : undefined;
    await publish(client, String(made.id), made.versionId, clean(made.name, made.id), dropPath);
    workflow = workflow as Record<string, any>;
    say(`published workflow "${clean(workflow.name, workflow.id)}"`);
    publishedNow = true;
  }

  // The form's address: its Form Path (rpa-import, set here) or its webhook id, which comes from n8n. Used only when it is
  // a plain id, never printed otherwise.
  const formNode = workflow.nodes.find((n: { name: string }) => n.name === NODE.form);
  const webhookId = formPathOf(formNode) || formNode?.webhookId;
  const formUrl = typeof webhookId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(webhookId) ? `${origin}/form/${webhookId}` : undefined;
  const shownName = clean(workflow.name, workflow.id);
  // n8n registers the form a moment after it publishes the workflow; through n8n's command line, the running n8n
  // notices the publish by itself, within about 5 to 20 seconds.
  if (formUrl && inputs.cli && publishedNow) say("waiting  for the form to answer: the running n8n takes up to half a minute to notice a publish through its command line");
  const answered = formUrl ? await waitForForm(formUrl, basic, inputs.cli ? 40 : 10) : undefined;
  if (formUrl && answered?.ready && inputs.cli && publishedNow) say(`answered the form, after ${answered.seconds} s`);
  if (formUrl && !answered?.ready) warn(`Note: the form did not answer as expected at ${formUrl} (${answered?.status ?? 'no answer'}). ${inputs.cli ? 'Check that the n8n at this address is the one that runs here (--url), and its log. ' : ''}In n8n, open "${shownName}", then the node "${NODE.form}", for its production URL.`);
  const ready = formUrl === undefined || answered?.ready === true;
  const formSays = ready ? 'The import form is ready' : 'The import form is published, but it did not answer at its address yet';
  // Last, as it may wait a minute for a machine that does not answer: the form is ready by then.
  let runnerTest = runnerRef && testsRunner ? await testRunner(inputs, runnerRef) : undefined;
  // No answer, at a terminal: one chance to paste a corrected line now, instead of running the whole command again.
  if (runnerRef && runnerTest?.result === 'failed' && NO_ANSWER.test(runnerTest.message) && interactive() && (await correctLine(client, runnerRef))) {
    runnerTest = await testRunner(inputs, runnerRef);
  }

  // The address to open: n8n's own when its environment gives it here, else the one this command reached n8n at.
  const shownUrl = formUrl && inputs.formBase ? new URL(`form/${webhookId}`, inputs.formBase).href : formUrl;
  say();
  say(`${formSays}.`);
  say(`  Address:    ${shownUrl ?? `open "${shownName}" in n8n, then the node "${NODE.form}", for its production URL`}`);
  if (formUrl && !inputs.formBase) say('              Replace the host and port with the ones you open n8n with, if they differ.');
  if (siteForm && siteRef) say(`  Site Login: "${clean(siteRef.name)}". Use this form for the bots that sign in with it. Your other import form is not changed.`);
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
  else say('  Signing key: made by this run and kept in n8n, which does not show it again. Most people need no copy: it is for moving signed bots to another n8n, or for a lost n8n. To have one, run this again now, before you approve a bot, with --replace-signing-key --show-signing-key.');
  say();
  say('Next:');
  say('  1. Record a bot, or pick a bot file you have: an RPA recording, a UiPath project, a Chrome Recorder export, Playwright code or a step document.');
  if (basic) say('  2. Open the form address in your browser and sign in with the user name and password above.');
  else say('  2. Open the form address in your browser and sign in to n8n. The first time, n8n asks whether the form may use your n8n login: choose Allow access.');
  say('  3. Upload the file, give the steps a name, and submit. On the next page, review the steps and approve them.');
  if (!basic) say(`  Only the n8n users on "${NODE.signSteps}" → Approver Allowlist may approve: add others there in n8n.`);
  // What the workflow the form hands over carries for a desktop bot: the runner on Import steps, by id and name.
  const handed = workflow.nodes?.find((n: any) => n.name === NODE.importSteps)?.credentials?.[RUNNER.type];
  const handsOther = handed?.id !== undefined && handed?.id !== null && runnerRef !== undefined && String(handed.id) !== runnerRef.id;
  if (handsOther && runnerRef) {
    say(`The workflow the form gives you uses the RPA Desktop Runner ${nameAndId(handed)}, not ${nameAndId(runnerRef)}, which this run ${runnerTest && runnerTest.result !== 'untested' ? 'tested' : 'picked'}: to hand that one over, pick it on "${NODE.importSteps}" in n8n.`);
  } else if (handed?.id !== undefined && handed?.id !== null) {
    say(`The workflow the form gives you already uses the RPA Desktop Runner ${nameAndId(handed)}.`);
  } else if (runnerRef) {
    say(`The workflow the form gives you does not use "${clean(runnerRef.name, runnerRef.id)}" yet: pick it on "${NODE.importSteps}" in n8n (see above).`);
  } else if (!runners.length && !browserRef) {
    // Not said to a browser user: a browser bot's workflow has no runner slot.
    say('No RPA Desktop Runner is set, so a desktop bot\'s workflow asks for one. To connect a Windows machine, run this again and paste its Connection Line when it asks.');
  }
  if (!inputs.cli) {
    say();
    say(keyAdvice(inputs.keyExpires));
  }
  // Last, where a reader looks: the form is ready, and whether the Windows machine is connected. The exit code stays 0:
  // the form is set up either way.
  if (runnerTest && runnerRef) {
    say();
    for (const line of closingRunner(runnerTest, runnerRef, formSays, handsOther)) say(line);
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
  // n8n's command line cannot delete a workflow: the person does, in n8n.
  if (removed?.status !== 200) warn(`The workflow this run started (id ${id}) has no credentials and is not published: delete it in n8n.`);
}

/** Stopped by a signal (Ctrl-C while n8n is asked something): what this run started is removed first, then it exits. */
function onSignals() {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    process.once(signal, () => {
      removeSecretDirs();
      warn('Stopped.');
      Promise.allSettled([removeTrial(), removeHalfMade()]).finally(() => process.exit(code));
    });
  }
}

async function main(): Promise<number> {
  process.title = 'n8n-nodes-rpa setup';
  onSignals();
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
      await removeTrial();
      await removeHalfMade();
      return err.code;
    }
    await removeTrial();
    await removeHalfMade();
    warn(`Setup failed: ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
