import type { Locator } from './types.js';

// Every user-facing golden string of the engine. Tests assert them verbatim, and
// test/wording.test.ts checks that none of them contains a use-case word.

/** Words no user-facing text may contain. */
export const USE_CASE_WORDS = /\b(portal|recall|notice|dealer)s?\b/i;

// signSteps refusal reasons.
export const STEPS_HASH_MISMATCH = 'the steps do not match the hash that was reviewed';
export const STEPS_NAME_MISMATCH = 'the steps have a different name than the repaired steps item';
export const STEPS_VERSION_MISMATCH = 'the steps version does not match the repaired steps item';
export const STEPS_CHANGED_AFTER_REVIEW = 'the repaired steps changed after they were reviewed';

/** validateScript: a literal secret in the steps; `location` names the step or the field. */
export const secretInLocation = (location: string) => `${location} contains a credential secret`;
/** renderVars: a rendered {{var.x}} value contains a secret. */
export const INPUT_CONTAINS_SECRET = 'an input value contains a credential secret';

// Agent lane: the run ended on a login outcome after the agent's own sign_in.
export const agentSignInLocked = (note: string) => `the site says the account is locked after the agent's sign-in: ${note}`;
export const agentSignInRejected = (note: string) => `the site rejected the agent's sign-in: ${note}`;

/** Agent tool enter_code when the Site Login has no TOTP secret. */
export const NO_TOTP_SECRET = 'no authenticator secret is configured for this site; call done with outcome "blocked"';
/** Agent tools: why a control is refused (the destructive denylist), after "refused: e12 " or "refused: a section header contains a control that ". */
export const LOOKS_DESTRUCTIVE = 'looks like it deletes, cancels, pays, sends or otherwise changes something, or signs out';

// Trust gate. Golden: tests assert them verbatim.
export const UNSIGNED_REQUIRED =
  'The steps are not signed, or the signature is not valid, and Require Signed Steps is on. Sign them with Sign Steps first.';
export const SIGNATURE_INVALID =
  'The signature is not valid for these steps: it does not match their name, version, start site, Site Login or approver.';
export const SIGNATURE_WITHOUT_KEY = 'a signature is present but no Step Signing credential is attached';
export const UNSIGNED_WRITES =
  'Unsigned steps cannot sign in, submit a form or download through a form. Sign them with Sign Steps, or turn on Options → Allow Unsigned Writes.';
export const nameMismatch = (signed: string, expected: string) => `the signed steps are named "${signed}", not "${expected}"`;
export const versionMismatch = (signed: number, expected: number) => `the signed steps are version ${signed}, but Expected Version is ${expected}`;
export const startSiteMismatch = (signed: string, expected: string) => `the signed steps start on ${signed}, but this run starts on ${expected}`;

// Network guard. Golden: tests assert them verbatim.
export const browserUnreachable = (url: string) =>
  `Could not connect to the browser server at ${url}. Is it running? Start it with: docker compose up -d browser (README: Where the browser runs).`;
export const browserVersionMismatch = (server: string, client: string) =>
  `The browser server is version ${server} but this node needs ${client}. Use image mcr.microsoft.com/playwright:v${client}.`;
export const CHROMIUM_MISSING = 'Chromium not found. Run: npx playwright install chromium';
/** The endpoint answered the upgrade with 401/403. `url`: origin + pathname only. */
export const tokenRefused = (url: string) =>
  `The browser server at ${url} refused the token. Check the Token in the RPA Browser credential.`;
/**
 * The browser service's gate kept answering 503 busy/draining for the whole session wait. `url`: origin +
 * pathname only; `seconds`: how long the run waited.
 */
export const noFreeBrowserSession = (url: string, seconds: number) =>
  `The browser service at ${url} had no free browser session for ${seconds} s. Add browser capacity (more replicas or sessions per replica) or start fewer RPA runs at once.`;
export const ENDPOINT_NOT_SECURE =
  'Plain ws:// is allowed only on localhost, or on a private-network host with Private Network Endpoint on and a token. Use wss:// for remote endpoints.';
export const notHttp = (protocol: string) => `URL must start with http:// or https:// (got "${protocol}").`;
export const privateAddress = (host: string) =>
  `Blocked: ${host} resolves to a private network address. Turn on Options → Allow Private Network if this site is on your own network.`;
export const offListSite = (host: string, navHosts: string[]) =>
  `Blocked: the page tried to open ${host}, which is not allowed. This run only visits ${navHosts.join(', ')}. Add it under Options → Also Allow These Sites if this is expected.`;
/** A fatal violation with no more specific message (writes, sockets, sign-in refusals): the v1 text. */
export const BLOCKED_REQUEST = 'a blocked request was attempted during the run';
/** A step stopped only because the session recorded a fatal violation (steps/run.ts). */
export const BLOCKED_STOP = 'stopped: a blocked request was attempted';

// Optional Site Login.
export const SIGNIN_NEEDS_SITE_LOGIN = 'signIn needs a Site Login credential';
/** A two-page signIn clicked next, but the password field did not appear within the step timeout (drift). A username page that comes back is `detected:login_failed` instead. */
export const SIGNIN_NEXT_NO_PASSWORD = 'signIn: after Next the password field did not appear';

// signIn with totp.source 'workflow': the one-time code comes from the run's code provider (the node's One-Time Code
// Workflow). The step failure is `detected:mfa_code: <one of these>` (auth_blocked); none of them carries the code.
/** The steps take the code from a workflow, but the run has no code provider: a configuration error. */
export const CODE_WORKFLOW_NOT_SET =
  'the sign-in takes its one-time code from a workflow, but no One-Time Code Workflow is set (Options → One-Time Code Workflow)';
export const codeWorkflowTimedOut = (seconds: number) => `the one-time code workflow did not return a code within ${seconds} s`;
export const CODE_WORKFLOW_NOT_A_CODE = 'the one-time code workflow did not return a code of 6 to 10 digits';
export const codeWorkflowFailed = (message: string) => `the one-time code workflow failed: ${message}`;
export const CODE_WORKFLOW_REJECTED_TWICE = 'the site rejected the one-time code from the workflow twice';
/** The agent's two-page sign_in typed the username and moved to the password page, but never ran its second call. */
export const AGENT_SIGN_IN_UNFINISHED = 'the agent typed the username but did not finish signing in on the password page';

// Shape, locators, verification and the start page.
export const FIRST_STEP_GOTO = 'the first step must be goto to an absolute URL, or set startUrl';

/** A locator as the node UI names it (Find by + value). */
export const describeForUser = (loc: Locator): string => {
  if ('role' in loc) return `Role and Name ${loc.role}${loc.name !== undefined ? ` "${loc.name}"` : ''}`;
  if ('label' in loc) return `Form Label "${loc.label}"`;
  if ('text' in loc) return `Visible Text "${loc.text}"`;
  if ('testId' in loc) return `Test ID "${loc.testId}"`;
  return `CSS Selector "${loc.css}"`;
};
const locatorSuggestion = (desc: string): string =>
  desc.startsWith('Visible Text ') || desc.startsWith('Form Label ')
    ? 'Check the spelling or try Find by: Role and Name.'
    : 'Check the spelling or try Find by: Visible Text.';
export const locatorNotFound = (desc: string, url: string, seconds: number): string =>
  `No element found for ${desc} on ${url} after ${seconds} s. ${locatorSuggestion(desc)}`;
export const locatorNotUnique = (desc: string, count: number): string =>
  `${desc} matches ${count} elements. Use a more specific locator; it must match exactly one.`;
export const countMismatch = (expected: number, stated: string, found: number): string =>
  `Expected ${expected} rows (the page says "${stated}") but found ${found}. Nothing was marked successful.`;
export const notReachedNetworkIdle = (seconds: number): string => `the page did not reach network idle within ${seconds} s`;
export const notLoaded = (seconds: number): string => `the page did not finish loading within ${seconds} s`;
export const BROWSER_ERROR_PAGE = 'the browser showed an error page instead of the site';
export const tooManyRows = (n: number): string => `limit: more than ${n} rows`;

// Capture verbs and output limits.
export const PDF_NEEDS_HEADLESS = 'capture: Save as PDF needs headless Chromium';
export const PAGE_SHOWS_CREDENTIAL = 'the page shows a credential';
export const NOT_A_TABLE = (desc: string): string => `${desc} is not a table`;
export const screenshotTooTall = (h: number): string => `limit: the page is ${h} px tall; screenshots are limited to 16384 px`;
export const captureTooLarge = (what: 'screenshot' | 'PDF', bytes: number): string => `limit: the ${what} is ${bytes} bytes; the limit is 52428800 bytes`;
export const runBinaryTooLarge = (bytes: number): string => `limit: the run produced ${bytes} bytes of files; the limit is 262144000 bytes`;
/** The text of every row of one run together. */
export const rowTextTooLarge = (bytes: number): string => `limit: the rows hold ${bytes} bytes of text; the limit is 20971520 bytes`;
// Capture failures.
export const FRAME_NOT_CHECKED = 'capture: a frame on the page could not be checked for credentials';
export const PDF_TIMED_OUT = 'capture: the PDF could not be made: timed out';
export const elementTooTall = (h: number): string => `limit: the element is ${h} px tall; screenshots are limited to 16384 px`;

// Writes.
export const PASSWORD_FILL_REFUSED = 'Fill and Submit Form cannot fill password fields. For sites behind a login, use Run Steps with a Site Login.';
export const PASSWORD_FILL_REFUSED_STEPS = 'fill cannot type into a password field: passwords are typed only by signIn with a Site Login';
export const formPostsElsewhere = (host: string, hosts: string[]): string => `the form posts to ${host}, which is not allowed. This run only submits to ${hosts.join(', ')}.`;
export const WINDOW_STEP_NOT_CLICK = 'the write window must be on a click step';
export const renderedTooLong = (n: number): string => `limit: a rendered value is longer than ${n} characters`;
export const inputTooLong = (name: string, n: number): string => `limit: input "${name}" is longer than ${n} characters`;

// Repair rules.
export const REPAIR_NEEDS_ID_AND_EXTRACT = 'AI repair needs an ID Pattern and an extract step.';
export const REPAIR_REFUSED_WRITES = 'AI repair is not available for steps that submit forms or download through a form.';
export const FIRST_RUN_NEEDS_NAME = 'A first run needs a name: set Options → Name.';
export const REPAIR_ALREADY_RAN = 'AI repair already ran in this execution';
/** Appended to a script-lane drift when a two-page sign-in typed the username but no password was submitted. */
export const REPAIR_SIGN_IN_HALF_DONE = 'AI repair cannot finish a sign-in whose username was already typed: fix the signIn step by hand';
export const NO_STEPS_NO_REPAIR = 'there are no steps yet and AI repair is off';
export const COMPILE_TOUCHES_SUBMIT = 'the repair would drop or change a form submission step';
export const COMPILE_EMITS_SUBMIT = 'repaired steps never contain a submit step';
// Repair is for data feeds.
export const REPAIR_NO_CAPTURES =
  'AI repair works only on steps that extract rows or download one file: remove screenshot, PDF, read and table steps, or turn AI Repair off';
// Repair of a document that downloads one checked file.
export const REPAIR_ONE_DOWNLOAD = 'AI repair of a download needs exactly one download step, outside paginate, and no extract step.';
export const REPAIR_DOWNLOAD_NEEDS_CHECK =
  'AI repair of a download needs a check on the download step that names the file or its columns (check.name or check.columns).';
export const FIRST_RUN_NEEDS_TARGET =
  'A first run needs either an ID Pattern (to read rows) or an Expected File with a file name pattern or required columns (to download a file), not both.';
// A first run's Expected File meets the download step rules before the browser opens.
export const expectedFileInvalid = (issues: string[]) => `Expected File: ${issues.join('; ')}`;
export const FILE_WITHHELD = 'the repaired steps did not pass the proof, so the downloaded file was not delivered';
// A file task never succeeds without its file.
export const FILE_NOT_DELIVERABLE = 'the proof passed but there is no downloaded file to deliver, so nothing was delivered';
export const ROWS_WITHHELD ='the repaired steps did not pass the proof, so the rows were not delivered (turn on Options → Deliver Unconfirmed Rows to receive them)';
export const COMPILE_CHANGES_FILE_CHECK = 'a repair may not change the file checks of the download step';
// A CDP connection cannot read downloaded files, so the node refuses before the browser opens.
export const DOWNLOAD_NEEDS_BROWSER_SERVER =
  'Downloads need the Browser Server or Local Browser mode: a Chrome DevTools Protocol (CDP) connection cannot read downloaded files. Pick an RPA Browser credential in Browser Server mode for this node.';

// Imports (Chrome Recorder, Playwright code, UiPath). Golden: tests assert them verbatim.
export const IMPORT_NEEDS_SITE_LOGIN = 'The recording signs in: attach an RPA Site Login so the import can sign in without the typed password.';
export const IMPORT_REFUSES_WRITES = 'Imported steps that submit a form or post to download cannot be adopted: repair and import never write.';
export const IMPORT_NOT_ADOPTABLE =
  'These steps read no rows and download no file, so there is nothing to prove: the draft is returned for review but cannot be signed.';
export const IMPORT_UNSUPPORTED_TARGET = 'Only JavaScript or TypeScript Playwright code can be imported; record with --target javascript.';
export const IMPORT_EMPTY = 'Nothing in this file could be turned into steps.';
export const IMPORT_PROOF_FAILED = 'The imported steps ran, but replaying them in a fresh browser did not pass the proof, so there is nothing to sign';

// Desktop step sets and the desktop runner. Golden: tests assert them verbatim.
/** A desktop step set reached the browser lane (parseScript), or the reverse. */
export const DESKTOP_STEPS_NEED_RUNNER = 'these are desktop steps (surface "desktop"): they run on a desktop runner, never in a browser. Attach an RPA Desktop Runner credential.';
export const BROWSER_STEPS_NEED_BROWSER = 'these are browser steps: they run in a browser, never on a desktop runner. Attach an RPA Browser credential.';
export const reservedTemplate = (path: string, name: string) => `${path} uses {{${name}}}: names that start with $ are reserved`;
export const exportDirOnlyInFill = (path: string) => `${path} uses {{$exportDir}}, which is allowed only in the value of a desktop fill step`;
export const browserStepOnDesktop = (path: string, verb: string) => `${path}: "${verb}" is a browser step, not allowed in a desktop step set`;
export const browserLocatorOnDesktop = (path: string, kind: string) => `${path} uses the browser locator "${kind}": desktop step sets find elements with { uia }`;
export const desktopLocatorInBrowser = (path: string) => `${path} uses { uia }, which is allowed only in a desktop step set (surface "desktop")`;
export const DESKTOP_UNSIGNED_WRITES =
  'Unsigned desktop steps cannot run a write step (write: true). Sign them, or turn on Options → Allow Unsigned Writes.';
export const RUNNER_URL_NOT_SECURE = 'The desktop runner URL must start with wss://: plain ws:// is refused.';
export const RUNNER_URL_HAS_CREDENTIALS = 'The desktop runner URL must not carry a token or a user name: put the token in the Token field.';
export const RUNNER_FINGERPRINT_INVALID =
  'The certificate fingerprint must be the SHA-256 fingerprint the runner prints at start: 64 hexadecimal digits, colons optional.';
export const runnerUnreachable = (where: string, why: string) => `Could not connect to the desktop runner at ${where} (${why}). Is it running, and is the port open?`;
export const runnerFingerprintMismatch = (where: string, presented: string) =>
  `The desktop runner at ${where} presented a certificate with fingerprint ${presented}, which is not the fingerprint in the RPA Desktop Runner credential. Nothing was sent.`;
export const runnerTokenRefused = (where: string) => `The desktop runner at ${where} refused the token. Check the Token in the RPA Desktop Runner credential.`;
export const RUNNER_DISCONNECTED = 'the desktop runner closed the connection';
export const RUNNER_BUSY = 'the desktop runner is busy with another run';
/** app.launch answered not_found: the allowed app is not installed where the runner's policy says. */
export const runnerAppMissing = (exe: string) =>
  `the desktop runner could not start ${exe}: it is not installed at the path the runner's policy names (allowedApps[].path). Install it there or correct the policy`;
export const desktopNotInteractive = (locked: boolean) =>
  locked ? 'the desktop runner\'s Windows session is locked: unlock it or sign the runner user in again' : 'the desktop runner is not in an interactive Windows session';
/** The credential test's success message, with the Windows session's state as the runner reports it. */
export const runnerConnected = (session: { interactive?: boolean; locked?: boolean }) =>
  `Connected to the desktop runner (session ${session?.locked ? 'locked' : session?.interactive ? 'interactive' : 'not interactive'})`;
