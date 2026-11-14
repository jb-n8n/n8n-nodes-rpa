import type { Script, Step } from 'n8n-rpa-engine';
import { RPA_NODE_TYPE } from '../nodes/Playwright/node-type.js';

export const APPROVER = 'approver@example.com';
export const SIGNING_KEY = 'node-test-signing-key-0123456789abcdef';
export const SECRETS = { username: 'summit-ops', password: 'demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };

/** Every node type and version the workflow generator may emit, as they exist in n8n 2.41 (nodes-base at tag n8n@2.41.0). */
export const WORKFLOW_NODE_TYPES: Record<string, number> = {
  'n8n-nodes-base.manualTrigger': 1,
  'n8n-nodes-base.stickyNote': 1,
  'n8n-nodes-base.dataTable': 1.1,
  // Version 2: Signature and Approved By on the Settings tab, RPA Redis behind a switch.
  [RPA_NODE_TYPE]: 2,
  'n8n-nodes-base.awsS3': 2,
  'n8n-nodes-base.extractFromFile': 1.1,
  'n8n-nodes-base.convertToFile': 1.1,
  'n8n-nodes-base.httpRequest': 4.2,
  'n8n-nodes-base.emailSend': 2.1,
  'n8n-nodes-base.wait': 1.1,
  'n8n-nodes-base.if': 2.2,
  // Ends a failed run as failed after the run log (StopAndError.node.ts at tag n8n@2.41.0 is version 1).
  'n8n-nodes-base.stopAndError': 1,
  // Off until a person sets the time (ScheduleTrigger.node.ts at tag n8n@2.41.0 has versions 1 to 1.2 and later).
  'n8n-nodes-base.scheduleTrigger': 1.2,
  // The run log's rows (Set at tag n8n@2.41.0 has version 3.4, as template 5's Settings).
  'n8n-nodes-base.set': 3.4,
};

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

