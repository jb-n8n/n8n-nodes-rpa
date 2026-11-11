import { NodeOperationError, type IDataObject, type INode } from 'n8n-workflow';
import type { ErrorCode } from 'n8n-rpa-engine';

/** What a person should do about each code. Shown as the error description in n8n. */
export const GUIDANCE: Record<ErrorCode, string> = {
  login_failed: 'The site rejected the username or password, so no further login is tried with them. Correct the username or password in the RPA Site Login credential: the next run then tries once (a changed TOTP Secret counts as a changed login too; a breaker that opened in 0.2.0 or earlier still needs a new reset key). If they were right and something else was wrong, type a new value (any text, such as today\'s date) in Options → Login Breaker Reset Key.',
  account_locked: 'The site says the account is locked. Unlock it with the site owner, then change Options → Login Breaker Reset Key.',
  auth_blocked: 'The site asked for a second factor this run could not answer: the first line says which. If nothing automatic can answer it (a push message, a hardware key), a person has to sign in.',
  site_down: 'The site did not answer, returned a server error, or the first page did not finish loading in time. Try again later.',
  browser_unavailable: 'The browser server could not be reached or was rejected. Check the RPA Browser credential (README: Where the browser runs).',
  drift_detected: 'A step did not find what it expected: an element was not found, matched more than one, or could not take the action (for example a disabled button). On a first run, correct the step\'s locator. On steps that used to work, the page or the app changed: correct the locator, or, for browser steps, use Run Steps with AI repair.',
  not_found: 'The page or the data was not found.',
  incomplete: 'Not every row the page states was read, a capture failed, a limit was hit, the run timed out, or it was cancelled.',
  script_untrusted: 'The steps are not signed by the Step Signing key, or the signature does not match their name, version, start site, Site Login, approver or the expected version. Nothing ran.',
  policy_violation: 'The run tried something its rules do not allow, and stopped; the first line says what. In a browser: an unlisted or private site, a write, a password field, or a secret outside sign-in. On a desktop: an app or a window the runner\'s policy does not allow, or a write that was not declared.',
  locked_out: 'No login was tried, because an earlier one failed. If the site rejected the username or password, correct it in the RPA Site Login credential and run again: a changed login (username, password or TOTP Secret) gets one try, but a breaker that opened in 0.2.0 or earlier still needs a new reset key. If the login was right, or the account has been unlocked, type a new value (any text) in Options → Login Breaker Reset Key and run again. Or a run changed the Site Login\'s password earlier in this execution: store the new password where the Site Login reads it, then run again.',
  busy: 'Another run using this Site Login or desktop runner is in progress. This run was skipped.',
  password_change_failed: 'The site did not confirm the new password: its change-password page came back, or still showed when the wait for its answer ran out (then the new password may or may not be in force). The login breaker stays closed. Keep the pending password, and check the site\'s password rules and the run variable that holds it.',
  runner_unavailable: 'The desktop runner could not be reached, refused the token or the certificate, its Windows session is locked or signed out, or the app is not installed where the runner\'s policy says. Check the RPA Desktop Runner credential and the runner machine. On a machine installed with -Unattended nobody needs to be signed in: check that the runner\'s address is reachable from n8n, then run Show-RpaConnection.ps1 and read supervisor.log on that machine.',
};

/** auth_blocked because the One-Time Code Workflow gave no code (the engine's `the one-time code workflow …` failures). */
const CODE_WORKFLOW_GUIDANCE =
  'The sign-in needed a one-time code from the One-Time Code Workflow and did not get one: the first line says why. Run that workflow by itself until it returns one item with a code field, publish it, then run again.';
/**
 * auth_blocked because the steps type a code and the Site Login has no TOTP Secret (`detected:mfa_totp: …`). A detect
 * step that found a check named mfa_totp fails with the bare `detected:mfa_totp`, which this does not match.
 */
const NO_TOTP_SECRET_GUIDANCE =
  'The site asked for a one-time code and the RPA Site Login has no TOTP Secret. Put the authenticator\'s seed in the Site Login, or take the code from a workflow: set Options → One-Time Code Workflow (in Run Steps or in a step document, also set "source": "workflow" in the sign-in step).';

/**
 * A sign-in that failed on its one-time code: every failure of a code from the One-Time Code Workflow (`detected:mfa_code: …`,
 * a code the site rejected twice included), or no TOTP Secret for a code the site asked for (`detected:mfa_totp: …`).
 */
export function failedOnCode(code: ErrorCode, message: string): boolean {
  return code === 'auth_blocked' && (message.includes('detected:mfa_code: ') || message.includes('detected:mfa_totp:'));
}

/** The guidance for a failure: by its code, and for auth_blocked by its message, which says what could not be answered. */
export function guidanceFor(code: ErrorCode, message: string): string {
  if (code === 'auth_blocked' && message.includes('one-time code workflow')) return CODE_WORKFLOW_GUIDANCE;
  if (code === 'auth_blocked' && message.includes('detected:mfa_totp:')) return NO_TOTP_SECRET_GUIDANCE;
  return GUIDANCE[code];
}

/**
 * The json of an item for n8n's error output. n8n replaces the json of any item that carries `item.error` with
 * `{ error: message }` (normalizeNodeErrors), so error items never set `item.error`. handleNodeErrorOutput instead
 * routes an item whose truthy `json.error` sits beside nothing but `message` and `details`, so every structured
 * field lives under `details`.
 */
export function errorJson(error: string, message: string, details: IDataObject): IDataObject {
  return { error, message, details };
}

/** `details` of a Run Steps (and quick operation) error item. Every structured field lives here (see errorJson). */
export interface FailureDetails extends IDataObject {
  code: ErrorCode;
  message: string;
  name: string | null;
  version: number | null;
  hash: string;
  lane: 'script' | 'agent' | null;
  stepIntent: string | null;
  traceRef: string | null;
  durationMs: number;
  /** Chat model tokens the run used (agent lane); 0 when the engine reports none. */
  llmTokens: number;
  log: IDataObject[];
  submitted: boolean;
  /** Present (true) when the sign-in set a new password before the run failed: the workflow must store it. */
  passwordChanged?: true;
}

/** A failed run as a NodeOperationError: message `<code>: <message>`, its guidance (guidanceFor) as description. */
export function stepsRunError(node: INode, d: FailureDetails, itemIndex: number): NodeOperationError {
  const message = `${d.code}: ${d.message}`;
  const error = new NodeOperationError(node, message, { description: `${d.code}: ${guidanceFor(d.code, d.message)}`, itemIndex });
  error.message = message;
  Object.assign(error.context, {
    code: d.code, name: d.name, version: d.version, hash: d.hash, lane: d.lane, stepIntent: d.stepIntent, traceRef: d.traceRef, submitted: d.submitted,
    ...(d.passwordChanged ? { passwordChanged: true } : {}),
  });
  return error;
}

/** A configuration problem (parameters or credentials) as a NodeOperationError whose message is the problem itself. */
export function configNodeError(node: INode, message: string, itemIndex: number): NodeOperationError {
  const error = new NodeOperationError(node, message, { itemIndex, description: 'Check the node parameters and the RPA credentials.' });
  error.message = message;
  Object.assign(error.context, { configError: true, code: null });
  return error;
}
