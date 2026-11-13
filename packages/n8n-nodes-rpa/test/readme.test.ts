// The README, the guides and the reference pages quote the product: these tests keep the quotes true, the facts on the
// page where a reader looks for them, and every relative link working.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DESKTOP_VERBS, STEP_VERBS, USE_CASE_WORDS } from 'n8n-rpa-engine';
import {
  BROWSER_CERT_NOT_TRUSTED, BROWSER_CERT_NOT_TRUSTED_CDP, BROWSER_FINGERPRINT_INVALID, BROWSER_FINGERPRINT_MISMATCH, BROWSER_FINGERPRINT_NEEDS_WSS,
  IMPORT_EMPTY, IMPORT_NEEDS_SITE_LOGIN, IMPORT_NOT_ADOPTABLE, IMPORT_PROOF_FAILED, IMPORT_REFUSES_WRITES, IMPORT_UNSUPPORTED_TARGET,
} from 'n8n-rpa-engine';
import { SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import { GUIDANCE } from '../nodes/Playwright/errors.js';
import { NOT_REPLAYED_EVIDENCE_LINE } from '../nodes/Playwright/format.js';
import { MISSING_VARIABLE_HINT } from '../nodes/Playwright/operations/runStepsParams.js';
import { RUN_TABLE_COLUMNS, STEPS_TABLE_COLUMNS } from '../nodes/Playwright/rows.js';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const PAGES = {
  readme: 'README.md',
  browserBot: 'docs/guides/browser-bot.md',
  desktopBot: 'docs/guides/desktop-bot.md',
  recordBot: 'docs/guides/record-a-bot.md',
  moveBot: 'docs/guides/move-a-bot.md',
  windows: 'docs/install/windows.md',
  operations: 'docs/reference/operations.md',
  steps: 'docs/reference/steps.md',
  errors: 'docs/reference/errors.md',
  security: 'docs/reference/security.md',
  operator: 'docs/reference/operator.md',
  templates: 'docs/reference/templates.md',
  npm: 'packages/n8n-nodes-rpa/README.md',
} as const;
type Page = keyof typeof PAGES;
const doc = Object.fromEntries(Object.entries(PAGES).map(([k, p]) => [k, read(p)])) as Record<Page, string>;

/** The text under a heading (`## X` or `### X`), up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, `${heading} exists`).toBeGreaterThan(-1);
  const level = heading.indexOf(' ');
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The text outside fenced code blocks. */
const prose = (text: string) => text.replace(/^```[\s\S]*?^```/gm, '');

// Hard-coded (not imported): the docs must say exactly what the node says.
const GOLDEN_MESSAGES = [
  'Could not connect to the browser server at ws://browser:3000/. Is it running? With the compose stack: docker compose up -d browser; on a Windows machine, run rpa status there (README: Where the browser runs).',
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
/** The browser guide's setup command: run in the compose stack's n8n container, where the image installs the package. */
const SETUP_IN_STACK = 'RPA_BROWSER_TOKEN="$(sed -n \'s/^BROWSER_TOKEN=//p\' .env)" docker compose exec -e RPA_BROWSER_TOKEN n8n /opt/n8n-rpa/node_modules/.bin/n8n-nodes-rpa setup --browser-url ws://browser:3000/';
const TOKEN_REFUSED = 'The browser server at ws://browser:3000/ refused the token. Check the Token in the RPA Browser credential.';

describe('the README', () => {
  it('is the way in: its sections in order, at most 250 lines', () => {
    expect(doc.readme.match(/^## .+$/gm)).toEqual([
      'What it replaces', 'Three ways in', 'How approval works', 'Where the browser runs', 'Where things live', 'Project status', 'Development',
    ].map((h) => `## ${h}`));
    expect(doc.readme.split('\n').length).toBeLessThanOrEqual(250);
    for (const way of ['### A browser bot', '### A Windows desktop bot', '### Move a bot you already have']) expect(doc.readme).toContain(way);
    for (const guide of ['browser-bot', 'desktop-bot', 'move-a-bot', 'record-a-bot']) expect(doc.readme).toContain(`(docs/guides/${guide}.md)`);
    expect(doc.readme).toContain('Power Automate Desktop has no importer');
  });

  it('keeps "Where the browser runs", which the node\'s messages name', () => {
    const s = section(doc.readme, '## Where the browser runs');
    for (const text of ['docker compose up -d browser', 'rpa status', '(docs/reference/operator.md#where-the-browser-runs)']) expect(s, text).toContain(text);
  });

  it('says plainly what is not released', () => {
    expect(section(doc.readme, '## Project status')).toContain('**Not released yet:**');
    expect(doc.readme).toContain('Version 0.1.0 (browser bots) is on npm');
  });

  it('counts six credentials', () => {
    expect(doc.readme).toContain('six credentials');
    expect(readdirSync(new URL('packages/n8n-nodes-rpa/credentials/', root)).filter((f) => f.endsWith('.credentials.ts'))).toHaveLength(6);
  });

  it('uses no use-case words', () => {
    // `sandbox/portal` and `THIRD-PARTY-NOTICES.md` are names of files in the repo, not UI text.
    expect(doc.readme.replaceAll('sandbox/portal', 'sandbox/site').replaceAll('THIRD-PARTY-NOTICES.md', 'THIRD-PARTY.md').match(new RegExp(USE_CASE_WORDS.source, 'gi')) ?? []).toEqual([]);
  });
});

describe('every page', () => {
  it('names Playwright only where it means Playwright itself', () => {
    const keep = ['playwright_steps', 'playwright_runs', 'toema/n8n-playwright', 'mcr.microsoft.com/playwright:v', 'npx playwright install chromium', 'npx playwright codegen',
      'npx playwright@1.63.0', 'playwright@1.63.0', 'playwright-core', 'playwright run-server', 'playwrightGuard', 'Playwright code', 'Playwright Code', 'Playwright recorder',
      'Playwright protocol', 'Playwright server', 'Playwright version', 'Playwright 1.63', 'Playwright trace', 'Playwright\'s', 'Recorder or Playwright'];
    for (const name of ['readme', 'browserBot', 'desktopBot', 'recordBot', 'moveBot', 'windows', 'npm'] as const) {
      let rest = doc[name];
      for (const k of keep) rest = rest.replaceAll(k, '');
      expect(rest.match(/^.*playwright.*$/gim) ?? [], name).toEqual([]);
    }
  });

  it('follows the plain-words rules: no em dash, none of the banned words, no promises', () => {
    for (const name of Object.keys(PAGES) as Page[]) {
      const text = prose(doc[name]);
      expect(text, `${name}: em dash`).not.toContain('—');
      expect(text.match(/\b(simply|just|easy|seamless(ly)?|robust|leverage|guarantees?|ensures?)\b/gi) ?? [], name).toEqual([]);
      expect(text, name).not.toMatch(/proposal/i);
    }
  });

  it('names only repository files that exist', () => {
    const paths = new Set<string>();
    for (const text of Object.values(doc)) {
      for (const m of text.matchAll(/`((?:packages|docker|sandbox|docs|deploy|images|desktop)\/[A-Za-z0-9_./-]+|docker-compose(?:\.dev|\.queue)?\.yml|\.env\.example)`/g)) paths.add(m[1]);
    }
    expect(paths.size).toBeGreaterThan(10);
    for (const p of paths) expect(existsSync(new URL(p, root)), p).toBe(true);
  });

  it('every relative link resolves, to a file and to a heading', () => {
    const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'desktop/README.md', 'packages/n8n-nodes-rpa/README.md',
      ...['docs', 'docs/guides', 'docs/reference', 'docs/install', 'docs/deploy', 'docs/onboarding']
        .flatMap((d) => readdirSync(new URL(`${d}/`, root)).filter((f) => f.endsWith('.md')).map((f) => `${d}/${f}`))];
    // GitHub's heading anchors: lower case, punctuation removed, spaces as hyphens, a repeat gets -1, -2.
    const anchors = (path: string) => {
      const seen = new Map<string, number>();
      return prose(read(path)).split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => {
        const base = l.replace(/^#+ /, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return n ? `${base}-${n}` : base;
      });
    };
    let checked = 0;
    for (const file of files) {
      for (const m of prose(read(file)).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [path, anchor] = target.split('#');
        const resolved = path ? new URL(path, new URL(file, root)) : new URL(file, root);
        expect(existsSync(resolved), `${file}: ${target}`).toBe(true);
        if (anchor && resolved.pathname.endsWith('.md')) {
          expect(anchors(decodeURIComponent(resolved.pathname.slice(new URL(root).pathname.length))), `${file}: ${target}`).toContain(anchor);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('the browser bot guide', () => {
  it('gets a person to a first bot through the import form: one-command start, the setup command, the sample, approve, run', () => {
    for (const text of [
      'openssl rand -hex 32', 'BROWSER_TOKEN', 'docker compose up --build -d', 'docker compose up -d browser', 'http://localhost:5678', 'http://localhost:8025',
      '**Settings → n8n API → Create API key**', SETUP_IN_STACK, 'Connect a Windows machine now?', 'The import form is ready.',
      '+ → New credential → RPA Site Login', '--site-login "RPA Site Login account" --allow-private-network', 'Private network: on.', 'docs/samples/sandbox-line-items.steps.json', '**Allow access**',
      'Approved and signed: sandbox-line-items v1 is now the version that runs under that name.', 'sandbox-line-items.workflow.json',
      'packages/n8n-nodes-rpa/templates/hello-world.json', 'docker-compose.dev.yml', 'SKU-1001', 'Private Network Endpoint', TOKEN_REFUSED, 'Mismatching encryption keys',
    ]) expect(doc.browserBot, text).toContain(text);
  });

  it('makes the Site Login before the setup command, which picks it by the name n8n gives it: no step opens the import workflow', () => {
    const headings = doc.browserBot.match(/^## \d+\. .+$/gm) ?? [];
    expect(headings.slice(0, 5)).toEqual([
      '## 1. Start n8n and the browser', "## 2. Add the sample site's login", '## 3. Set up the import form with one command',
      '## 4. Import the sample bot and approve it', '## 5. Run it',
    ]);
    expect(section(doc.browserBot, "## 2. Add the sample site's login")).toContain('n8n names it **RPA Site Login account**');
    expect(doc.browserBot).not.toContain('## 4. Give the import form the Site Login');
    expect(doc.browserBot).not.toContain('Open the workflow **RPA: 5 Import a bot**');
  });

  it("runs the setup command where the n8n image installs it, and the first bot needs no chat model and no email server", () => {
    // docker/n8n.Dockerfile installs the package under /opt/n8n-rpa, and npm links its bin there.
    expect(read('docker/n8n.Dockerfile')).toContain('npm install --ignore-scripts --omit=dev --omit=peer --no-audit --no-fund /packs/n8n-nodes-rpa-*.tgz');
    expect(read('docker/n8n.Dockerfile')).toContain('WORKDIR /opt/n8n-rpa');
    expect(JSON.parse(read('packages/n8n-nodes-rpa/package.json')).bin).toEqual({ 'n8n-nodes-rpa': 'dist/setup.mjs' });
    const part1 = doc.browserBot.slice(0, doc.browserBot.indexOf('\n## Part 2: Let it repair itself\n'));
    expect(part1.length).toBeGreaterThan(1000);
    for (const text of ['SMTP', 'Anthropic', 'mailpit', '2-data-feed.json', '3-approve-steps.json']) expect(part1, text).not.toContain(text);
  });

  it("the sandbox's Site Login lists the request the sample's SAP pages post to read", () => {
    const reads = SANDBOX.erp.readPosts('sandbox:8080').map((r) => `\`POST ${r.host}${r.path}\``);
    expect(reads[0]).toBe('`POST sandbox:8080/sap*/bc/gui/sap/its/webgui`');
    expect(doc.browserBot).toContain(`Requests That Only Read ${reads[0]}`);
    expect(doc.browserBot).toContain('Login Page URL `http://sandbox:8080/acme/login`');
    // The proof the review page shows: the file the sample's download step checks for.
    const sample = JSON.parse(read('docs/samples/sandbox-line-items.steps.json')) as { name: string; steps: { download?: { check: { name: string } } }[] };
    expect(sample.name).toBe('sandbox-line-items');
    expect('LINEITEMS_1000_2026-09-01_2026-09-30.csv').toMatch(new RegExp(sample.steps.at(-1)?.download?.check.name ?? '^$'));
    expect(doc.browserBot).toContain('`LINEITEMS_1000_2026-09-01_2026-09-30.csv`');
  });

  it('sets up the self-repair part as the templates ship it: workflow 3 published first, then 2', () => {
    const s = section(doc.browserBot, '## 7. Import the two workflows');
    expect(s.indexOf('3-approve-steps.json')).toBeLessThan(s.indexOf('2-data-feed.json'));
    for (const text of ['**Publish**', 'Allow Private Network', '**RPA: 3 Approve steps** in **Approve steps**']) expect(s, text).toContain(text);
    expect(doc.browserBot).toContain('`lane: "script"`, `version: 1` and `llmCalls: 0`');
  });
});

describe('the desktop bot guide and the Windows guide', () => {
  it('teaches the short path: one command, one line, record, approve on the form, run', () => {
    for (const text of ['.\\Get-Rpa.ps1 -AllowFrom <n8n address>', '& "C:\\Program Files\\RPA Runner\\rpa.cmd" connection -ShowTokens', '**Connection Line**',
      'Which of these change from run to run?', '**Allow this app…**', 'packages/n8n-nodes-rpa/templates/5-import-a-bot.json', '**Approve and sign**',
      'Approved and signed: erp-line-items v1 is now the version that runs under that name.', '**RPA Secret Variables**', '**Not released yet.**']) {
      expect(doc.desktopBot, text).toContain(text);
    }
  });

  it('keeps the section numbers the installer, the credentials and the licensing note name', () => {
    const headings = doc.windows.match(/^## .+$/gm) ?? [];
    for (const h of ['## 4. Signing in', '## 6. Connect n8n', '## 10. Changing the tokens and the certificates']) expect(headings).toContain(h);
    expect(doc.windows.split('\n').length).toBeLessThanOrEqual(450);
    for (const text of ['rpa connection', 'rpa status', 'rpa policy apply', '-Unattended', '-AutoSignIn', 'No sign-in mode was given, so this install is unattended']) {
      expect(doc.windows, text).toContain(text);
    }
  });
});

describe('the recorder guide', () => {
  it('quotes the bar as the recorder says it', () => {
    const source = ['BarText.cs', 'NextSteps.cs', 'Notices.cs', 'DialogText.cs', 'ValuesPage.cs', 'SaveNames.cs', 'StepRows.cs']
      .map((f) => read(`desktop/recorder/src/Rpa.Recorder.Core/${f}`)).join('\n');
    for (const text of ['Start an app…', 'Use an open app…', 'Start recording', 'Finish', 'Delete step', 'Make secret…',
      'Which of these change from run to run?', 'Continue', 'Change folder…', 'Allow this app…', 'Show the file', 'Open the import form', 'Change address…', 'Record another',
      'Point at a value in the app and press F9 to read it on every run.', 'Input in other programs is not recorded.', 'Check the steps, then name the recording and save it.',
      'Your clicks and what you type in that app become steps, listed here as plain sentences.', 'RPA recordings',
      'Almost done · ', 'Finished · ', 'Saved · ', 'Upload it in n8n\'s Import a bot form.']) {
      expect(doc.recordBot, text).toContain(text);
      expect(source, text).toContain(text);
    }
    // Variables are made on the values page only.
    expect(doc.recordBot).not.toContain('Make variable');
    expect((doc.recordBot.match(/<!-- screenshot: [a-z0-9-]+\.png -->/g) ?? []).length).toBeLessThanOrEqual(4);
  });
});

describe('the move-a-bot guide', () => {
  it('says there is no Power Automate Desktop importer and maps its actions', () => {
    expect(doc.moveBot).toContain('There is no importer for **Power Automate Desktop**');
    expect(section(doc.moveBot, '## From Power Automate Desktop')).toContain('| UI automation (click, populate text field, select, check) |');
  });

  it('maps toema/n8n-playwright verbs to operations and says why there is no JavaScript step', () => {
    const s = section(doc.moveBot, '## From toema/n8n-playwright');
    for (const text of ['Navigate', 'Screenshot', 'Get Text', 'Click, Fill', 'Custom Script', 'Run Steps', 'JavaScript', 'signed']) expect(s, text).toContain(text);
  });

  it('quotes the import messages it names', () => {
    for (const m of [IMPORT_NEEDS_SITE_LOGIN, IMPORT_UNSUPPORTED_TARGET, IMPORT_NOT_ADOPTABLE]) expect(doc.moveBot, m).toContain(`\`${m}\``);
  });
});

describe('the operations reference', () => {
  it('names every operation with its action text, in order', () => {
    const names = ['Screenshot', 'Get Page', 'Save as PDF', 'Extract Data', 'Fill and Submit Form', 'Download File', 'Run Steps', 'Sign Steps', 'Import Steps'];
    const at = names.map((n) => doc.operations.indexOf(`| **${n}** |`));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const text of ['Take a screenshot of a page', 'Get the text, HTML or title of a page', 'Save a page as PDF', 'Extract a table or list from a page',
      'Fill in and submit a form', 'Download a file from a page', 'Run a list of browser or desktop steps', 'Sign a repaired step list',
      'Import steps from a recording, code or a UiPath bot']) expect(doc.operations).toContain(text);
    for (const n of names) expect(doc.operations, n).toMatch(new RegExp(`^##+ ${n}$`, 'm'));
  });

  it('states the quick-operation rules', () => {
    for (const text of ['URL must not contain {{ }} templates', 'Put Output in Field must not be "trace"', '`screenshot.png`', '`pdf.pdf`', '`status` is `null`']) {
      expect(doc.operations, text).toContain(text);
    }
    expect(section(doc.operations, '### Extract Data')).toMatch(/`confirmed`\s+is `true` only when/);
    const fill = section(doc.operations, '### Fill and Submit Form');
    for (const text of ['Debug Trace', 'Never', 'sensitive form data', 'echo', '`submitted: false`', 'Text fields only', 'selects and checkboxes',
      'does not run unchanged in Run Steps', '**Options → Variables**', 'a `submit`']) expect(fill, text).toContain(text);
  });

  it('documents Import Steps: sources, limits, what is never imported, no writes, both outputs, every message', () => {
    const s = section(doc.operations, '## Import Steps').replace(/\s+/g, ' ');
    for (const text of [
      '**Work It Out From the File**', '**Chrome Recorder (JSON)**', '**Playwright Code (JavaScript or TypeScript)**', '**UiPath Project (ZIP or XAML)**', '**Step Document (JSON)**',
      '**RPA Recording**', '**Input Binary Field**', '**Recording or Code**', 'The file is larger than 20 MiB, so it was not read.', '`<name>-1`', 'starting with `=` is refused',
      'is never imported', 'one `signIn` step', 'refused before the browser opens', 'no rows or files from these runs are delivered', 'about twice **Max Seconds** per step list',
      '**TOTP Secret** or **Options → One-Time Code Workflow**', 'at most 10 step lists', 'A `signature` and `approvedBy` beside the steps are not imported',
      'also when a higher version was active', '{ report, drafts: [{ name, steps, adopted, code?, reason?, traceRef? }], workflowName? }', '`adopted: false`',
      'never on Repaired Steps', '`<name>.workflow.json`', '`leftOut`', NOT_REPLAYED_EVIDENCE_LINE,
    ]) expect(s, text).toContain(text);
    for (const m of [IMPORT_NEEDS_SITE_LOGIN, IMPORT_REFUSES_WRITES, IMPORT_NOT_ADOPTABLE, IMPORT_UNSUPPORTED_TARGET, IMPORT_EMPTY, IMPORT_PROOF_FAILED]) {
      expect(s, m).toContain(`\`${m}\``);
    }
  });

  it('documents Sign Steps: the allowlist, Approved By, Write Steps, and how hand-written steps get signed', () => {
    const s = section(doc.operations, '## Sign Steps').replace(/\s+/g, ' ');
    for (const text of ['**Approver Allowlist**', 'Leave it empty when the allowlist holds exactly one address', '**Write Steps**', '`Signed as writes: none`',
      'Steps you wrote yourself get a Repaired steps item, and so approval and a signature, through [Import Steps](#import-steps) with **Source** **Step Document (JSON)**']) {
      expect(s, text).toContain(text);
    }
    expect(doc.operations.replace(/\s+/g, ' ')).toContain('**RPA Redis** (optional, needed in queue mode with a Site Login)');
  });
});

describe('the steps reference', () => {
  it('references every browser and desktop verb', () => {
    const browser = section(doc.steps, '## Browser steps');
    for (const verb of STEP_VERBS) expect(browser, verb).toContain(`\`${verb}\``);
    const desktop = section(doc.steps, '## Desktop steps');
    for (const verb of DESKTOP_VERBS) expect(desktop, verb).toContain(`\`${verb}\``);
    for (const text of ['Require Signed Steps', 'Variables', '{{var.name}}', 'AI Repair', 'Allow Unsigned Writes']) expect(doc.steps, text).toContain(text);
  });

  it('documents the select row with the multi-select limits, and the signIn row', () => {
    expect(doc.steps).toContain('| `fill`, `select` | `{ field: <locator>, value }`. `value` may be `{{var.name}}`. `fill` also takes `secret: true` (see **Typing a secret into a password field**). '
      + 'For `select` on a multi-select, `value` may be an array of strings, `["north", "{{var.region}}"]`: exactly those options end up selected and the others are cleared '
      + '(a single string still selects one option). The array holds at most 50 values, of at most 4096 characters over all values together |');
    expect(doc.steps).toContain('| `signIn` | `{ username, next?, password, submit, totp?, changePassword? }` needs a Site Login. `totp` is `{ field, submit, source?, via?, check? }`. '
      + '`changePassword` is `{ detect, current?, new, submit, value }` (see **When a site forces a new password**) |');
  });

  it('lists the Data fields, and states the AI Repair rules and messages word for word', () => {
    expect(doc.steps).toContain('{ url, title, status, name, version, hash, lane, confirmed, llmCalls, durationMs, llmTokens, log, rows?, files?, blockedRequests?, submitted?, passwordChanged?, account? }');
    const s = section(doc.steps, '## AI Repair');
    const flat = s.replace(/\s+/g, ' ');
    for (const text of ['screenshot, PDF, read and table steps', '`submit`', '`download.via`', 'after a write', 'one repair per workflow execution', 'every Run Steps node',
      'AI repair already ran in this execution', 'A sub-workflow call is its own execution, with its own repair.',
      'AI repair of a download needs exactly one download step, outside paginate, and no extract step.',
      'AI repair of a download needs a check on the download step that names the file or its columns (check.name or check.columns).',
      'AI repair works only on steps that extract rows or download one file: remove screenshot, PDF, read and table steps, or turn AI Repair off',
      'A first run needs either an ID Pattern (to read rows) or an Expected File with a file name pattern or required columns (to download a file), not both.',
      'the repaired steps did not pass the proof, so the downloaded file was not delivered',
      'the repaired steps did not pass the proof, so the rows were not delivered (turn on Options → Deliver Unconfirmed Rows to receive them)',
      '**Deliver Unconfirmed Rows** never releases a file', 'the Repaired steps item has file evidence that does not match its steps']) expect(flat, text).toContain(text);
    const first = s.slice(s.indexOf('**Known limits.**')).split('\n')[1];
    expect(first).toBe('- AI-built and AI-repaired steps extract IDs only. Rows from those steps carry `id` and no other fields. When you need record content, write the extract step yourself (Extract Data or Run Steps fields). Repair then refuses to rewrite field extraction.');
  });

  it('documents file checks, locators, ID Pattern, the sign-in and the step schema', () => {
    const flat = (heading: string) => section(doc.steps, heading).replace(/\s+/g, ' ');
    for (const text of ['`check.name`', '`check.minBytes`', '`check.columns`', '`check.minRows`', 'download check failed:', 'no date-range check']) expect(flat('## File checks'), text).toContain(text);
    for (const text of ['Visible Text', 'Form Label', 'Role and Name', 'Test ID', 'CSS Selector', 'Exact Match', 'exactly one', 'Inspect', 'Copy selector']) {
      expect(flat('## Locators'), text).toContain(text);
    }
    for (const text of ['INV-\\d{4}-\\d{5}', '[A-Z]{2}\\d{6}', '\\d+', '.+', 'regex101.com']) expect(flat('## ID Pattern'), text).toContain(text);
    for (const text of ['`signIn.next` is the button between them', 'only when the password field shows on a listed login page', 'a rejected username stops the run before the password is typed',
      'an ordinary `click` step with `when`', '"next": { "role": "button", "name": "Next" }', '`"source": "workflow"`', '**Execute Workflow Trigger**', '`{ requestedAt }`',
      'exactly one item whose `code` is 6 to 10 digits', 'Publish that workflow first', '"Workflow is not active and cannot be executed"', 'turn off saving successful executions',
      '`password_change_failed`', '`passwordChanged: true`']) expect(flat('## Sign-in'), text).toContain(text);
    for (const text of ['`packages/engine/schema/steps.schema.json`', 'draft-07', '`json.schemas`', '`$schema` key', 'refuses keys it does not know', 'seven rules', 'compiles',
      '`detect.require`', 'absolute `goto`', 'parses as a URL', 'stricter than Run Steps', '`http:host`', 'UTF-16', '`{{$...}}`',
      'no `when` tests a variable that a secret `fill` types']) expect(flat('## Step schema'), text).toContain(text);
    expect(doc.steps).toContain('missing input "<name>"');
  });
});

describe('the errors reference', () => {
  it('explains every error code and prints every golden message', () => {
    for (const code of Object.keys(GUIDANCE)) expect(doc.errors, code).toContain(`| \`${code}\` |`);
    expect(Object.keys(GUIDANCE)).toHaveLength(14);
    for (const m of GOLDEN_MESSAGES) expect(doc.errors, m).toContain(m);
    for (const text of ['configError: true', 'details', 'output 2', '`llmTokens`', MISSING_VARIABLE_HINT]) expect(doc.errors, text).toContain(text);
  });

  it('quotes the certificate messages of the RPA Browser credential as the engine says them', () => {
    const messages = [BROWSER_CERT_NOT_TRUSTED, BROWSER_CERT_NOT_TRUSTED_CDP, BROWSER_FINGERPRINT_MISMATCH, BROWSER_FINGERPRINT_INVALID, BROWSER_FINGERPRINT_NEEDS_WSS];
    expect(messages.every((m) => typeof m === 'string' && m.length > 20)).toBe(true);
    for (const m of messages) expect(doc.errors, m).toContain(`\`browser_unavailable\`: \`${m}\``);
    expect(doc.errors.match(/When the certificate is that of the configured address itself, no request and no token was sent\./g)).toHaveLength(2);
  });
});

describe('the security reference', () => {
  it('has a table for every operation group, the settings that must be typed, and the accepted risks', () => {
    const s = section(doc.security, '## Browser runs');
    for (const text of ['| Screenshot, Get Page, Save as PDF, Extract Data, Download File |', '| Fill and Submit Form |', '| Run Steps, unsigned, no Site Login |',
      '| Run Steps, signed, no Site Login |', '| Run Steps with a Site Login |', '| Sign Steps |', '| Import Steps |', 'blockedRequests']) expect(s, text).toContain(text);
    const row = (start: string) => s.split('\n').find((l) => l.startsWith(start)) ?? '';
    expect(row('| Run Steps, unsigned, no Site Login |')).toContain('may come from any public site when **Also Allow These Sites** is empty');
    for (const text of ['what they send is not checked', '(with `next`, both of its pages)']) expect(row('| Run Steps with a Site Login |'), text).toContain(text);
    for (const text of ['refused before the browser opens', 'never delivered', 'never imported']) expect(row('| Import Steps |'), text).toContain(text);
    const typed = section(doc.security, '## Settings you must type').replace(/\s+/g, ' ');
    for (const text of ['Seven settings must be set directly', '**Require Signed Steps**', '**Allow Private Network**', '**Allow Unsigned Writes**', '**Deliver Unconfirmed Rows**',
      "Run Steps' **Login Breaker Reset Key**", '**One-Time Code Workflow**', "Sign Steps' **Approver Allowlist**"]) expect(typed, text).toContain(text);
    for (const text of ['One shared signing key', 'GET side effects', 'images or canvas', 'Closed shadow roots']) expect(section(doc.security, '## Accepted risks'), text).toContain(text);
  });

  it('the SAP guidance says what listing an endpoint gives up, what * matches, and what the evidence shows', () => {
    const s = section(doc.security, '### Sites that post to read').replace(/\s+/g, ' ');
    for (const text of ['On SAP these endpoints also carry saves', 'Save and Post included', '`$batch` change sets', 'no write protection for it', 'display-only authorizations',
      '`POST sap.example.com/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch`', 'covers every OData service on the host', 'letters, digits and `_ . ( ) = ~ -`', '`%3D`', '`ZSRV;v=0002`',
      'exact host/path the browser shows', 'per-session `/sap(…)/` path cannot be listed', 'Check this on your own SAP system',
      'The approval evidence lists the read-only entries the proof run used', 'Sign Steps checks them against the RPA Site Login']) expect(s, text).toContain(text);
    expect(s).not.toContain('POST sap.example.com/sap/opu/odata/sap/*/$batch');
  });

  it('two-page sign-ins list both pages; single-page identity providers post the username on Next', () => {
    const s = section(doc.security, '### Two-page sign-ins').replace(/\s+/g, ' ');
    for (const text of ['list both the username page and the password page in **Pages Where the Password May Be Typed**', 'the username is a secret too',
      'stops before the password is typed if that page is not listed', '"Stay signed in?" answer', 'or the POST fails `policy_violation`',
      'The address bar does not show where a form posts: if a run stops with "signIn refused: the username field\'s form posts to <host/path> ...", add that host/path to the list.',
      'may also POST the username in the background when **Next** is clicked', '`GetCredentialType`',
      'declare that path as a login page too (or in **Requests That Only Read**), or the run fails `policy_violation`']) expect(s, text).toContain(text);
  });

  it('says who may hold secret variables, and what a lost or changed signing key does and how to sign again', () => {
    const secret = section(doc.security, '## Secret variables').replace(/\s+/g, ' ');
    for (const text of ['The credential is not tied to the steps that were approved.', '**May Be Typed Into**', 'refused before the app starts',
      'refused before it types', 'Empty, the field limits nothing', 'What it does not do:']) expect(secret, text).toContain(text);
    const key = section(doc.security, '## If the signing key is lost or changed');
    for (const text of ['`script_untrusted`', '**Step document**', '`active`', 'tick them again']) expect(key, text).toContain(text);
  });

  it('the onboarding runbook keeps its sign-in facts', () => {
    const runbook = read('docs/onboarding/sap-lookalike.md');
    for (const text of ['may also POST the username in the background when Next is clicked', '`GetCredentialType`', 'The dev compose file passes `IDP_KMSI`',
      'The step then fails with `login_failed` (the login breaker trips) and the password is never typed.',
      "A password field that doesn't show within 15 s fails as drift with `signIn: after Next the password field did not appear`.",
      'an inline error on the same page times out as drift (and AI repair is not attempted once the username was typed)']) expect(runbook, text).toContain(text);
    expect(runbook).not.toContain('the username may have been rejected');
    expect(read('docker-compose.dev.yml')).toContain('IDP_KMSI: ${IDP_KMSI:-on}');
  });
});

describe('the operator guide', () => {
  it('explains where the browser runs: compose, docker run, hosted, local, version matching, ws rules, TLS and certificates', () => {
    const s = section(doc.operator, '## Where the browser runs').replace(/\s+/g, ' ');
    for (const text of ['docker compose up -d browser', 'BROWSER_TOKEN', 'Private Network Endpoint', 'docker run', 'Browserless', 'Local Browser', 'npx playwright install chromium',
      'mcr.microsoft.com/playwright:v1.63.0', 'wss://', '.env.example', 'docker-compose.dev.yml', 'images/browser/gate', 'ws://browser:3000/', 'Playwright protocol',
      'show-trace', TOKEN_REFUSED, '(over CDP or a Browser Server, a live view attached to the page can also show the running step)',
      '`BROWSER_GATE_TOKEN_FILE`', '`BROWSER_GATE_TLS_KEY_FILE`', '`BROWSER_GATE_TLS_CERT_FILE`', '`BROWSER_GATE_HOST`', '`BROWSER_GATE_METRICS_HOST`',
      'gets no HTTP answer', 'closed 10 s after its handshake', 'at most 256 connections', 'no limit per address', 'a new connection for each check',
      'neither fits TLS mode as shipped', "n8n's Node.js process trusts", '`NODE_EXTRA_CA_CERTS`', "not one from the operating system's certificate store",
      'which Node.js does not read by default', 'one whose name does not match the address', 'such as a certificate that is not yet valid', BROWSER_CERT_NOT_TRUSTED]) {
      expect(s, text).toContain(text);
    }
    expect(s).not.toContain('--use-system-ca');
  });

  it('prints the browser service from the real docker-compose.yml', () => {
    const compose = read('docker-compose.yml');
    const yaml = /```yaml\n([\s\S]*?)```/.exec(section(doc.operator, '## Where the browser runs'))?.[1];
    expect(yaml, 'a yaml block').toBeDefined();
    const lines = (yaml ?? '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    const service = /^ {2}browser:\n(?:(?: {4}.*)?\n)+/m.exec(compose)?.[0] ?? '';
    expect(lines).toEqual(service.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')));
  });

  it('points to deploy/ for the browser service at scale', () => {
    const s = section(doc.operator, '## Where the browser runs');
    const at = s.slice(s.indexOf('**Deploy at scale.**')).replace(/\s+/g, ' ');
    for (const text of ['`deploy/`', '`deploy/helm/rpa-browser`', '`deploy/terraform/modules/k8s-browser`', '`deploy/terraform/modules/aws-ecs-browser`', '`deploy/terraform/examples/`',
      '`deploy/scripts/configure-n8n.mjs`', 'N8N_API_KEY', 'RPA_BROWSER_TOKEN', '`0-connection-check.json`', 'queue mode', '`deploy/test/kind-e2e.sh`',
      '[`docs/deploy/kubernetes.md`](../deploy/kubernetes.md)', '[`docs/deploy/aws-ecs.md`](../deploy/aws-ecs.md)',
      'scales on session use (ECS, or Kubernetes with KEDA and Prometheus) or on CPU']) expect(at, text).toContain(text);
  });

  it('says where address checks run, and covers queue mode, the breaker, shutdown and installing', () => {
    const flat = (heading: string) => section(doc.operator, heading).replace(/\s+/g, ' ');
    for (const text of ['proxy', 'DNS', 'c-ares', '/etc/hosts', 'split-DNS', 'fail closed', 'Allowed Hosts']) expect(flat('### Address checks run in n8n'), text).toContain(text);
    for (const text of ['`EXECUTIONS_MODE=queue` on every n8n process', '~playwrightGuard:*', '+get +set +del +eval +select +ping +quit', 'allkeys-', 'Redis Cluster', 'fails closed',
      'at most one more login']) expect(flat('## Queue mode'), text).toContain(text);
    for (const text of ['Login Breaker Reset Key', 'manual executions', "Adding, replacing or removing the Site Login's TOTP Secret also counts as a changed login and gets one try",
      'The RPA Site Login credential has no id. Save the credential, then select it again on this node.']) expect(flat('## Login breaker and run lock'), text).toContain(text);
    for (const text of ['N8N_GRACEFUL_SHUTDOWN_TIMEOUT', 'Sites It May Load Files From', 'Sites Allowed in Embedded Frames', '`playwright_steps`', 'earlier approved version',
      'copy of workflow 3']) expect(flat('## Other settings'), text).toContain(text);
    expect(section(doc.operator, '## Install the node')).toContain('docker/n8n.Dockerfile');
  });
});

describe('the templates reference', () => {
  it('lists every template in the folder by file name and workflow name, and no other', () => {
    const files = readdirSync(new URL('packages/n8n-nodes-rpa/templates/', root)).filter((f) => f.endsWith('.json')).sort();
    const listed = [...doc.templates.matchAll(/^\| `([^`]+\.json)` \| `([^`]+)` \|/gm)];
    expect(listed.map((m) => m[1]).sort()).toEqual(files);
    for (const [, file, name] of listed) expect((JSON.parse(read(`packages/n8n-nodes-rpa/templates/${file}`)) as { name: string }).name, file).toBe(name);
    expect(doc.templates).toContain('packages/n8n-nodes-rpa/templates/');
  });

  it('documents both Data Tables column by column, and the data feed as the templates ship it', () => {
    for (const c of [...STEPS_TABLE_COLUMNS, ...RUN_TABLE_COLUMNS]) expect(doc.templates, c.name).toContain(`| \`${c.name}\` |`);
    for (const t of ['playwright_steps', 'playwright_runs']) expect(doc.templates).toContain(t);
    for (const status of ['pending', 'active', 'rejected', 'expired']) expect(doc.templates).toContain(`\`${status}\``);
    const flat = doc.templates.replace(/\s+/g, ' ');
    for (const text of ['Showing \\d+-\\d+ of (\\d+)', 'every host, form submission, download and pop-up handler', 'not their intents', 'HTML-escape', 'safety flags first',
      'Rejected Repaired steps can come back unchanged if the next repair produces the same steps. They reuse their row.']) expect(flat, text).toContain(text);
  });
});
