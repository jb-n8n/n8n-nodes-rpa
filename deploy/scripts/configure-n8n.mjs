#!/usr/bin/env node
// Configures an n8n for the RPA browser service through n8n's public API (n8n 2.41 or later): creates the RPA Browser
// credential (Browser Server mode) and imports the templates. Node 22+, no dependencies.
//
//   read -rs N8N_API_KEY && export N8N_API_KEY      # paste the key, then Enter
//   export RPA_BROWSER_TOKEN="$(...)"               # from the Secret or Secrets Manager (n8n_settings.notes)
//   node deploy/scripts/configure-n8n.mjs --n8n-url <url> --endpoint <ws-url> [--templates <dir>] [--project-id <id>]
//
// Secrets come from the environment only, never from flags (flags land in shell history and process lists). Neither the
// token nor the API key is ever printed: every line of output passes through redact(), which also covers server errors
// that echo the request body.
//
// Idempotent: it lists the credentials and workflows first and skips any with the same name, reporting them. n8n's
// public API lists credentials only for the instance owner and admins (scope credential:list); without that it creates
// no credential, because it could not tell a duplicate, and says so.
//
// What n8n 2.41 needs (packages/cli/src/public-api/v1, tag n8n@2.41.0):
// - POST /api/v1/credentials {name, type, data}: the type must be loaded (a community type once its package is
//   installed), and data is checked against the JSON schema GET /api/v1/credentials/schema/{type} returns
//   (additionalProperties false; no field of the RPA Browser credential is required).
// - POST /api/v1/workflows {name, nodes, connections, settings}: additionalProperties false at the workflow and node
//   level, so only those four keys are sent.
// - Both POSTs take an optional projectId (CreateCredentialPublicDto, CreateWorkflowPublicDto); without it n8n uses
//   the API key owner's personal project. GET /api/v1/workflows filters by projectId.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const CREDENTIAL_NAME = 'RPA Browser';
// Stored identifiers (never renamed): the credential type and the mode value of Browser Server.
const CREDENTIAL_TYPE = 'playwrightBrowserApi';
const BROWSER_SERVER_MODE = 'playwright';
const NODE_PACKAGE = 'n8n-nodes-rpa';
const TEMPLATE_FILES = ['0-connection-check.json', '1-create-tables.json', '2-data-feed.json', '3-approve-steps.json', 'hello-world.json'];
const DEFAULT_TEMPLATES = fileURLToPath(new URL('../../packages/n8n-nodes-rpa/templates/', import.meta.url));
const MIN_TOKEN_LENGTH = 32; // the gate refuses a shorter token
const PAGE_LIMIT = 250; // the public API's maximum
const MAX_PAGES = 400;
const TIMEOUT_MS = 30_000;
const USAGE = [
  'Usage: node deploy/scripts/configure-n8n.mjs --n8n-url <url> --endpoint <ws-url> [--templates <dir>] [--project-id <id>]',
  '  with N8N_API_KEY and RPA_BROWSER_TOKEN exported, never typed inline (shell history):',
  '    read -rs N8N_API_KEY && export N8N_API_KEY      # paste the key, then Enter',
  '    export RPA_BROWSER_TOKEN="$(...)"               # from the Secret or Secrets Manager (the n8n_settings notes)',
  '  --n8n-url     n8n\'s base URL (https://, or http:// on this machine)',
  '  --endpoint    the browser service\'s ws:// or wss:// address (the browser_endpoint output)',
  '  --templates   the templates directory (default: packages/n8n-nodes-rpa/templates)',
  '  --project-id  the n8n project to create the credential and the workflows in (default: the API key owner\'s personal project)',
].join('\n');

const secrets = [];
/** Replaces every secret, and its URL-encoded and JSON-escaped forms, with ***. */
function redact(text) {
  let out = String(text);
  for (const s of secrets) {
    for (const form of new Set([s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)])) out = out.split(form).join('***');
  }
  return out;
}
const say = (line = '') => process.stdout.write(`${redact(line)}\n`);
const warn = (line) => process.stderr.write(`${redact(line)}\n`);

class UsageError extends Error {}

/** localhost, 127.0.0.0/8 or ::1: http:// there never leaves the machine. */
function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

function readConfig(argv, env) {
  // Registered first, so that no message below can print them.
  for (const s of [env.N8N_API_KEY, env.RPA_BROWSER_TOKEN]) if (s) secrets.push(s);
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'n8n-url': { type: 'string' }, endpoint: { type: 'string' }, templates: { type: 'string' }, 'project-id': { type: 'string' }, help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    // Never echo the arguments: someone may have passed a secret as a flag (--token ..., --api-key ...).
    const flag = /'(--?[A-Za-z0-9-]+)/.exec(String(err.message))?.[1];
    throw new UsageError(`${flag ? `Unknown option ${flag}.` : 'Unexpected argument.'} Secrets go in N8N_API_KEY and RPA_BROWSER_TOKEN, never in flags.\n${USAGE}`);
  }
  if (values.help) return { help: true };

  const n8nUrl = values['n8n-url'];
  let n8n;
  try { n8n = n8nUrl && /^https?:\/\/[^\s'"]+$/.test(n8nUrl) ? new URL(n8nUrl) : null; } catch { n8n = null; }
  if (!n8n) throw new UsageError(`--n8n-url must be n8n's http(s) base URL, for example https://n8n.example.com.\n${USAGE}`);
  if (n8n.username || n8n.password) throw new UsageError('--n8n-url must not carry a user or password: the API key goes in N8N_API_KEY.');
  if (n8n.search || n8n.hash) throw new UsageError('--n8n-url must not carry a query or fragment.');
  const projectId = values['project-id'];
  if (projectId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new UsageError('--project-id must be an n8n project id (letters, digits, _ and -).');
  let endpoint;
  try { endpoint = new URL(values.endpoint ?? ''); } catch { endpoint = null; }
  if (!endpoint || (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:')) {
    throw new UsageError(`--endpoint must be the browser service's ws:// or wss:// address (the browser_endpoint output).\n${USAGE}`);
  }
  if (endpoint.username || endpoint.password || endpoint.search) throw new UsageError('--endpoint must not carry a user, password or query: the token goes in RPA_BROWSER_TOKEN.');

  const apiKey = env.N8N_API_KEY ?? '';
  if (!apiKey.trim()) throw new UsageError(`N8N_API_KEY is not set. Create an API key in n8n (Settings -> n8n API), as the owner or an admin, and export it.\n${USAGE}`);
  const token = env.RPA_BROWSER_TOKEN ?? '';
  if (!token) throw new UsageError(`RPA_BROWSER_TOKEN is not set. Read the gate token into it (the n8n_settings notes show how), never paste it into a flag.\n${USAGE}`);
  if (token.length < MIN_TOKEN_LENGTH) throw new UsageError(`RPA_BROWSER_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters; the browser service refuses such a token.`);

  const templatesDir = values.templates ?? DEFAULT_TEMPLATES;
  const missing = TEMPLATE_FILES.filter((f) => !existsSync(join(templatesDir, f)));
  if (missing.length) throw new UsageError(`${templatesDir} is missing ${missing.join(', ')}.`);
  const templates = TEMPLATE_FILES.map((file) => {
    let t;
    try { t = JSON.parse(readFileSync(join(templatesDir, file), 'utf8')); } catch (err) { throw new UsageError(`${file} is not valid JSON: ${err.message}`); }
    if (typeof t.name !== 'string' || !Array.isArray(t.nodes) || typeof t.connections !== 'object') throw new UsageError(`${file} is not an n8n workflow.`);
    return { file, template: t };
  });

  const base = `${n8n.origin}${n8n.pathname.replace(/\/+$/, '')}/api/v1`;
  return { help: false, base, plaintext: n8n.protocol === 'http:' && !isLoopback(n8n.hostname), endpoint: endpoint.href, apiKey, token, templates, projectId };
}

/** One public API call. Never throws on an HTTP status; throws only on a network failure (message redacted). */
async function api(cfg, method, path, body) {
  let res;
  try {
    res = await fetch(`${cfg.base}${path}`, {
      method,
      headers: { 'X-N8N-API-KEY': cfg.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error', // never replay the API key to another host
    });
  } catch (err) {
    throw new Error(redact(`${method} ${cfg.base}${path} failed: ${err.cause?.code ?? err.cause?.message ?? err.message}`));
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

/** The server's error message, redacted and cut short; never the raw body of a credential request. */
function reason(r) {
  const message = typeof r.json?.message === 'string' ? r.json.message : r.text;
  return redact(`HTTP ${r.status}${message ? `: ${message.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
}

/** Every item of a paginated list (cursor pagination), or the failing response. */
async function listAll(cfg, path, filter = {}) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ ...filter, limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) });
    const r = await api(cfg, 'GET', `${path}?${query}`);
    if (r.status !== 200 || !Array.isArray(r.json?.data)) return { ok: false, response: r };
    items.push(...r.json.data);
    cursor = r.json.nextCursor;
    if (!cursor) return { ok: true, items };
  }
  return { ok: false, response: { status: 0, json: { message: `more than ${MAX_PAGES} pages` }, text: '' } };
}

const project = (cfg) => (cfg.projectId ? { projectId: cfg.projectId } : {});

async function configureCredential(cfg) {
  // The schema endpoint answers 404 for a type n8n has not loaded: the community package is not installed (yet).
  const schema = await api(cfg, 'GET', `/credentials/schema/${CREDENTIAL_TYPE}`);
  if (schema.status === 404) {
    return { fatal: `n8n does not know the credential type ${CREDENTIAL_TYPE}: install the ${NODE_PACKAGE} community package on the main instance and every worker, restart n8n, then run this again.` };
  }
  if (schema.status === 401) return { fatal: `n8n refused the API key (${reason(schema)}). Check N8N_API_KEY.` };
  if (schema.status !== 200) return { fatal: `Could not read the ${CREDENTIAL_TYPE} credential schema (${reason(schema)}). Is this n8n 2.41 or later with the public API on?` };
  const data = { mode: BROWSER_SERVER_MODE, wsUrl: cfg.endpoint, token: cfg.token, privateNetwork: new URL(cfg.endpoint).protocol === 'ws:' };
  const known = Object.keys(schema.json?.properties ?? {});
  const unknown = Object.keys(data).filter((k) => !known.includes(k));
  if (unknown.length) return { fatal: `The installed ${NODE_PACKAGE} has no credential field ${unknown.join(', ')}: update the package, or this script.` };

  const list = await listAll(cfg, '/credentials');
  if (!list.ok) {
    const r = list.response;
    const why = r.status === 403 || r.status === 404
      ? 'the API key may not list credentials (scope credential:list, the owner or an admin only)'
      : `listing credentials failed (${reason(r)})`;
    return { failed: `Credential "${CREDENTIAL_NAME}" not created: ${why}, so this script cannot tell whether it exists already. Rerun with an owner or an admin API key, or create it in n8n: Mode Browser Server, Endpoint URL ${cfg.endpoint}, Private Network Endpoint ${data.privateNetwork ? 'on' : 'off'}, Token = RPA_BROWSER_TOKEN.` };
  }
  // With --project-id, only a credential shared with that project counts (the list item's shared[].id).
  const inProject = (c) => !cfg.projectId || (Array.isArray(c?.shared) && c.shared.some((p) => p?.id === cfg.projectId));
  const existing = list.items.find((c) => c?.name === CREDENTIAL_NAME && inProject(c));
  if (existing && existing.type !== CREDENTIAL_TYPE) {
    return { failed: `A credential named "${CREDENTIAL_NAME}" (id ${existing.id}) exists with type ${existing.type}, not ${CREDENTIAL_TYPE}. Rename it in n8n, then run this again.` };
  }
  if (existing) return { line: `exists   credential "${CREDENTIAL_NAME}" (id ${existing.id}); its endpoint and token were left as they are` };
  const created = await api(cfg, 'POST', '/credentials', { name: CREDENTIAL_NAME, type: CREDENTIAL_TYPE, data, ...project(cfg) });
  if (created.status !== 200 && created.status !== 201) return { failed: `Credential "${CREDENTIAL_NAME}" not created: ${reason(created)}` };
  return { line: `created  credential "${CREDENTIAL_NAME}" (id ${created.json?.id ?? '?'}): Browser Server, ${cfg.endpoint}` };
}

async function importTemplates(cfg) {
  const list = await listAll(cfg, '/workflows', cfg.projectId ? { projectId: cfg.projectId } : {});
  if (!list.ok) return { lines: [], failed: [`Templates not imported: listing workflows failed (${reason(list.response)}).`] };
  const names = new Set(list.items.map((w) => w?.name));
  const lines = [];
  const failed = [];
  for (const { file, template } of cfg.templates) {
    if (names.has(template.name)) {
      lines.push(`exists   workflow "${template.name}"`);
      continue;
    }
    // Only the keys POST /workflows accepts; credentials are left for the user to pick.
    const nodes = template.nodes.map(({ credentials: _credentials, ...node }) => node);
    const body = { name: template.name, nodes, connections: template.connections, settings: template.settings ?? { executionOrder: 'v1' }, ...project(cfg) };
    const r = await api(cfg, 'POST', '/workflows', body);
    if (r.status !== 200 && r.status !== 201) failed.push(`Workflow "${template.name}" (${file}) not imported: ${reason(r)}`);
    else {
      names.add(template.name);
      lines.push(`created  workflow "${template.name}" (id ${r.json?.id ?? '?'})`);
    }
  }
  return { lines, failed };
}

async function main() {
  let cfg;
  try {
    cfg = readConfig(process.argv.slice(2), process.env);
  } catch (err) {
    if (err instanceof UsageError) {
      warn(err.message);
      return 2;
    }
    throw err;
  }
  if (cfg.help) {
    say(USAGE);
    return 0;
  }

  if (cfg.plaintext) {
    warn('WARNING: --n8n-url is http:// to another machine: the API key and the browser token cross the network unencrypted. Use https://.');
  }
  say(`Configuring ${cfg.base.replace(/\/api\/v1$/, '')}${cfg.projectId ? ` (project ${cfg.projectId})` : ''} for the RPA browser service at ${cfg.endpoint}`);
  const failures = [];
  const credential = await configureCredential(cfg);
  if (credential.fatal) {
    warn(credential.fatal);
    return 1;
  }
  if (credential.line) say(credential.line);
  if (credential.failed) failures.push(credential.failed);

  const workflows = await importTemplates(cfg);
  for (const line of workflows.lines) say(line);
  failures.push(...workflows.failed);

  say();
  say('Next, in n8n:');
  say(`1. Open "RPA: 0 Connection check", pick the "${CREDENTIAL_NAME}" credential on the RPA node, replace the URL in "Site to check" with your login page, and run it. The screenshot proves the browser service reaches the site.`);
  say('2. Run "RPA: 1 Create tables (run once)" once: it creates the two Data Tables.');
  say(`3. In "RPA: 2 Data feed", "RPA: 3 Approve steps" and "RPA: Hello world", pick the credentials on each node (the sticky notes list them). The imported workflows are inactive.`);
  if (failures.length) {
    say();
    for (const f of failures) warn(`NOT DONE: ${f}`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => { warn(`configure-n8n failed: ${err?.message ?? err}`); process.exitCode = 1; },
);
