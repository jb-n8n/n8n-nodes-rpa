import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IMPORT_EMPTY, IMPORT_NEEDS_SITE_LOGIN, IMPORT_NOT_ADOPTABLE, IMPORT_PROOF_FAILED, IMPORT_REFUSES_WRITES, IMPORT_UNSUPPORTED_TARGET,
} from 'n8n-rpa-engine';
import { GUIDANCE } from '../nodes/Playwright/errors.js';
import { RUN_TABLE_COLUMNS, STEPS_TABLE_COLUMNS } from '../nodes/Playwright/rows.js';

const root = new URL('../../../', import.meta.url);
const readme = readFileSync(new URL('README.md', root), 'utf8');
const USE_CASE_WORDS = /\b(portal|recall|notice|dealer)s?\b/i;

const HEADINGS = [
  'What it is', 'Hello world in 10 minutes', 'Operations', 'Where the browser runs', 'Safety model', 'Locators',
  'ID Pattern in 60 seconds', 'Run Steps reference', 'The self-healing data feed', 'Error codes',
  'Migrating from toema/n8n-playwright', 'Operator guidance', 'Development',
].map((h) => `## ${h}`);

/** The text of one `## ` section, without its heading. */
function section(heading: string): string {
  const start = readme.indexOf(`\n${heading}\n`);
  expect(start, `${heading} exists`).toBeGreaterThan(-1);
  const rest = readme.slice(start + heading.length + 2);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The text of one `### ` subsection of the Operations section. */
function operation(name: string): string {
  const s = section('## Operations');
  const start = s.indexOf(`\n### ${name}\n`);
  expect(start, `### ${name} exists`).toBeGreaterThan(-1);
  const rest = s.slice(start + name.length + 6);
  const end = rest.search(/\n### /);
  return end === -1 ? rest : rest.slice(0, end);
}

// Hard-coded (not imported): the README must say exactly what the node says.
const GOLDEN_MESSAGES = [
  'Could not connect to the browser server at ws://browser:3000/. Is it running? Start it with: docker compose up -d browser (README: Where the browser runs).',
  'The browser server is version X but this node needs Y. Use image mcr.microsoft.com/playwright:vY.',
  'Chromium not found. Run: npx playwright install chromium',
  'URL must start with http:// or https:// (got "file:").',
  'Blocked: intranet.example resolves to a private network address. Turn on Options → Allow Private Network if this site is on your own network.',
  'Blocked: the page tried to open cdn.other.com, which is not allowed. This run only visits example.com. Add it under Options → Also Allow These Sites if this is expected.',
  'No element found for Visible Text "Sign In" on https://example.com/account after 30 s. Check the spelling or try Find by: Role and Name.',
  'Visible Text "Submit" matches 3 elements. Use a more specific locator; it must match exactly one.',
  'The steps are not signed, or the signature is not valid, and Require Signed Steps is on. Sign them with Sign Steps first.',
  'Expected 120 rows (the page says "120 results") but found 117. Nothing was marked successful.',
  'A previous login for example.com failed, so no login was tried.',
];
const TOKEN_REFUSED = 'The browser server at ws://browser:3000/ refused the token. Check the Token in the RPA Browser credential.';

describe('README', () => {
  it('has the 13 sections in order', () => {
    expect(readme.match(/^## .+$/gm)).toEqual(HEADINGS);
  });

  it('gets a person to a first screenshot: one-command start, credential fields, template file', () => {
    const s = section('## Hello world in 10 minutes');
    for (const text of [
      'openssl rand -hex 32', 'BROWSER_TOKEN', 'docker compose up --build -d', 'docker compose up -d browser',
      'http://localhost:5678', 'http://localhost:8025', 'ws://browser:3000/', 'Private Network Endpoint',
      'Connected to the browser server (1.63)', '+ → New credential → RPA Browser', '**Mode**: Browser Server', 'Connection tested successfully', 'templates/hello-world.json', 'docker-compose.dev.yml', 'SKU-1001', TOKEN_REFUSED,
    ]) expect(s, text).toContain(text);
  });

  it('documents the six templates by file name and workflow name', () => {
    const s = section('## The self-healing data feed');
    for (const [f, name] of [['0-connection-check.json', 'RPA: 0 Connection check'], ['1-create-tables.json', 'RPA: 1 Create tables (run once)'],
      ['2-data-feed.json', 'RPA: 2 Data feed'], ['3-approve-steps.json', 'RPA: 3 Approve steps'], ['5-import-a-bot.json', 'RPA: 5 Import a bot'],
      ['hello-world.json', 'RPA: Hello world']]) {
      expect(s, f).toContain(`| \`${f}\` | \`${name}\` |`);
    }
    expect(s).toContain('packages/n8n-nodes-rpa/templates/');
  });

  it('points to deploy/ for running the browser service at scale, with the configure script, the connection check, the kind check and the runbooks', () => {
    const s = section('## Where the browser runs');
    const at = s.slice(s.indexOf('**Deploy at scale.**'));
    expect(s).toContain('**Deploy at scale.**');
    for (const text of ['`deploy/`', '`deploy/helm/rpa-browser`', '`deploy/terraform/modules/k8s-browser`', '`deploy/terraform/modules/aws-ecs-browser`',
      '`deploy/terraform/examples/`', '`deploy/scripts/configure-n8n.mjs`', 'N8N_API_KEY', 'RPA_BROWSER_TOKEN', '`0-connection-check.json`', 'queue mode',
      '`deploy/test/kind-e2e.sh`', '[`docs/deploy/kubernetes.md`](docs/deploy/kubernetes.md)', '[`docs/deploy/aws-ecs.md`](docs/deploy/aws-ecs.md)',
      'scales on session use (ECS, or Kubernetes with KEDA and Prometheus) or on CPU']) {
      expect(at, text).toContain(text);
    }
  });

  it('names every operation with its action text, in order', () => {
    const s = section('## What it is');
    const names = ['Screenshot', 'Get Page', 'Save as PDF', 'Extract Data', 'Fill and Submit Form', 'Download File', 'Run Steps', 'Sign Steps', 'Import Steps'];
    const at = names.map((n) => s.indexOf(`| **${n}** |`));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const text of ['Take a screenshot of a page', 'Get the text, HTML or title of a page', 'Save a page as PDF', 'Extract a table or list from a page',
      'Fill in and submit a form', 'Download a file from a page', 'Run a list of browser steps', 'Sign a repaired step list',
      'Import steps from a recording, code or a UiPath bot']) expect(s).toContain(text);
    expect(s).toContain('Nine operations, in this order:');
    for (const n of names) expect(section('## Operations'), n).toMatch(new RegExp(`^### ${n}$`, 'm'));
  });

  it('states the quick-operation rules: no templates in the URL, no trace output field, binary file names', () => {
    const s = section('## Operations');
    for (const text of ['URL must not contain {{ }} templates', 'Put Output in Field must not be "trace"', '`screenshot.png`', '`pdf.pdf`']) {
      expect(s, text).toContain(text);
    }
    expect(operation('Download File')).toContain('`status` is `null`');
  });

  it('checks a stated total only when Stated Total Pattern is set', () => {
    const s = operation('Extract Data');
    for (const text of ['Stated Total Pattern', 'confirmed', 'only']) expect(s, text).toContain(text);
    expect(s).toMatch(/`confirmed` is `true` only when/);
  });

  it('warns about Fill and Submit Form: typed values in the trace, echoed values, submitted false, text fields only', () => {
    const s = operation('Fill and Submit Form');
    for (const text of ['Debug Trace', 'Never', 'sensitive form data', 'echo', '`submitted: false`', 'text fields', 'selects and checkboxes']) {
      expect(s, text).toContain(text);
    }
  });

  it('explains where the browser runs: compose, docker run, hosted, local, version matching, ws rules', () => {
    const s = section('## Where the browser runs');
    for (const text of ['docker compose up -d browser', 'BROWSER_TOKEN', 'Private Network Endpoint', 'docker run', 'Browserless',
      'Local Browser', 'npx playwright install chromium', 'mcr.microsoft.com/playwright:v1.63.0', 'wss://', '.env.example', 'docker-compose.dev.yml',
      'images/browser/gate', 'ws://browser:3000/', 'playwright-core', 'Playwright protocol', 'show-trace', TOKEN_REFUSED]) {
      expect(s, text).toContain(text);
    }
  });

  it('prints the browser service from the real docker-compose.yml', () => {
    const compose = readFileSync(new URL('docker-compose.yml', root), 'utf8');
    const s = section('## Where the browser runs');
    const yaml = /```yaml\n([\s\S]*?)```/.exec(s)?.[1];
    expect(yaml, 'a yaml block').toBeDefined();
    const lines = (yaml ?? '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && l.trim() !== '...');
    for (const line of lines) expect(compose, line).toContain(line);
    // Both ways and in order: the README's lines are the real browser service, contiguous, with nothing left out.
    const service = /^  browser:\n(?:(?: {4}.*)?\n)+/m.exec(compose)?.[0] ?? '';
    const real = service.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(lines).toEqual(real);
  });

  it('says where address checks run: remote DNS views, c-ares for wildcard-only names, split DNS fails closed', () => {
    const s = section('## Where the browser runs');
    for (const text of ['proxy', 'DNS', 'c-ares', '/etc/hosts', 'split-DNS', 'fail closed', 'Allowed Hosts']) expect(s, text).toContain(text);
  });

  it('has a safety table covering every operation group and the accepted risks', () => {
    const s = section('## Safety model');
    for (const text of ['Screenshot, Get Page, Save as PDF, Extract Data, Download File', 'Fill and Submit Form', 'Run Steps, unsigned, no Site Login',
      'Run Steps with a Site Login', 'Sign Steps', 'Allow Private Network', 'Require Signed Steps', 'Allow Unsigned Writes', 'Deliver Unconfirmed Rows',
      'One shared signing key', 'GET side effects', 'images or canvas', 'Closed shadow roots', 'blockedRequests']) expect(s, text).toContain(text);
  });

  it('six literal-only settings (the reset key among them), a row for signed Run Steps without a Site Login, the unsigned file wildcard', () => {
    const s = section('## Safety model');
    expect(s).toContain('Six settings must be set directly');
    expect(s).toContain("Run Steps' **Login Breaker Reset Key**");
    expect(s).toContain("Sign Steps' **Approver Allowlist**");
    expect(s).toContain('| Run Steps, signed, no Site Login |');
    const unsigned = s.split('\n').find((l) => l.startsWith('| Run Steps, unsigned, no Site Login |')) ?? '';
    expect(unsigned).toContain('may come from any public site when **Also Allow These Sites** is empty');
    expect(readme).toContain('A sub-workflow call is its own execution, with its own repair.');
  });

  it('the SAP guidance says what listing an endpoint gives up, what * matches, and what the evidence shows', () => {
    const s = section('## Safety model');
    const header = s.split('\n').find((l) => l.startsWith('On one page.')) ?? '';
    expect(header).toContain('**Requests That Only Read**');
    expect(header).toContain('on trust');
    const row = s.split('\n').find((l) => l.startsWith('| Run Steps with a Site Login |')) ?? '';
    expect(row).toContain('what they send is not checked');
    for (const text of [
      // item 1: honest about SAP
      'On SAP these endpoints also carry saves', 'Save and Post included', '`$batch` change sets', 'no write protection for it',
      'display-only authorizations', '`POST sap.example.com/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch`', 'covers every OData service on the host',
      // item 3: what * matches
      'letters, digits and `_ . ( ) = ~ -`', '`%3D`', '`ZSRV;v=0002`',
      // item 4: login pages are exact
      'exact host/path the browser shows', 'per-session `/sap(…)/` path cannot be listed', 'Check this on your own SAP system',
      // item 7: the evidence
      'The approval evidence lists the read-only entries the proof run used', 'Sign Steps checks them against the RPA Site Login',
    ]) expect(s, text).toContain(text);
    expect(s).not.toContain('any text inside one part of the path');
    expect(s).not.toContain('POST sap.example.com/sap/opu/odata/sap/*/$batch');
  });

  it('AI-built steps extract IDs only, and rejected Repaired steps can come back unchanged on their own row', () => {
    const limits = section('## Run Steps reference');
    const first = limits.slice(limits.indexOf('**Known limits.**')).split('\n')[1];
    expect(first).toBe('- AI-built and AI-repaired steps extract IDs only; rows from those steps carry `id` and no other fields. Write the extract step yourself (Extract Data or Run Steps fields) when you need record content; repair then refuses to rewrite field extraction.');
    expect(section('## The self-healing data feed')).toContain('Rejected Repaired steps can come back unchanged if the next repair produces the same steps; they reuse their row');
  });

  it('Fill and Submit says its steps need Variables and that Run Steps blocks the submit POST', () => {
    const s = section('### Fill and Submit Form');
    for (const text of ['does not run unchanged in Run Steps', '**Options → Variables**', 'no write window', 'a `submit` step']) expect(s, text).toContain(text);
  });

  it('teaches locators and how to find them', () => {
    const s = section('## Locators');
    for (const text of ['Visible Text', 'Form Label', 'Role and Name', 'Test ID', 'CSS Selector', 'Exact Match', 'exactly one', 'Inspect', 'Copy selector']) {
      expect(s, text).toContain(text);
    }
  });

  it('gives the four ID Pattern examples', () => {
    const s = section('## ID Pattern in 60 seconds');
    for (const text of ['INV-\\d{4}-\\d{5}', '[A-Z]{2}\\d{6}', '\\d+', '.+', 'regex101.com']) expect(s, text).toContain(text);
  });

  it('references every Run Steps verb and field', () => {
    const s = section('## Run Steps reference');
    for (const verb of ['goto', 'click', 'check', 'fill', 'select', 'clickAll', 'waitFor', 'paginate', 'extract', 'extractTable', 'screenshot', 'pdf', 'read',
      'download', 'submit', 'signIn', 'popup', 'detect']) expect(s, verb).toContain(`\`${verb}\``);
    for (const text of ['Require Signed Steps', 'Expected Version', 'Variables', '{{var.name}}', 'AI Repair', 'Allow Unsigned Writes']) expect(s, text).toContain(text);
  });

  it('lists the Run Steps Data fields, durationMs and llmTokens included', () => {
    const s = section('## Run Steps reference');
    expect(s).toContain('{ url, title, status, name, version, hash, lane, confirmed, llmCalls, durationMs, llmTokens, log, rows?, files?, blockedRequests?, submitted? }');
  });

  it('states the AI Repair limits: data feeds only, refused after a write, one repair per execution for every Run Steps node', () => {
    const s = section('## Run Steps reference');
    for (const text of ['screenshot, PDF, read and table steps', '`submit`', '`download.via`', 'after a write', 'one repair per workflow execution',
      'every Run Steps node', 'AI repair already ran in this execution']) {
      expect(s, text).toContain(text);
    }
  });

  it('documents file checks and quotes the download repair messages verbatim (hard-coded, as the node says them)', () => {
    const s = section('## Run Steps reference');
    for (const text of ['**File checks.**', '`check.name`', '`check.minBytes`', '`check.columns`', '`check.minRows`', 'download check failed:', 'Expected File (First Version)',
      'AI repair of a download needs exactly one download step, outside paginate, and no extract step.',
      'AI repair of a download needs a check on the download step that names the file or its columns (check.name or check.columns).',
      'AI repair works only on steps that extract rows or download one file: remove screenshot, PDF, read and table steps, or turn AI Repair off',
      'A first run needs either an ID Pattern (to read rows) or an Expected File with a file name pattern or required columns (to download a file), not both.',
      'the repaired steps did not pass the proof, so the downloaded file was not delivered',
      'the repaired steps did not pass the proof, so the rows were not delivered (turn on Options → Deliver Unconfirmed Rows to receive them)',
      'Deliver Unconfirmed Rows** never releases a file', '{{var.name}}', 'the Repaired steps item has file evidence that does not match its steps',
      'no date-range check']) {
      expect(s, text).toContain(text);
    }
  });

  it('documents both Data Tables column by column', () => {
    const s = section('## The self-healing data feed');
    for (const c of [...STEPS_TABLE_COLUMNS, ...RUN_TABLE_COLUMNS]) expect(s, c.name).toContain(`| \`${c.name}\` |`);
    for (const t of ['playwright_steps', 'playwright_runs']) expect(s).toContain(t);
    for (const status of ['pending', 'active', 'rejected', 'expired']) expect(s).toContain(`\`${status}\``);
  });

  it('describes the data feed as the templates ship it: stated total, full safety flags, escaped review email', () => {
    const s = section('## The self-healing data feed');
    for (const text of ['Showing \\d+-\\d+ of (\\d+)', 'every host, form submission, download and pop-up handler', 'not their intents', 'HTML-escape', 'safety flags first']) expect(s, text).toContain(text);
  });

  it('explains every error code and prints every golden message', () => {
    const s = section('## Error codes');
    for (const code of Object.keys(GUIDANCE)) expect(s, code).toContain(`| \`${code}\` |`);
    expect(Object.keys(GUIDANCE)).toHaveLength(12);
    for (const m of GOLDEN_MESSAGES) expect(s, m).toContain(m);
    for (const text of ['configError: true', 'details', 'output 2', '`llmTokens`']) expect(s, text).toContain(text);
  });

  it('maps toema/n8n-playwright verbs to operations and says why there is no JavaScript step', () => {
    const s = section('## Migrating from toema/n8n-playwright');
    for (const text of ['Navigate', 'Screenshot', 'Get Text', 'Click, Fill', 'Custom Script', 'Run Steps', 'JavaScript', 'signed']) expect(s, text).toContain(text);
  });

  it('tells operators about breaker, lock, queue mode, shutdown, binary data and installing', () => {
    const s = section('## Operator guidance');
    for (const text of ['Login Breaker Reset Key', 'manual executions', 'Queue mode', 'N8N_GRACEFUL_SHUTDOWN_TIMEOUT', 'docker/n8n.Dockerfile',
      'Sites It May Load Files From', 'Sites Allowed in Embedded Frames']) expect(s, text).toContain(text);
    expect(readme).toContain('**RPA Redis** (optional; needed in queue mode with a Site Login)');
  });

  it('queue mode: EXECUTIONS_MODE on every process, a narrow Redis ACL user, no allkeys eviction, no Cluster, the trip-recording edge', () => {
    const s = section('## Operator guidance');
    for (const text of ['`EXECUTIONS_MODE=queue` on every n8n process', '~playwrightGuard:*', '+get +set +del +eval +select +ping +quit', 'allkeys-',
      'Redis Cluster', 'fails closed', 'at most one more login']) expect(s, text).toContain(text);
  });

  it('counts four credentials (Browser, Site Login, Step Signing, Redis)', () => {
    expect(readme).not.toMatch(/three credentials/);
    expect(readme.match(/four credentials/g)).toHaveLength(2);
  });

  it('tells operators who can roll the feed back, and that a copied feed needs its own approval workflow', () => {
    const s = section('## Operator guidance');
    for (const text of ['`playwright_steps`', 'earlier approved version', 'copy of workflow 3', 'Site Login', 'Empty Site Login credential id']) {
      expect(s, text).toContain(text);
    }
  });

  it('uses no use-case words outside the data-feed section', () => {
    const feed = section('## The self-healing data feed');
    // `sandbox/portal` is a directory name in the repo layout, not UI text.
    const rest = readme.replace(feed, '').replaceAll('sandbox/portal', 'sandbox/site');
    expect(rest.match(new RegExp(USE_CASE_WORDS.source, 'gi')) ?? []).toEqual([]);
  });

  it('names Playwright only for whoever runs the browser: that section, how it works, development, stored names and golden messages', () => {
    let rest = readme;
    for (const heading of ['## Where the browser runs', '## Development']) rest = rest.replace(section(heading), '');
    const how = section('## What it is');
    rest = rest.replace(how.slice(how.indexOf('### How it works')), '');
    // Stored identifiers, the other project's name, the image and the install command an operator types.
    for (const keep of ['playwright_steps', 'playwright_runs', 'toema/n8n-playwright', 'toeman8n-playwright', 'mcr.microsoft.com/playwright:v',
      'npx playwright install chromium', '`playwright-core`', '`playwrightGuard:`', '~playwrightGuard:*',
      // Import Steps names the tool whose code it reads (Playwright where it means Playwright itself).
      'Playwright Code (JavaScript or TypeScript)', 'the Playwright recorder, `npx playwright codegen`',
      // The import message and the form's source names quote the tool.
      'Only JavaScript or TypeScript Playwright code can be imported', '**Playwright code**', 'Playwright code or a UiPath project']) rest = rest.replaceAll(keep, '');
    expect(rest.match(/^.*playwright.*$/gim) ?? []).toEqual([]);
  });

  it('documents Import Steps: sources, the 20 MiB limit, no secrets, no writes, the time it takes, both outputs and the UiPath workflow', () => {
    const s = operation('Import Steps');
    for (const text of [
      '**Chrome Recorder (JSON)**', '**Playwright Code (JavaScript or TypeScript)**', '**UiPath Project (ZIP or XAML)**', '**Input Binary Field**', '**Recording or Code**',
      'The file is larger than 20 MiB, so it was not read.', '`<name>-1`', 'starting with `=` is refused', '**Expected File (First Version)**', '**ID Pattern (Regex)**',
      'is never imported', 'one `signIn` step', 'refused before the browser opens', 'no rows or files from these runs are delivered',
      'no form submissions or writes (**Requests That Only Read** still pass)', 'about twice **Max Seconds** per step list',
      'On sites with an authenticator code, **Max Seconds** must leave room for up to a 30 s wait', 'login breaker and run lock', 'at most 10 step lists',
      '**RPA Redis** (optional; needed in queue mode with a Site Login',
      '{ report, drafts: [{ name, steps, adopted, code?, reason?, traceRef? }], workflowName? }', '`steps: null`', '`trace-<n>`', '`details.traceRef`', '`adopted: false`', 'never on Repaired Steps',
      '`<name>.workflow.json`', '`application/json`', '**Import from file**', '**Sign Steps** take it unchanged', 'No Step Signing key',
    ]) expect(s, text).toContain(text);
    const row = section('## Safety model').split('\n').find((l) => l.startsWith('| Import Steps |')) ?? '';
    for (const text of ['refused before the browser opens', 'never delivered', 'never imported']) expect(row, text).toContain(text);
  });

  it('the Import Steps section quotes every import message and walks the first-day template', () => {
    const s = operation('Import Steps');
    // The engine's own constants, so a reworded message fails here until the README quotes the new text.
    const messages = [IMPORT_NEEDS_SITE_LOGIN, IMPORT_REFUSES_WRITES, IMPORT_NOT_ADOPTABLE, IMPORT_UNSUPPORTED_TARGET, IMPORT_EMPTY, IMPORT_PROOF_FAILED];
    expect(messages.every((m) => typeof m === 'string' && m.length > 20)).toBe(true);
    for (const m of messages) expect(s, m).toContain(`\`${m}\``);
    const first = s.slice(s.indexOf('**First day: import a bot.**'));
    for (const text of [
      '`packages/n8n-nodes-rpa/templates/5-import-a-bot.json`', '**RPA: 5 Import a bot**', '**Expected File**', '**Recorder** panel', '**Export → JSON**',
      '`npx playwright codegen`', '`project.json`', 'password, PIN or code field', 'one `signIn` step', '**RPA: 3 Approve steps**', 'each step list gets its own approval',
      '`Imported: <n> steps; <m> not translated, <k> removed as secrets.`', '`<name>.workflow.json`', '**Sign Steps** signs them', '(Basic Auth) by default', 'pick or create a Basic Auth credential',
      'Keep **Authentication** on', 'login breaker trips', 'spend on the chat model',
      'reverse proxy', '`proxy_read_timeout`', "Don't submit the form again", '**Executions**',
    ]) expect(first, text).toContain(text);
  });

  it('the Run Steps reference links the step schema, says how to map it and lists what it cannot check', () => {
    const s = section('## Run Steps reference');
    const at = s.slice(s.indexOf('**Step schema.**'));
    for (const text of ['`packages/engine/schema/steps.schema.json`', 'draft-07', '`json.schemas`', '`$schema` key', 'refuses keys it does not know',
      'five rules', 'compiles', '`detect.require`', 'absolute `goto`', 'parses as a URL', 'stricter than Run Steps', '`http:host`', 'UTF-16']) expect(at, text).toContain(text);
  });

  it('documents signIn.next in the Run Steps reference and both login pages in the safety model', () => {
    const ref = section('## Run Steps reference');
    expect(ref).toContain('| `signIn` | `{ username, next?, password, submit, totp? }` needs a Site Login |');
    const at = ref.slice(ref.indexOf('**Two-page sign-in.**'));
    for (const text of ['`signIn.next` is the button between them', 'only when the password field shows on a listed login page',
      'a rejected username stops the run before the password is typed', 'an ordinary `click` step with `when`',
      '"next": { "role": "button", "name": "Next" }']) expect(at, text).toContain(text);
    const s = section('## Safety model');
    const row = s.split('\n').find((l) => l.startsWith('| Run Steps with a Site Login |')) ?? '';
    expect(row).toContain('(with `next`, both of its pages)');
    const pages = s.slice(s.indexOf('**Two-page sign-ins.**'));
    for (const text of ['list both the username page and the password page in **Pages Where the Password May Be Typed**', 'the username is a secret too',
      'stops before the password is typed if that page is not listed', '"Stay signed in?" answer', 'or the POST fails `policy_violation`']) expect(pages, text).toContain(text);
  });

  it('Import Steps builds signIn with next and names the download rule; single-page-app identity providers post the username on Next', () => {
    const s = operation('Import Steps');
    for (const text of ['becomes a `signIn` with `next` when exactly one click or Enter separates the two pages',
      'Enter becomes a click on the form\'s submit button', 'A sign-in over three or more pages, with a detour or a field between the pages, or whose Next opens a new tab is reported',
      '(with `next` when the email and the password are on two pages one click or Enter apart)',
      'a click the source marked as a download, else the last click named like export, download, csv, xlsx or spreadsheet, else the last click',
      'a confirming click after it, such as Continue, OK or Save, downloads instead', 'no address change or URL check lies between the two']) expect(s, text).toContain(text);
    const pages = section('## Safety model').slice(section('## Safety model').indexOf('**Two-page sign-ins.**'));
    for (const text of ['may also POST the username in the background when **Next** is clicked', '`GetCredentialType`',
      'declare that path as a login page too (or in **Requests That Only Read**), or the run fails `policy_violation`']) expect(pages, text).toContain(text);
    const runbook = readFileSync(new URL('docs/onboarding/sap-lookalike.md', root), 'utf8');
    for (const text of ['may also POST the username in the background when Next is clicked', '`GetCredentialType`', 'The dev compose file passes `IDP_KMSI`']) {
      expect(runbook, text).toContain(text);
    }
    expect(readFileSync(new URL('docker-compose.dev.yml', root), 'utf8')).toContain('IDP_KMSI: ${IDP_KMSI:-on}');
  });

  it('a rejected username is login_failed only when the username page comes back; no AI repair once the username was typed', () => {
    const at = section('## Run Steps reference').slice(section('## Run Steps reference').indexOf('**Two-page sign-in.**'));
    expect(at).toContain('`login_failed` when the site sends the username page back; an inline error on the same page times out as drift (and AI repair is not attempted once the username was typed)');
    const runbook = readFileSync(new URL('docs/onboarding/sap-lookalike.md', root), 'utf8');
    for (const text of [
      'The step then fails with `login_failed` (the login breaker trips) and the password is never typed.',
      "A password field that doesn't show within 15 s fails as drift with `signIn: after Next the password field did not appear`.",
      'an inline error on the same page times out as drift (and AI repair is not attempted once the username was typed)',
    ]) expect(runbook, text).toContain(text);
    expect(runbook).not.toContain('the username may have been rejected');
  });

  it('Import Steps documents the code from an expression, TOTP activities and the gated "Stay signed in?" answer; markers over a Browser Server', () => {
    const s = operation('Import Steps');
    const paragraph = (start: string) => { const at = s.slice(s.indexOf(start)); return at.slice(0, at.indexOf('\n')); };
    const never = paragraph('What is never imported');
    const stripped = paragraph('What gets stripped');
    for (const at of [never, stripped]) {
      for (const text of ['a UiPath TOTP activity\'s output', 'becomes the sign-in\'s code', 'reported as a secret', "the Site Login's authenticator secret types a fresh code",
        'No, Yes or "Don\'t show this again"', 'becomes a `when` step in the sign-in block', 'reported converted', 'URL checks and waits before it are dropped']) expect(at, text).toContain(text);
    }
    for (const text of ['GenerateTOTP, GetTotpCode, GenerateOneTimePassword, GetOtp', 'so SAP\'s command field or a Company Code typed from a variable stays a step',
      'a "Don\'t show this again" checkbox ticked before it']) expect(never, text).toContain(text);
    expect(readme).toContain('(over CDP or a Browser Server, a live view attached to the page can also show the running step)');
  });

  it('never calls Repaired steps a proposal', () => {
    expect(readme).not.toMatch(/proposal/i);
  });

  it('names only repo files that exist', () => {
    const paths = new Set<string>();
    for (const m of readme.matchAll(/`((?:packages|docker|sandbox|docs|deploy|images)\/[A-Za-z0-9_./-]+|docker-compose(?:\.dev)?\.yml|\.env\.example)`/g)) paths.add(m[1]);
    expect(paths.size).toBeGreaterThan(5);
    for (const p of paths) expect(existsSync(new URL(p, root)), p).toBe(true);
  });
});
