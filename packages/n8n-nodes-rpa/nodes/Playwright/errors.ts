import { NodeOperationError, type IDataObject, type INode } from 'n8n-workflow';
import type { ErrorCode } from 'n8n-rpa-engine';

/** What a person should do about each code. Shown as the error description in n8n. */
export const GUIDANCE: Record<ErrorCode, string> = {
  login_failed: 'The site rejected the username or password. Correct them in the RPA Site Login credential, or, when its Username and Password are expressions, in the data they read: the next run tries once more. If they were right, type a new value (any text, such as today\'s date) in Options → Login Breaker Reset Key.',
  account_locked: 'The site says the account is locked. Unlock it with the site owner, then change Options → Login Breaker Reset Key.',
  auth_blocked: 'The site asked for a second factor that this run could not answer; the message says which. A push message or a hardware key needs a person to sign in.',
  site_down: 'The site did not answer, returned a server error, or the first page did not finish loading in time. Try again later.',
  browser_unavailable: 'The browser server could not be reached or was rejected. Check the RPA Browser credential (README: Where the browser runs).',
  drift_detected: 'A step did not find what it expected; the message says which step and what it found. Correct that step, or record it again, and approve the new version. Browser steps can also repair themselves with AI Repair.',
  not_found: 'The page or the data was not found.',
  incomplete: 'Not every row the page states was read, a capture failed, a limit was hit, the run timed out, or it was cancelled.',
  script_untrusted: 'Nothing ran: the steps are not signed, or their signature does not fit this node (another Step Signing key, Site Login, name, version or start site). Approve the steps again, or set the node up as it was when they were signed.',
  policy_violation: 'The run tried something its rules do not allow and stopped; the message says what was refused. If that was meant, change the rule that refused it where it is kept: in the RPA Site Login, the RPA Secret Variables credential, this node\'s Options, or the desktop runner\'s policy on the Windows machine. For a desktop step that saves or sends, the rule is its mark as a write, set when its steps are approved.',
  locked_out: 'No login was tried, because an earlier login of this account failed. Correct the username or password in the RPA Site Login credential, or, when its Username and Password are expressions, in the data they read, and run again: a changed login gets one try. If the login was right, or the account is unlocked now, type a new value (any text) in Options → Login Breaker Reset Key.',
  busy: 'Another run using this Site Login or desktop runner is in progress. This run was skipped.',
  password_change_failed: 'The site did not confirm the new password: its change-password page came back, or still showed when the wait for its answer ran out (then the new password may or may not be in force). The login breaker stays closed. Keep the pending password, and check the site\'s password rules and the run variable that holds it.',
  runner_unavailable: 'n8n could not use the desktop runner; the message says why. Check the RPA Desktop Runner credential, then run rpa status on the runner machine.',
};

/** auth_blocked because the One-Time Code Workflow gave no code (the engine's `the one-time code workflow …` failures). */
export const CODE_WORKFLOW_GUIDANCE =
  'The One-Time Code Workflow gave no code; the message says why. Run that workflow by itself until it returns one item with a code field, publish it, then run again.';
/**
 * auth_blocked because the steps type a code and the Site Login has no TOTP Secret (`detected:mfa_totp: …`). A detect
 * step that found a check named mfa_totp fails with the bare `detected:mfa_totp`, which this does not match.
 */
export const NO_TOTP_SECRET_GUIDANCE =
  'The site asked for a one-time code and the RPA Site Login has no TOTP Secret. Put the authenticator\'s seed in its TOTP Secret. To take the code from a workflow instead, set Options → One-Time Code Workflow (steps you wrote also need "source": "workflow" in the sign-in step).';
/** policy_violation because a sign-in met an address the Site Login does not list as a login page (the engine's signIn refusals). */
export const LOGIN_PAGE_GUIDANCE =
  'The sign-in stopped at an address that is not listed as a login page. Add the address the message names to Pages Where the Password May Be Typed in the RPA Site Login, then run again.';
/** site_down because the browser could not reach the site's address: a name not found, a refused connection, a certificate. */
export const SITE_ADDRESS_GUIDANCE =
  'The browser could not reach the site at its address; the message says what it met. Check the address the steps open (and the start site), and that the site is up, then run again.';
/** policy_violation because a field did not take a step's value (the engine's valueNotTaken: text in a date field). */
export const VALUE_NOT_TAKEN_GUIDANCE =
  "A step's value does not fit its field; the message says which step and field. Correct that value in the steps (on the import form: Change the steps), or record the step again, and approve the new version.";
/** locked_out because a run changed the Site Login's password earlier in this execution (execute.ts SITE_LOGIN_PASSWORD_CHANGED). */
export const PASSWORD_CHANGED_GUIDANCE =
  'A run changed this Site Login\'s password earlier in this execution. Store the new password where the Site Login reads it, then run again.';

/**
 * A sign-in that failed on its one-time code: every failure of a code from the One-Time Code Workflow (`detected:mfa_code: …`,
 * a code the site rejected twice included), or no TOTP Secret for a code the site asked for (`detected:mfa_totp: …`).
 */
export function failedOnCode(code: ErrorCode, message: string): boolean {
  return code === 'auth_blocked' && (message.includes('detected:mfa_code: ') || message.includes('detected:mfa_totp:'));
}

/**
 * The guidance for a failure: by its code, and where the message names the cause (a one-time code, an unlisted login
 * page, a password changed earlier in the execution), for that cause.
 */
export function guidanceFor(code: ErrorCode, message: string): string {
  if (code === 'auth_blocked' && message.includes('one-time code workflow')) return CODE_WORKFLOW_GUIDANCE;
  if (code === 'auth_blocked' && message.includes('detected:mfa_totp:')) return NO_TOTP_SECRET_GUIDANCE;
  if (code === 'policy_violation' && message.includes('Pages Where the Password May Be Typed')) return LOGIN_PAGE_GUIDANCE;
  if (code === 'policy_violation' && message.includes(' did not take the value ')) return VALUE_NOT_TAKEN_GUIDANCE;
  if (code === 'site_down' && /net::ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED|CERT_|SSL_)/.test(message)) return SITE_ADDRESS_GUIDANCE;
  if (code === 'locked_out' && message.includes('was changed earlier in this execution')) return PASSWORD_CHANGED_GUIDANCE;
  return GUIDANCE[code];
}

/**
 * A failure's message as the node shows it. The engine marks a sign-in or detect outcome `detected:<outcome>: ` (or a
 * bare `detected:<outcome>`) so that classify.ts can tell the code; the reader learns nothing from the mark, so it is
 * left out, and a bare one keeps the outcome's name. guidanceFor and failedOnCode read the engine's own message.
 */
export const shownMessage = (message: string): string => message.replace(/detected:([A-Za-z0-9_]+)(?:: |$)/g, (whole, outcome: string) => (whole.endsWith(': ') ? '' : outcome));

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
  /**
   * What a person should do (guidanceFor): the node error's description without its code. On the item too, because a
   * workflow that sends failures to the error output (as the generated ones do) never shows that description. Fixed
   * text chosen by the code and the masked message: it holds nothing from the run.
   */
  guidance: string;
  /** Run Steps with a Site Login: the user name it signs in with (never the password or a code). */
  account?: string;
}

/** A failed run as a NodeOperationError: message `<code>: <message>`, its guidance (guidanceFor) as description. */
export function stepsRunError(node: INode, d: FailureDetails, itemIndex: number): NodeOperationError {
  const message = `${d.code}: ${d.message}`;
  const error = new NodeOperationError(node, message, { description: `${d.code}: ${d.guidance}`, itemIndex });
  error.message = message;
  Object.assign(error.context, {
    code: d.code, name: d.name, version: d.version, hash: d.hash, lane: d.lane, stepIntent: d.stepIntent, traceRef: d.traceRef, submitted: d.submitted,
    ...(d.passwordChanged ? { passwordChanged: true } : {}),
  });
  return error;
}

/** What to do about a configuration problem: the description of configNodeError, and `guidance` on its error item. */
export const CONFIG_GUIDANCE = 'Check the node parameters and the RPA credentials.';

/** A configuration problem (parameters or credentials) as a NodeOperationError whose message is the problem itself. */
export function configNodeError(node: INode, message: string, itemIndex: number): NodeOperationError {
  const error = new NodeOperationError(node, message, { itemIndex, description: CONFIG_GUIDANCE });
  error.message = message;
  Object.assign(error.context, { configError: true, code: null });
  return error;
}
