// `npx n8n-nodes-rpa setup`: sets an n8n up for importing a first bot, through n8n's public API. It creates the import
// form's login, the RPA Step Signing credential and (with a Connection Line) the RPA Desktop Runner credential, imports
// "RPA: 5 Import a bot" with those set and the approver on the allowlist, and publishes it. Node 22+, no dependencies:
// scripts/build-setup.mjs bundles this file, setup/n8n-api.mjs and the Connection Line parser of the node into
// dist/setup.mjs, the package's bin.
//
// Secrets: the API key and the Connection Line come from the environment or a prompt that does not echo, never from a
// flag. Every line printed passes through the redactor, which knows every secret (also a server error that echoes a
// request). The form's password is printed once, on the line that shows it; the signing key only with
// --show-signing-key. Nothing is written to a file.
//
// Run it again at any time: it lists credentials and workflows first and reuses those with the same name, saying so. n8n's
// API never returns a secret, so a second run cannot show a password made earlier: --new-form-password replaces it.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CREDENTIALS, parseConnectionLine } from '../nodes/Playwright/config.js';
import {
  browserCredentialData, type Client, createClient, createRedactor, findCredential, MIN_BROWSER_TOKEN_LENGTH, parseBrowserUrl, parseN8nUrl,
} from './n8n-api.mjs';

const DEFAULT_URL = 'http://localhost:5678';
const WORKFLOW_NAME = 'RPA: 5 Import a bot';
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
  '  --show-signing-key     print the signing key. With a key made earlier, makes a new one: do this before you approve a bot.',
  '  --new-form-password    give the form a new password and print it (n8n never shows the old one again).',
  '  --browser-url <ws-url> the browser service for browser bots: creates the RPA Browser credential, with the token from',
  '                         RPA_BROWSER_TOKEN, and sets it on Import steps.',
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
  newFormPassword: boolean;
  browserUrl?: string;
}

function readOptions(argv: string[]): Options | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        url: { type: 'string' }, approver: { type: 'string' }, 'allow-http': { type: 'boolean' }, 'show-signing-key': { type: 'boolean' },
        'new-form-password': { type: 'boolean' }, 'browser-url': { type: 'string' }, help: { type: 'boolean', short: 'h' },
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
    newFormPassword: values['new-form-password'] === true,
    browserUrl: values['browser-url'],
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
  return { options, origin: n8n.origin, plaintext: n8n.plaintext, client: createClient({ base: n8n.base, apiKey, redact }), line, browser };
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

/** The credential with this name: reused when it is there (said so), created when not. */
async function credential(client: Client, items: any[], spec: { name: string; type: string }, data: () => Record<string, unknown>, keptNote: string) {
  const { existing, conflict } = findCredential(items, spec.name, spec.type);
  if (conflict) throw new Stop(`A credential named "${spec.name}" (id ${conflict.id}) has the type ${conflict.type}, not ${spec.type}. Rename it in n8n, then run this again.`);
  if (existing) {
    say(`reused   credential "${spec.name}" (id ${existing.id}): ${keptNote}`);
    return { ref: { id: String(existing.id), name: spec.name }, created: false };
  }
  const r = await client.api('POST', '/credentials', { name: spec.name, type: spec.type, data: data() });
  if ((r.status !== 200 && r.status !== 201) || !r.json?.id) throw new Stop(`Could not create the credential "${spec.name}" (${client.reason(r)}).`);
  say(`created  credential "${spec.name}" (id ${r.json.id})`);
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

/** The template with the credentials set, the approver on the allowlist, and an address for each form page. */
function workflowBody(approver: string, refs: { form: Ref; signing: Ref; browser?: Ref }) {
  const t = loadTemplate();
  const nodes = t.nodes.map((node: Record<string, any>) => {
    const n: Record<string, any> = { ...node, parameters: { ...node.parameters } };
    // The form's address is its webhook id: n8n's editor gives one on import, the API does not.
    if (/\.(formTrigger|form)$/.test(n.type) && !n.webhookId) n.webhookId = randomUUID();
    if (n.name === NODE.form) n.credentials = { httpBasicAuth: refs.form };
    if (n.name === NODE.signSteps) {
      n.credentials = { [SIGNING.type]: refs.signing };
      n.parameters.approverAllowlist = approver;
    }
    if (n.name === NODE.importSteps && refs.browser) n.credentials = { [BROWSER.type]: refs.browser };
    return n;
  });
  return { name: t.name, nodes, connections: t.connections, settings: t.settings ?? { executionOrder: 'v1' } };
}

async function publish(client: Client, id: string, versionId: unknown) {
  const r = await client.api('POST', `/workflows/${encodeURIComponent(id)}/activate`, typeof versionId === 'string' ? { versionId } : undefined);
  if (r.status !== 200 || r.json?.active !== true) {
    throw new Stop(`The workflow "${WORKFLOW_NAME}" (id ${id}) is in n8n but not published (${client.reason(r)}). Open it in n8n and click Publish, or run this again.`);
  }
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
  const existingWorkflow = workflows.items.find((w) => w?.name === WORKFLOW_NAME);

  // The approver is needed only for a workflow still to create; asked before anything is created.
  let approver = options.approver;
  if (!existingWorkflow && approver === undefined) {
    if (!interactive()) throw new Stop('Give your email address with --approver: it goes into the Approver Allowlist of Sign steps.', 2);
    approver = checkApprover(await ask('Your email address (recorded as the approver of each bot): '));
  }

  // A new signing key makes every step list signed with the old one fail to run: it replaces a key made earlier only
  // while the form has never run. Checked before anything is changed.
  if (options.showSigningKey && existingWorkflow && findCredential(list.items, SIGNING.name, SIGNING.type).existing) {
    const ran = await client.api('GET', `/executions?workflowId=${encodeURIComponent(existingWorkflow.id)}&limit=1`);
    if (ran.status !== 200 || (Array.isArray(ran.json?.data) && ran.json.data.length > 0)) {
      throw new Stop(`The form has been used already, so a new signing key would stop every bot approved with the old one. Nothing was changed. To change the key anyway, follow ${LOST_KEY_DOC}`);
    }
  }

  // The secrets made here are registered at once: from now on no output can print them by mistake.
  let formPassword: string | undefined = newPassword();
  let signingKey: string | undefined = newSigningKey();
  redactor.add(formPassword);
  redactor.add(signingKey);

  const form = await credential(client, list.items, FORM, () => ({ user: FORM.user, password: formPassword }),
    options.newFormPassword ? 'a new password is set below' : 'its password was made earlier and stays as it is');
  if (!form.created) {
    if (options.newFormPassword) await replaceData(client, form.ref, FORM.type, { user: FORM.user, password: formPassword });
    else formPassword = undefined;
  }

  const signing = await credential(client, list.items, SIGNING, () => ({ secretKey: signingKey }),
    options.showSigningKey ? 'a new key is set below' : 'its key stays as it is');
  if (!signing.created) {
    if (options.showSigningKey) {
      await replaceData(client, signing.ref, SIGNING.type, { secretKey: signingKey });
    } else signingKey = undefined;
  }

  if (inputs.line) {
    const line = inputs.line;
    await credential(client, list.items, RUNNER, () => ({ connectionLine: line }), 'its Connection Line stays as it is (to change it, paste the new line in n8n)');
  }
  let browserRef: Ref | undefined;
  if (inputs.browser) {
    const { href, token } = inputs.browser;
    browserRef = (await credential(client, list.items, BROWSER, () => browserCredentialData(href, token), 'its endpoint and token stay as they are')).ref;
  }

  let workflow: Record<string, any>;
  if (existingWorkflow) {
    const r = await client.api('GET', `/workflows/${encodeURIComponent(existingWorkflow.id)}`);
    if (r.status !== 200 || !Array.isArray(r.json?.nodes)) throw new Stop(`Could not read the workflow "${WORKFLOW_NAME}" (${client.reason(r)}).`);
    workflow = r.json;
    say(`reused   workflow "${WORKFLOW_NAME}" (id ${workflow.id}), as it is${workflow.active ? '' : ': publishing it'}`);
    if (options.approver !== undefined) say(`         its Approver Allowlist was left as it is: change it on "${NODE.signSteps}" in n8n.`);
    if (browserRef) say(`         its credentials were left as they are: pick "${BROWSER.name}" on "${NODE.importSteps}" in n8n.`);
    const usesForm = workflow.nodes.find((n: { name: string }) => n.name === NODE.form)?.credentials?.httpBasicAuth?.id;
    if (formPassword && String(usesForm) !== form.ref.id) {
      warn(`Note: the form in "${WORKFLOW_NAME}" does not use the credential "${FORM.name}": pick it on the node "${NODE.form}" for the new password to apply.`);
    }
  } else {
    const r = await client.api('POST', '/workflows', workflowBody(approver as string, { form: form.ref, signing: signing.ref, browser: browserRef }));
    if ((r.status !== 200 && r.status !== 201) || !r.json?.id) throw new Stop(`Could not create the workflow "${WORKFLOW_NAME}" (${client.reason(r)}).`);
    workflow = r.json;
    say(`created  workflow "${WORKFLOW_NAME}" (id ${workflow.id}), approver ${approver}`);
  }
  if (!workflow.active) {
    await publish(client, String(workflow.id), workflow.versionId);
    say(`published workflow "${WORKFLOW_NAME}"`);
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
    if (probe?.status !== 401) warn(`Note: the form did not answer as expected at ${formUrl} (${probe ? `HTTP ${probe.status}` : 'no answer'}). In n8n, open "${WORKFLOW_NAME}", then the node "${NODE.form}", for its production URL.`);
  }

  say();
  say('The import form is ready.');
  say(`  Address:    ${formUrl ?? `open "${WORKFLOW_NAME}" in n8n, then the node "${NODE.form}", for its production URL`}`);
  say(`  User name:  ${FORM.user}`);
  if (formPassword) reveal('  Password:   ', formPassword, '   (shown once: keep it in your password manager)');
  else say('  Password:   made earlier, n8n does not show it again. To set a new one, run this again with --new-form-password.');
  if (signingKey && options.showSigningKey) reveal(`  Signing key: `, signingKey, '   (keep a copy where you keep recovery secrets)');
  else say(`Your signing key is kept in n8n only ("${SIGNING.name}"), n8n never shows it again, and a lost key means approving every bot again: to keep a copy, run this again with --show-signing-key before you approve a bot, or later make a new key as ${LOST_KEY_DOC} says.`);
  say();
  say('Next:');
  say('  1. Record a bot, or pick a bot file you have: an RPA recording, a UiPath project, a Chrome Recorder export, Playwright code or a step document.');
  say('  2. Open the form address in your browser and sign in with the user name and password above.');
  say('  3. Upload the file, give the steps a name, and submit. On the next page, review the steps and approve them.');
  if (inputs.line) say('The Windows machine is connected: pick "RPA Desktop Runner" on the RPA node of the workflow the form gives you.');
  return 0;
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
      return err.code;
    }
    warn(`Setup failed: ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
