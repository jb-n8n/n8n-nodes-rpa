// Data-feed fixtures for the v2 operations (Run Steps, Sign Steps), shared by the node's sandbox tests and the
// acceptance suite. The Site Login id matters: Sign Steps binds it into the signature and Run Steps checks it.
import type { ICredentialDataDecryptedObject, IDataObject } from 'n8n-workflow';
import * as engine from 'n8n-rpa-engine';
import type { Proposal, Script } from 'n8n-rpa-engine';
import type { NodeContext } from '../nodes/Playwright/context.js';
import { repairedStepsJson } from '../nodes/Playwright/output.js';
import { APPROVER, SECRETS, SIGNING_KEY } from './fixtures.js';
import { harness } from './harness.js';

export type Site = { url: string; host: string };
export const FEED_NAME = 'demo-sandbox';
export const SITE_LOGIN_ID = 'site-login-1';
export const ID_PATTERN = 'N26-\\d{4}';
/** Template 2's Stated Total Pattern: the engine checks a stated total only when one is set. */
export const TOTAL_PATTERN = 'Showing \\d+-\\d+ of (\\d+)';
export const GOAL = 'Read every current bulletin on the Service pages, safety campaigns and stop-sales included, across all pages. Bulletin IDs look like N26-0417.';

export function siteLoginData(site: Site, password: string = SECRETS.password): ICredentialDataDecryptedObject {
  return {
    loginUrl: `${site.url}/acme/login`, username: SECRETS.username, password, totpSecret: SECRETS.totpSecret, navHosts: site.host,
    subresourceHosts: '', frameHosts: '', login: `${site.host}/acme/login\n${site.host}/acme/mfa`, allowedSubmits: `POST ${site.host}/acme/reports/export`,
  };
}

/** Browser (local headless), Step Signing, and a Site Login for `site` when one is given. */
export function credentialsV2(site: Site | undefined, o: { password?: string; browser?: ICredentialDataDecryptedObject } = {}): Record<string, ICredentialDataDecryptedObject> {
  return {
    playwrightBrowserApi: o.browser ?? { mode: 'local', headless: true },
    playwrightScriptSigningApi: { secretKey: SIGNING_KEY },
    ...(site ? { playwrightSiteLoginApi: siteLoginData(site, o.password) } : {}),
  };
}

/**
 * The test harness with every attached credential's id set: the Site Login gets `siteLoginId` (default SITE_LOGIN_ID,
 * the id Sign Steps binds and Run Steps checks), every other type `<type>-1`.
 */
export function nodeContext(o: Parameters<typeof harness>[0] & { siteLoginId?: string }): NodeContext {
  const { siteLoginId, ...options } = o;
  const ids = Object.fromEntries(
    Object.keys(options.credentials ?? {}).map((type) => [type, type === 'playwrightSiteLoginApi' ? (siteLoginId ?? SITE_LOGIN_ID) : `${type}-1`]),
  );
  return harness({ ...options, credentialIds: { ...ids, ...options.credentialIds } });
}

/**
 * A Repaired steps item for `steps` exactly as Run Steps emits one (output.ts repairedStepsJson: the full safety flags,
 * the digest over them and the three review lines; no screenshots).
 */
export function repairedItem(steps: Script, baseVersion: number | null, evidence: { count: number; total: number | null } = { count: 7, total: 7 }): IDataObject {
  const proposal: Proposal = {
    name: String(steps.name), baseVersion, version: Number(steps.version), steps, hash: engine.scriptHash(steps),
    evidence: { ...evidence, diff: { missing: [], extra: [] } }, changes: [], safetyFlags: [], screenshots: {},
  };
  return repairedStepsJson(engine, proposal);
}

/** Run Steps parameters for a signed record from Sign Steps (or none for a first run), the way the data-feed template sets them. */
export function runStepsParams(signed: IDataObject | undefined, over: Record<string, unknown> = {}, options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'runSteps', steps: signed?.steps ?? '', requireSignedSteps: true, signature: signed?.signature ?? '', approvedBy: signed?.approvedBy ?? '',
    aiRepair: false, goal: GOAL,
    options: {
      name: FEED_NAME, ...(signed ? { expectedVersion: String(signed.version) } : {}), idPattern: ID_PATTERN, totalPattern: TOTAL_PATTERN, allowPrivateNetwork: true, saveTrace: 'never', maxSeconds: 60,
      ...options,
    },
    ...over,
  };
}

export function signStepsParams(approved = true): Record<string, unknown> {
  return { operation: 'signSteps', approved, approverId: APPROVER, approverAllowlist: APPROVER };
}
