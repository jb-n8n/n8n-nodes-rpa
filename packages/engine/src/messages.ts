import type { Locator } from './types.js';

// User-facing texts that several modules share, or that the node and its tests name. A text used in one place stays
// next to its code. Tests assert them verbatim, and test/wording.test.ts checks that none of these contains a use-case word.

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
/** Also what steps signed with an earlier Step Signing key get: the way back is the import form's sign-again page. */
export const UNSIGNED_REQUIRED =
  'The steps are not signed, or the signature is not valid, and Require Signed Steps is on. '
  + 'To sign a bot again, for example after the signing key changed, open the import form, leave Bot file empty and type the bot\'s name. '
  + 'Steps used without the form: sign them with Sign Steps first.';
export const SIGNATURE_INVALID =
  'The signature is not valid for these steps: it does not match their name, version, start site, Site Login or approver.';
export const SIGNATURE_WITHOUT_KEY = 'a signature is present but no Step Signing credential is attached';
export const UNSIGNED_WRITES =
  'Unsigned steps cannot sign in, submit a form or download through a form. Sign them with Sign Steps, or turn on Options → Allow Unsigned Writes.';
export const UNSIGNED_SECRET_FILL =
  'Unsigned steps cannot type a secret into a password field (fill with secret: true). Sign them with Sign Steps; Allow Unsigned Writes does not cover it.';
/** A desktop fill of a secret variable in unsigned steps: as a secret fill in the browser, only signed steps type one. */
export const UNSIGNED_SECRET_VARIABLE = 'Unsigned steps cannot type a secret variable. Sign them with Sign Steps; Allow Unsigned Writes does not cover it.';
/** A value of the RPA Secret Variables credential would be typed on a host its May Be Typed Into does not list. */
export const secretHostNotListed = (where: string) =>
  `A value from the RPA Secret Variables credential may not be typed on ${where}: the credential's May Be Typed Into does not list it.`;
/** A desktop run of an app the RPA Secret Variables credential's May Be Typed Into does not list: refused before the app starts. */
export const secretAppNotListed = (app: string) =>
  `The RPA Secret Variables credential's May Be Typed Into does not list ${app}, so this run may not start it. Add ${app} there, or remove the credential from this node.`;
/**
 * A signIn with changePassword in unsigned steps: refused at the trust gate before the browser opens, whatever Allow
 * Unsigned Writes says, and by the step itself before anything is typed.
 */
export const UNSIGNED_CHANGE_PASSWORD = 'Unsigned steps cannot set a new password (signIn.changePassword). Sign them with Sign Steps.';
export const nameMismatch = (signed: string, expected: string) => `the signed steps are named "${signed}", not "${expected}"`;
export const versionMismatch = (signed: number, expected: number) => `the signed steps are version ${signed}, but Expected Version is ${expected}`;
export const startSiteMismatch = (signed: string, expected: string) => `the signed steps start on ${signed}, but this run starts on ${expected}`;

// Network guard. Golden: tests assert them verbatim.
export const browserUnreachable = (url: string) =>
  `Could not connect to the browser server at ${url}. Is it running? With the compose stack: docker compose up -d browser; on a Windows machine, run rpa status there (README: Where the browser runs).`;
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
// A wss:// browser server with a self-signed certificate, trusted by the Certificate Fingerprint in the credential.
export const BROWSER_FINGERPRINT_INVALID = 'The certificate fingerprint must be 64 hexadecimal characters (SHA-256), with or without colons.';
export const BROWSER_FINGERPRINT_NEEDS_WSS = 'A certificate fingerprint needs a wss:// Endpoint URL in Browser Server mode.';
/** The server presented another certificate. No request and no token was sent to it; the TLS handshake, with the host name, was. */
export const BROWSER_FINGERPRINT_MISMATCH = "The browser server's certificate does not match the Certificate Fingerprint in the RPA Browser credential.";
/**
 * A connection over wss:// or https:// met a certificate that n8n's Node.js process does not trust (self-signed, an
 * unknown issuer, expired, or another host name), and no fingerprint is set. When the handshake that failed was the
 * one with the configured address itself, no request and no token was sent. The failure can also come after the
 * configured server received the request and the token: it redirected the connection to a host whose certificate is
 * not trusted, or, in CDP mode, its discovery answer named such a host.
 */
export const BROWSER_CERT_NOT_TRUSTED =
  "n8n does not trust the browser server's certificate. If the server uses a certificate of its own, put its SHA-256 fingerprint in Certificate Fingerprint (SHA-256) on the RPA Browser credential.";
/** The same in Chrome DevTools Protocol mode, where the credential has no Certificate Fingerprint field. */
export const BROWSER_CERT_NOT_TRUSTED_CDP =
  "n8n does not trust the browser server's certificate. Use a certificate that n8n's Node.js process trusts, for example one from an authority listed in NODE_EXTRA_CA_CERTS.";
export const notHttp = (protocol: string) => `URL must start with http:// or https:// (got "${protocol}").`;
export const privateAddress = (host: string) =>
  `Blocked: ${host} resolves to a private network address. Turn on Options → Allow Private Network if this site is on your own network.`;
export const offListSite = (host: string, navHosts: string[]) =>
  `Blocked: the page tried to open ${host}, which is not allowed. This run only visits ${navHosts.join(', ')}. Add it under Options → Also Allow These Sites if this is expected.`;
/** A fatal violation with no more specific message (writes, sockets, sign-in refusals): the v1 text. */
export const BLOCKED_REQUEST = 'a blocked request was attempted during the run';
/**
 * A blocked write, named: `request` is `METHOD host/path` (no query; session segments masked as `(…)`), `readLine` the
 * same as a Requests That Only Read line (a masked segment written with *). A site that posts to read (SAP) is the common
 * case; a real write needs a declared submission.
 */
export const blockedPost = (request: string, readLine: string) =>
  `${BLOCKED_REQUEST}: ${request}. If it only reads data, list it in the RPA Site Login under Requests That Only Read, as ${readLine}; if it saves or sends, only a step that submits may send it, listed under Forms It May Submit.`;
export const blockedWrite = (request: string) =>
  `${BLOCKED_REQUEST}: ${request}. Only a step that submits may send it, listed in the RPA Site Login under Forms It May Submit.`;
/** A main-frame navigation the destructive-action denylist refused (agent and replay sessions). */
export const blockedActionAddress = (request: string) =>
  `${BLOCKED_REQUEST}: ${request}. Its address looks like an action (such as delete, send or sign out), which this run does not open.`;
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
/** A signIn with totp.via: the code field did not show within the step timeout after the password or the last via click (drift). */
export const signInCodeFieldMissing = (seconds: number, clicked: number, total: number) =>
  `signIn: the one-time code field did not appear within ${seconds} s after the password was submitted (${clicked} of ${total} totp.via clicked)`;
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
/**
 * For signed steps, in place of locatorSuggestion: their owner cannot change a locator on the node ("Find by" is a field
 * of a node whose steps are typed in), so the message names the two ways on.
 */
export const SIGNED_CONTROL_GONE =
  'The page no longer has that control. To go on, change the bot on the import form, or let self-repair fix it if it is set up (AI Repair on the RPA node).';
/** A step failure of signed steps: the Find-by advice of locatorNotFound replaced by SIGNED_CONTROL_GONE; anything else unchanged. */
export const signedStepMessage = (message: string): string =>
  message.replace(/Check the spelling or try Find by: (?:Visible Text|Role and Name)\./, SIGNED_CONTROL_GONE);
export const locatorNotFound = (desc: string, url: string, seconds: number): string =>
  `No element found for ${desc} on ${url} after ${seconds} s. ${locatorSuggestion(desc)}`;
export const locatorNotUnique = (desc: string, count: number): string =>
  `${desc} matches ${count} elements. Use a more specific locator; it must match exactly one.`;
export const countMismatch = (expected: number, stated: string, found: number): string =>
  `Expected ${expected} rows (the page says "${stated}") but found ${found}. Nothing was marked successful.`;
export const notReachedNetworkIdle = (seconds: number): string => `the page did not reach network idle within ${seconds} s`;
export const notLoaded = (seconds: number): string => `the page did not finish loading within ${seconds} s`;
export const BROWSER_ERROR_PAGE = 'the browser showed an error page instead of the site';

/** What the browser's network errors that a first run meets mean, by Chromium's name for them (net::ERR_…). */
const NETWORK_SENTENCES: [RegExp, (host: string) => string][] = [
  [/^ERR_NAME_NOT_RESOLVED$/, (h) => `${h} could not be found: no site answers to that name. Check the address, and that the site is up.`],
  [/^ERR_CONNECTION_REFUSED$/, (h) => `${h} refused the connection: nothing answers at that address and port. Check the address, and that the site is up.`],
  [/^ERR_(CONNECTION_)?TIMED_OUT$/, (h) => `${h} did not answer in time. Check the address, or try again later.`],
  [/^ERR_(CERT_[A-Z_]+|SSL_[A-Z_]+|BAD_SSL_CLIENT_AUTH_CERT)$/, (h) => `The certificate of ${h} was not accepted: it may have expired, be made by the site itself, or name another site. Check the address, or the site's certificate.`],
];
/**
 * A browser error that names a network failure (`page.goto: net::ERR_NAME_NOT_RESOLVED at http://site/x`) as a sentence
 * that names the site and says what happened, with the browser's own text after it in brackets for support; any other
 * text unchanged. The bracketed text keeps `net::ERR_`, which classify.ts reads (site_down).
 */
export function networkSentence(text: string): string {
  const m = /net::(ERR_[A-Z_]+)(?: at (\S+))?/.exec(text);
  if (!m) return text;
  const say = NETWORK_SENTENCES.find(([re]) => re.test(m[1]))?.[1];
  if (!say) return text;
  const url = m[2] !== undefined && URL.canParse(m[2]) ? new URL(m[2]) : undefined;
  return `${say(url ? url.host : 'The site')} (browser: ${text.trim()})`;
}

/** The part of a fill's failure that says the field did not take the value: classify.ts reads it (policy_violation). */
export const VALUE_NOT_TAKEN = ' did not take the value ';
/** A fill whose value the field's type refuses (Playwright's "Malformed value", for example text in a date field). */
export const valueNotTaken = (field: string, value: string, raw: string): string =>
  `the field ${field}${VALUE_NOT_TAKEN}${value}: it does not fit that field, for example text in a date field (browser: ${raw.trim()})`;
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
export const PRESS_PASSWORD_REFUSED = 'press cannot send a key to a password field: passwords are typed only by signIn with a Site Login';
export const formPostsElsewhere = (host: string, hosts: string[]): string => `the form posts to ${host}, which is not allowed. This run only submits to ${hosts.join(', ')}.`;
export const WINDOW_STEP_NOT_CLICK = 'the write window must be on a click step';
/** A {{var.x}} in a locator of a step that writes or types secrets: a run variable must never steer a write. */
export const varInWriteLocator = (at: string): string => `${at}: {{var.*}} is not allowed in a locator of a step that writes or signs in; use a fixed locator`;
/** A `when` on a run variable on a step that signs in or writes (signIn, submit, download, the write window click). */
export const whenVarOnWrite = (at: string): string => `${at}.when may not use a variable on a step that signs in or writes`;
/** A `when` on a variable that a secret fill types: whether the step ran would tell whether the secret equals a literal. */
export const whenVarSecret = (at: string): string => `${at}.when may not test a variable that a secret fill types`;
/**
 * A {{var.x}} in a locator key the run never renders (label, testId, css, frame, role, a window selector, a UI Automation
 * controlType, automationId or className, any key of a pop-up handler): it would be matched as literal text.
 */
export const varNotRendered = (at: string): string => `${at}: {{var.*}} is never rendered here; a run variable is rendered only in the name of a Role and Name locator, the text of a Visible Text locator (both in steps, not in pop-up handlers) and the name of a UI Automation condition`;
export const renderedTooLong = (n: number): string => `limit: a rendered value is longer than ${n} characters`;
export const inputTooLong = (name: string, n: number): string => `limit: input "${name}" is longer than ${n} characters`;

// Repair rules.
export const REPAIR_NEEDS_ID_AND_EXTRACT = 'AI repair needs an ID Pattern and an extract step.';
export const REPAIR_REFUSED_WRITES = 'AI repair is not available for steps that submit forms or download through a form.';
export const FIRST_RUN_NEEDS_NAME = 'A first run needs a name: set Options → Name.';
export const REPAIR_ALREADY_RAN = 'AI repair already ran in this execution';
/** Appended to a script-lane drift when a two-page sign-in typed the username but no password was submitted. */
export const REPAIR_SIGN_IN_HALF_DONE = 'AI repair cannot finish a sign-in whose username was already typed: fix the signIn step by hand';
export const REPAIR_PASSWORD_CHANGE_HALF_DONE = 'AI repair cannot finish a password change whose fields were already typed: fix the signIn step by hand';
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
export const IMPORT_ROWS_NEED_ID =
  'These steps read rows, but a step that reads them has no idPattern, so the replay cannot check the rows: the draft is returned for review but cannot be signed. Give each extract and extractTable step an idPattern, the shape of the ID every row has, such as INV-\\d{4}.';
export const IMPORT_UNSUPPORTED_TARGET = 'Only JavaScript or TypeScript Playwright code can be imported; record with --target javascript.';
export const IMPORT_EMPTY = 'Nothing in this file could be turned into steps.';
export const IMPORT_PROOF_FAILED = 'The imported steps ran, but replaying them in a fresh browser did not pass the proof, so there is nothing to sign';

// Desktop step sets and the desktop runner. Golden: tests assert them verbatim.
/** A desktop step set reached the browser lane (parseScript), or the reverse. */
export const DESKTOP_STEPS_NEED_RUNNER = 'these are desktop steps (surface "desktop"): they run on a desktop runner, never in a browser. Attach an RPA Desktop Runner credential.';
export const BROWSER_STEPS_NEED_BROWSER = 'these are browser steps: they run in a browser, never on a desktop runner. Attach an RPA Browser credential.';
export const secretFillValue = (path: string) => `${path} must be exactly one {{var.name}} template (nothing before or after it) when secret is true`;
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
  'The certificate fingerprint must be the SHA-256 fingerprint rpa connection prints: 64 hexadecimal digits, colons optional.';
export const runnerUnreachable = (where: string, why: string) => `Could not connect to the desktop runner at ${where} (${why}). Is it running, and is the port open?`;
/**
 * Nothing answered the TCP connection itself: what to check, in order. `privateHost` is the line's host when it is a
 * private address (the installer's address on the route to n8n, which n8n outside that network cannot reach).
 */
export const runnerNoTcpAnswer = (where: string, seconds: number, privateHost?: string) =>
  `Could not connect to the desktop runner at ${where} (no answer within ${seconds} s). Check, in this order: `
  + '1. The address in the Connection Line is one n8n can reach. '
  + (privateHost
    ? `${privateHost} is a private address: if n8n is outside the Windows machine's network, print the line there in an administrator PowerShell with & "C:\\Program Files\\RPA Runner\\rpa.cmd" connection -ShowTokens -Address followed by the name or address n8n can reach, and paste it again. `
    : '')
  + '2. The port is open to n8n\'s address (Install-Rpa.ps1 -AllowFrom, and any firewall on the way). '
  + '3. The Windows machine is on and the runner runs there (rpa status).';
export const runnerFingerprintMismatch = (where: string, presented: string) =>
  `The desktop runner at ${where} presented a certificate with fingerprint ${presented}, which is not the fingerprint in the RPA Desktop Runner credential. Nothing was sent.`;
export const runnerTokenRefused = (where: string) => `The desktop runner at ${where} refused the token. Check the Token in the RPA Desktop Runner credential.`;
export const RUNNER_DISCONNECTED = 'the desktop runner closed the connection';
export const RUNNER_BUSY = 'the desktop runner is busy with another run';
/** clipboard.read answered "method not found": the runner predates clipboard reads. */
export const RUNNER_TOO_OLD_FOR_CLIPBOARD = 'the desktop runner is older than clipboard reads (clipboard.read): update the runner to read the clipboard';
/** app.launch answered not_found: the allowed app is not installed where the runner's policy says. */
export const runnerAppMissing = (exe: string) =>
  `the desktop runner could not start ${exe}: it is not installed at the path the runner's policy names (allowedApps[].path). Install it there or correct the policy`;
/** app.launch refused because the app is not in the runner's allowedApps (the runner's own text, exactly, is what task.ts recognises). */
export const runnerAppNotAllowed = (exe: string) =>
  `the desktop runner is not allowed to start ${exe}. On the Windows machine, allow it: in the RPA Recorder choose "Allow this app…" after saving a recording of it, or as an administrator run: & "C:\\Program Files\\RPA Runner\\rpa.cmd" policy apply followed by the path of the recording's .policy-change.json file`;
export const desktopNotInteractive = (locked: boolean) =>
  locked ? 'the desktop runner\'s Windows session is locked: unlock it or sign the runner user in again' : 'the desktop runner is not in an interactive Windows session';
/** A desktop step the runner refused: the step (numbered from 1, as the review page numbers it), then the runner's own words. */
export const desktopStepFailure = (number: number, intent: string, runnerSays: string): string => `Step ${number} (${intent}): ${runnerSays}`;

/** The credential test's success message, with the Windows session's state as the runner reports it. */
export const runnerConnected = (session: { interactive?: boolean; locked?: boolean }) =>
  `Connected to the desktop runner (session ${session?.locked ? 'locked' : session?.interactive ? 'interactive' : 'not interactive'})`;
