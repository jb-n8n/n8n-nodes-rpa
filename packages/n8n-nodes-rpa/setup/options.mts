// The setup command's flags: the usage text, reading and checking them, the names of what it makes, and what a run is
// given (Inputs).
import { parseArgs } from 'node:util';
import { CREDENTIALS } from '../nodes/Playwright/config.js';
import type { Client } from './n8n-api.mjs';
import type { Ownership } from './n8n-cli.mjs';
import { Stop } from './io.mjs';

const DEFAULT_URL = 'http://localhost:5678';
export const WORKFLOW_NAME = 'RPA: 5 Import a bot';

export const FORM = { name: 'RPA import form', type: 'httpBasicAuth', user: 'rpa' };
export const SIGNING = { name: 'RPA Step Signing', type: CREDENTIALS.signing };
export const RUNNER = { name: 'RPA Desktop Runner', type: CREDENTIALS.desktopRunner };
export const BROWSER = { name: 'RPA Browser', type: CREDENTIALS.browser };
// The names of what this command makes: --site-login names a credential it only picks, never one of these.
const OWN_NAMES = [FORM.name, SIGNING.name, RUNNER.name, BROWSER.name];

export const WHERE_KEYS = 'Make an API key in n8n: Settings → n8n API → Create API key (as the owner or an admin), with Scopes All and the shortest expiry, and revoke it when the setup is done.';
/** The stricter key: only the scopes this command uses, as n8n names them under Scopes → Custom. */
const SCOPES = 'workflow:create, workflow:read, workflow:update, workflow:delete, workflow:list, workflow:activate, credential:create, credential:read, credential:update, credential:delete, credential:list, user:read';
export const USAGE = [
  'Usage: npx n8n-nodes-rpa setup [--url <n8n address>] [--approver <email>] [options]',
  '',
  'Sets up n8n for importing a bot: the import form, which opens with your n8n sign-in, the RPA Step Signing credential,',
  `and the workflow "${WORKFLOW_NAME}", published. Run it again at any time: it reuses what is there, and offers to bring`,
  'a form it made up to date after an upgrade.',
  '',
  "Two ways in. Where n8n runs (inside n8n's container, as n8n's user), it uses n8n's own command line and needs no API key.",
  'Anywhere else, or with --api-key, it uses n8n\'s public API and an API key.',
  '',
  `  --url <address>        n8n's address (default ${DEFAULT_URL}). http:// only on this machine.`,
  '  --approver <email>     the n8n email address of the person who approves: it goes into the Approver Allowlist of Sign steps.',
  "                         Default: the API key owner's address, when n8n tells it; else it asks.",
  "  --form-login basic     give the form a user name and password (Basic Auth) instead of n8n's sign-in, for approvers",
  '                         without an n8n account. The approver is then the address on the allowlist.',
  '  --api-key              use an n8n API key (asked for, or N8N_API_KEY), also where n8n\'s command line could be used.',
  "  --no-api-key           use n8n's command line only: stop, with the reason, where that is not possible.",
  '  --allow-http           allow http:// to another machine (the API key then crosses the network unencrypted).',
  '  --show-signing-key     print the signing key when this run makes it (n8n never gives a stored key back).',
  '  --replace-signing-key  make a new signing key and print it. Every bot signed with the old key must be approved again:',
  '                         it asks you to type REPLACE, at a terminal only.',
  '  --new-form-password    with --form-login basic: give the form a new password and print it (n8n never shows the old one again).',
  '  --browser-url <ws-url> the browser service for browser bots: creates the RPA Browser credential, with the token from',
  '                         RPA_BROWSER_TOKEN, and sets it on Import steps.',
  '  --site-login <name>    the RPA Site Login of the site your bots open, made in n8n before this runs: picks it by its name',
  '                         on Import steps and Sign steps. It is never made, read or changed here.',
  '                         With --new-workflow: a form of its own for that Site Login, beside the first one, which is not',
  '                         touched. Its name and title name the Site Login, its address is /form/rpa-import-<its name>, and',
  '                         it signs with the same RPA Step Signing key.',
  '  --desktop-runner <name>  the RPA Desktop Runner to pick on Import steps when your project has several. Without it and',
  '                         without a Connection Line, the only one your project has is picked. It is never read. With a',
  '                         Connection Line, it asks at a terminal whether to replace that credential\'s line.',
  '  --allow-private-network  turn on Allow Private Network on Import steps, for a site on this computer or your network.',
  '  --project-id <id>      the n8n project to work in (default: the API key owner\'s personal project). Only what that',
  '                         project owns is reused.',
  '  --reuse-project-credentials  in a shared project, use the credentials and the workflow of these names found there',
  '                         without asking (anyone in the project could have made them).',
  `  --new-workflow         leave a "${WORKFLOW_NAME}" that differs from the template alone and make a fresh one, with the date in its name.`,
  '                         With --site-login: a second form for that Site Login (see --site-login).',
  '',
  'Secrets never go in flags. The command asks for them, or reads them from the environment:',
  `  N8N_API_KEY            the n8n API key (the API key way only). ${WHERE_KEYS}`,
  `                         The stricter way, Scopes Custom with only: ${SCOPES}`,
  '  RPA_CONNECTION_LINE    the rpa-runner:// line of a Windows machine (optional): creates the RPA Desktop Runner credential,',
  '                         or, for one your project has (that name, or --desktop-runner), asks whether to replace its line.',
  '  RPA_BROWSER_TOKEN      the browser service token, with --browser-url.',
].join('\n');

export interface Options {
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
  /** --api-key: the API key way, also where n8n's command line could be used. */
  apiKey: boolean;
  /** --no-api-key: n8n's command line only. */
  noApiKey: boolean;
}

export function readOptions(argv: string[]): Options | 'help' {
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
        'api-key': { type: 'boolean' }, 'no-api-key': { type: 'boolean' },
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
    // Never echoed: --api-key is a switch, and a key typed after it is a positional.
    const keyAfter = values['api-key'] && positionals.length > 1 ? ' --api-key takes no value: the key goes in N8N_API_KEY or the prompt, never in flags.' : '';
    throw new Stop(`${positionals.length ? 'Unknown command.' : 'Say what to do: setup.'}${keyAfter}\n\n${USAGE}`, 2);
  }
  if (values['api-key'] && values['no-api-key']) throw new Stop('Give --api-key or --no-api-key, not both.', 2);
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
    apiKey: values['api-key'] === true,
    noApiKey: values['no-api-key'] === true,
  };
}

export const EMAIL = /^[^\s@,;<>"'{}=]+@[^\s@,;<>"'{}]+\.[^\s@,;<>"'{}]+$/;
export function checkApprover(value: string): string {
  if (!EMAIL.test(value)) throw new Stop('--approver must be one email address, such as you@example.com: it is recorded as the approver of each bot.', 2);
  return value;
}

export interface Inputs {
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
  /** The way through n8n's command line: set when this run takes it. */
  cli?: { ownership: Ownership; folder: string };
}
