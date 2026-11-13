import type { INodeCredentialTestResult } from 'n8n-workflow';
import type { PortalPolicy } from 'n8n-rpa-engine';
import { browserConfig, desktopRunnerConfig, secretTargetsConfig, secretVariablesConfig, signingKey, siteLoginConfig, type CredentialData } from './config.js';
import type { Engine } from './engine.js';
import { pingRedis } from './redis-store.js';

/** A policy that allows no host: the endpoint test only connects and closes. */
const PROBE_POLICY: PortalPolicy = { startUrl: 'about:blank', navHosts: [], subresourceHosts: [], login: [], allowedSubmits: [] };
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const TOKEN_IN_URL_HINT = 'move the token from the URL to the Token field';

/** True when the endpoint URL itself carries a credential (a token= query or user:password@), which ends up in logs. */
export function urlCarriesToken(wsUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return /[?&]token=/i.test(wsUrl);
  }
  if (url.username || url.password) return true;
  return [...url.searchParams.keys()].some((k) => k.toLowerCase() === 'token');
}

export function scriptSigningResult(data: CredentialData): INodeCredentialTestResult {
  try {
    signingKey(data);
    return { status: 'OK', message: 'Signing key accepted' };
  } catch (error) {
    return { status: 'Error', message: reason(error) };
  }
}

/** Connects to Redis and PINGs; the error is the ConfigError message (no password in it). */
export async function redisTestResult(data: CredentialData, ping: typeof pingRedis = pingRedis): Promise<INodeCredentialTestResult> {
  try {
    await ping(data);
    return { status: 'OK', message: 'Connection successful' };
  } catch (error) {
    return { status: 'Error', message: reason(error) };
  }
}

/** How long Test connection waits for a free session when the browser service is busy. */
export const CREDENTIAL_TEST_WAIT_MS = 10_000;

/**
 * Connects to the RPA Browser endpoint and closes again. Errors are the engine's golden messages (token and query removed).
 * A browser service whose sessions stay busy for CREDENTIAL_TEST_WAIT_MS passes: its gate checks the token before it
 * looks for a free session, so the token and the address are proven even though no browser was opened.
 */
export async function browserTestResult(
  data: CredentialData, engine: Pick<Engine, 'openSession' | 'createMasker' | 'PLAYWRIGHT_VERSION'>,
  waitMs: number = CREDENTIAL_TEST_WAIT_MS,
): Promise<INodeCredentialTestResult> {
  let hint = '';
  try {
    const endpoint = browserConfig(data);
    hint = endpoint.wsUrl && urlCarriesToken(endpoint.wsUrl) ? `; ${TOKEN_IN_URL_HINT}` : '';
    const session = await engine.openSession({
      endpoint, policy: PROBE_POLICY, masker: engine.createMasker([endpoint.token]), deadlineMs: Date.now() + waitMs,
    });
    await session.close();
    const [major, minor] = engine.PLAYWRIGHT_VERSION.split('.');
    return { status: 'OK', message: `Connected to the browser server (${major}.${minor})${hint}` };
  } catch (error) {
    // The engine's NoFreeSessionError (matched by name: the engine is loaded lazily).
    if (error instanceof Error && error.name === 'NoFreeSessionError') {
      return { status: 'OK', message: `Connected; the browser service accepted the token but every browser session is busy right now${hint}` };
    }
    return { status: 'Error', message: reason(error) };
  }
}

export function siteLoginTestResult(data: CredentialData): INodeCredentialTestResult {
  try {
    const { policy } = siteLoginConfig(data);
    return {
      status: 'OK',
      message: `Valid: ${policy.navHosts.length} site(s) the browser may open, ${policy.login.length} password page(s), ${policy.allowedSubmits.length} form(s) it may submit`,
    };
  } catch (error) {
    return { status: 'Error', message: reason(error) };
  }
}

/**
 * Checks the RPA Secret Variables credential's names, values and May Be Typed Into; the message names the variables and
 * counts the apps and sites, never a value.
 */
export function secretVariablesTestResult(data: CredentialData): INodeCredentialTestResult {
  try {
    const secret = secretVariablesConfig(data);
    const names = Object.keys(secret);
    const targets = secretTargetsConfig(data, Object.values(secret));
    const where = targets ? `. May be typed into ${targets.apps.length} app(s) and ${targets.hosts.length} site(s) only` : '';
    return { status: 'OK', message: `Valid: ${names.length} secret variable(s)${names.length ? `: ${names.join(', ')}` : ''}${where}` };
  } catch (error) {
    return { status: 'Error', message: reason(error) };
  }
}

/**
 * Connects to the RPA Desktop Runner (the certificate is checked against the fingerprint before the token is sent),
 * calls hello and closes. Errors are the engine's messages: unreachable, wrong fingerprint, refused token.
 */
export async function desktopRunnerTestResult(data: CredentialData, engine: Pick<Engine, 'probeRunner' | 'runnerConnected'>): Promise<INodeCredentialTestResult> {
  try {
    const hello = await engine.probeRunner(desktopRunnerConfig(data));
    return { status: 'OK', message: engine.runnerConnected(hello.runner?.session ?? {}) };
  } catch (error) {
    return { status: 'Error', message: reason(error) };
  }
}
