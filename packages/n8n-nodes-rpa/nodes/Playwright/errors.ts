import { NodeOperationError, type IDataObject, type INode } from 'n8n-workflow';
import type { ErrorCode } from 'n8n-rpa-engine';

/** What a person should do about each code. Shown as the error description in n8n. */
export const GUIDANCE: Record<ErrorCode, string> = {
  login_failed: 'The site rejected the username or password. The login breaker is now open: fix the RPA Site Login credential, then change Options → Login Breaker Reset Key.',
  account_locked: 'The site says the account is locked. Unlock it with the site owner, then change Options → Login Breaker Reset Key.',
  auth_blocked: 'The site asked for a second factor the node cannot answer. A person has to sign in.',
  site_down: 'The site did not answer, returned a server error, or the first page did not finish loading in time. Try again later.',
  browser_unavailable: 'The browser server could not be reached or was rejected. Check the RPA Browser credential (README: Where the browser runs).',
  drift_detected: 'The page no longer matches the steps: an element was not found or matched more than one. Fix the locator, or use Run Steps with AI repair.',
  not_found: 'The page or the data was not found.',
  incomplete: 'Not every row the page states was read, a capture failed, a limit was hit, the run timed out, or it was cancelled.',
  script_untrusted: 'The steps are not signed by the Step Signing key, or the signature does not match their name, version, start site, Site Login, approver or the expected version. Nothing ran.',
  policy_violation: 'The steps or the page tried something not allowed: an unlisted or private site, a write, a password field, or a secret outside sign-in. The run stopped.',
  locked_out: 'An earlier login failed and the breaker is open. Check the account, then change Options → Login Breaker Reset Key.',
  busy: 'Another run using this Site Login is in progress. This run was skipped.',
};

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
}

/** A failed run as a NodeOperationError: message `<code>: <message>`, its GUIDANCE text as description. */
export function stepsRunError(node: INode, d: FailureDetails, itemIndex: number): NodeOperationError {
  const message = `${d.code}: ${d.message}`;
  const error = new NodeOperationError(node, message, { description: `${d.code}: ${GUIDANCE[d.code]}`, itemIndex });
  error.message = message;
  Object.assign(error.context, {
    code: d.code, name: d.name, version: d.version, hash: d.hash, lane: d.lane, stepIntent: d.stepIntent, traceRef: d.traceRef, submitted: d.submitted,
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
