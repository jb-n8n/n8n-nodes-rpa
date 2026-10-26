import type { Script, Step } from 'n8n-rpa-engine';

export const APPROVER = 'approver@example.com';
export const SIGNING_KEY = 'node-test-signing-key-0123456789abcdef';
export const SECRETS = { username: 'summit-ops', password: 'demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };

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
const INTERRUPTS = [
  { target: { css: '#cookie-overlay' }, click: { role: 'button', name: 'Accept all' } },
  { target: { css: '#whats-new' }, click: { css: '#whats-new-dismiss' } },
];

/** The script the sandbox's baseline release was written for (same as the engine test helper). */
export function baselineScript(url: string, version = 1): Script {
  return {
    name: 'demo-sandbox', version, startUrl: `${url}/acme/login`, interrupts: INTERRUPTS,
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

export function reportScript(url: string, version = 1): Script {
  return {
    name: 'demo-sandbox-report', version, startUrl: `${url}/acme/login`, interrupts: INTERRUPTS,
    steps: [
      ...SIGN_IN_STEPS,
      { intent: 'Open Reports', click: { role: 'link', name: 'Reports', exact: true, within: { role: 'navigation' } } },
      { intent: 'Set the start date', fill: { field: { label: 'From' }, value: '{{var.from}}' } },
      { intent: 'Export the report', download: { trigger: { role: 'button', name: 'Export CSV' }, via: { path: '/acme/reports/export' }, mime: ['text/csv'] } },
    ],
  };
}

