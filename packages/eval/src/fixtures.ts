import type { BrowserEndpoint, OutputSpec, PortalPolicy, PortalSecrets, Script, Step } from 'n8n-rpa-engine';

// Same baseline as the engine test helpers: the script the sandbox's baseline release was written for.
export const SIGNING_KEY = 'eval-signing-key';
export const APPROVER = 'eval@example.com';
export const SECRETS: PortalSecrets = { username: 'summit-ops', password: 'demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };
export const LOCAL: BrowserEndpoint = { mode: 'local', headless: true };
/** The data-feed template's Stated Total Pattern (the acceptance suite checks they agree). */
export const TOTAL_PATTERN = 'Showing \\d+-\\d+ of (\\d+)';
export const OUTPUT: OutputSpec = { idPattern: 'N26-\\d{4}', totalPattern: TOTAL_PATTERN };
/** The data-feed template's Run steps → Goal (the acceptance suite checks they agree). */
export const GOAL = 'Read every current stop-sale and safety campaign bulletin for this location (IDs look like N26-0417). The section may be renamed or moved in the menu; skip archived bulletins.';

export function policyFor(portal: { url: string; host: string }): PortalPolicy {
  return {
    startUrl: `${portal.url}/acme/login`,
    navHosts: [portal.host],
    subresourceHosts: [],
    login: [{ host: portal.host, path: '/acme/login' }, { host: portal.host, path: '/acme/mfa' }],
    allowedSubmits: [{ host: portal.host, path: '/acme/reports/export', method: 'POST' }],
    allowPrivateNetwork: true,
  };
}

const SIGN_IN_STEPS: Step[] = [
  {
    intent: 'Sign in',
    signIn: {
      username: { label: 'Dealer user ID' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Sign in' },
      totp: { field: { label: 'Authentication code' }, submit: { role: 'button', name: 'Verify' } },
    },
  },
  { intent: 'Skip the survey', when: { visible: { css: '#survey-later' } }, click: { css: '#survey-later' } },
  {
    intent: 'Check sign-in worked',
    detect: { name: 'afterLogin', checks: { logged_in: { css: 'body[data-page=home]' }, mfa_sms: { css: '#sms-code' }, login_failed: { css: '#login-error' } }, require: 'logged_in' },
  },
];

/**
 * The baseline as the agent's own first run builds it: compile anchors the sign-in detect on the first element clicked
 * after sign-in (here the Service nav link), not on a page attribute no release changes. The eval's default since
 * 2026-10-13: a release that hides the nav now breaks the detect, as it does for customers.
 */
export function bootstrapBaseline(url: string, version = 1): Script & { name: string; version: number } {
  const s = structuredClone(baselineScript(url, version));
  for (const step of s.steps) {
    if ('detect' in step) {
      step.detect.checks = {
        ...step.detect.checks,
        logged_in: { role: 'link', name: 'Service', exact: true, within: { role: 'navigation' }, fallbacks: [{ role: 'link', name: 'Service', exact: true }, { css: '#nav-service' }] },
      };
    }
  }
  return s;
}

/** A versioned, named script (both stay required here: the eval signs it). */
export function baselineScript(url: string, version = 1): Script & { name: string; version: number } {
  return {
    name: 'demo-sandbox',
    version,
    startUrl: `${url}/acme/login`,
    interrupts: [
      { target: { css: '#cookie-overlay' }, click: { role: 'button', name: 'Accept all' } },
      { target: { css: '#whats-new' }, click: { css: '#whats-new-dismiss' } },
    ],
    steps: [
      ...SIGN_IN_STEPS,
      { intent: 'Open Service', click: { role: 'link', name: 'Service', exact: true, within: { role: 'navigation' }, fallbacks: [{ css: '#nav-service' }] } },
      { intent: 'Open Recalls & Stop-Sales', click: { role: 'link', name: 'Recalls & Stop-Sales' }, expect: { heading: 'Recalls & Stop-Sales' }, checkpoint: true },
      {
        intent: 'Read every page of notices',
        paginate: {
          next: { text: 'Next page' }, until: 'absent', max: 10,
          each: [{ intent: 'Read notices on this page', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}', textMode: 'textContent' } }],
        },
      },
    ],
  };
}
