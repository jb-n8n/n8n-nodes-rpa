import { SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import type { TrustInput } from '../src/lane/trust.js';
import { signScript } from '../src/sign.js';
import type { BrowserEndpoint, FileCheck, PortalPolicy, PortalSecrets, Script, Step } from '../src/types.js';

export const TEST_KEY = 'test-signing-key';
export const APPROVER = 'tester@example.com';
export const SECRETS: PortalSecrets = { username: 'summit-ops', password: 'demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };
export const LOCAL: BrowserEndpoint = { mode: 'local', headless: true };

/**
 * A lane or task input for signed steps: the script, signed with TEST_KEY by APPROVER under a trust envelope that
 * requires the signature, then `rest` (whose keys win, a `trust` included).
 */
export function signedLaneInput<S, T extends object>(script: S, rest: T): { script: S; trust: TrustInput } & T {
  const { signature } = signScript(script, TEST_KEY, { approvedBy: APPROVER });
  return { script, trust: { required: true, signature, approvedBy: APPROVER, key: TEST_KEY }, ...rest };
}

export function policyFor(portal: { url: string; host: string }): PortalPolicy {
  return {
    startUrl: `${portal.url}/acme/login`,
    navHosts: [portal.host],
    subresourceHosts: [],
    login: [
      { host: portal.host, path: '/acme/login' },
      { host: portal.host, path: '/acme/mfa' },
    ],
    allowedSubmits: [{ host: portal.host, path: '/acme/reports/export', method: 'POST' }],
    allowPrivateNetwork: true,
  };
}

export const SIGN_IN_STEPS: Step[] = [
  {
    intent: 'Sign in',
    signIn: {
      username: { label: 'Dealer user ID' },
      password: { label: 'Password' },
      submit: { role: 'button', name: 'Sign in' },
      totp: { field: { label: 'Authentication code' }, submit: { role: 'button', name: 'Verify' } },
    },
  },
  { intent: 'Skip the survey', when: { visible: { css: '#survey-later' } }, click: { css: '#survey-later' } },
  {
    intent: 'Check sign-in worked',
    detect: {
      name: 'afterLogin',
      checks: { logged_in: { css: 'body[data-page=home]' }, mfa_sms: { css: '#sms-code' }, login_failed: { css: '#login-error' } },
      require: 'logged_in',
    },
  },
];

const INTERRUPTS = [
  { target: { css: '#cookie-overlay' }, click: { role: 'button', name: 'Accept all' } },
  { target: { css: '#whats-new' }, click: { css: '#whats-new-dismiss' } },
];

export function baselineScript(url: string, version = 1): Script {
  return {
    name: 'demo-sandbox',
    version,
    startUrl: `${url}/acme/login`,
    interrupts: INTERRUPTS,
    steps: [
      ...SIGN_IN_STEPS,
      { intent: 'Open Service', click: { role: 'link', name: 'Service', exact: true, within: { role: 'navigation' }, fallbacks: [{ css: '#nav-service' }] } },
      { intent: 'Open Recalls & Stop-Sales', click: { role: 'link', name: 'Recalls & Stop-Sales' }, expect: { heading: 'Recalls & Stop-Sales' }, checkpoint: true },
      {
        intent: 'Read every page of notices',
        paginate: {
          next: { text: 'Next page' },
          until: 'absent',
          max: 10,
          each: [{ intent: 'Read notices on this page', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}', textMode: 'textContent' } }],
        },
      },
    ],
  };
}

export function reportScript(url: string, version = 1): Script {
  return {
    name: 'demo-sandbox-report',
    version,
    startUrl: `${url}/acme/login`,
    interrupts: INTERRUPTS,
    steps: [
      ...SIGN_IN_STEPS,
      { intent: 'Open Reports', click: { role: 'link', name: 'Reports', exact: true, within: { role: 'navigation' } } },
      { intent: 'Set the start date', fill: { field: { label: 'From' }, value: '{{var.from}}' } },
      { intent: 'Export the report', download: { trigger: { role: 'button', name: 'Export CSV' }, via: { path: '/acme/reports/export' }, mime: ['text/csv'] } },
    ],
  };
}

/** A policy for the sandbox's public pages: no login, no submissions; loopback admitted on purpose. */
export function publicPolicy(portal: { url: string; host: string }, over: Partial<PortalPolicy> = {}): PortalPolicy {
  return {
    startUrl: `${portal.url}/public/table`, navHosts: [portal.host], subresourceHosts: [], login: [], allowedSubmits: [],
    allowPrivateNetwork: true, ...over,
  };
}

/** The portal's policy plus the SAP look-alikes' read-only POSTs. */
export function sapPolicy(portal: { url: string; host: string }): PortalPolicy {
  return { ...policyFor(portal), readPosts: SANDBOX.erp.readPosts(portal.host) };
}

export const SAP_VARS = { company: '1000', from: SANDBOX.erp.from, to: SANDBOX.erp.to };
const LINE_ITEMS = { intent: 'Read the line items', extractTable: { table: { role: 'grid' }, idPattern: SANDBOX.erp.idPattern } } as Step;

/** The classic web GUI's Line Item Report: sign in, pick the report, set the selection, execute, read the grid. */
export function webguiScript(url: string, version = 1): Script {
  return {
    name: 'sap-webgui-line-items',
    version,
    startUrl: `${url}/acme/login`,
    steps: [
      ...SIGN_IN_STEPS,
      { intent: 'Open the web GUI', goto: `${url}${SANDBOX.erp.webguiPath}` },
      { intent: 'Open Line Item Report', click: { role: 'button', name: 'Line Item Report' } },
      { intent: 'Pick the company code', select: { field: { label: 'Company Code' }, value: '{{var.company}}' } },
      { intent: 'Set the from date', fill: { field: { label: 'From' }, value: '{{var.from}}' } },
      { intent: 'Set the to date', fill: { field: { label: 'To' }, value: '{{var.to}}' } },
      { intent: 'Execute', click: { role: 'button', name: 'Execute' } },
      LINE_ITEMS,
    ],
  };
}

/** The Fiori Manage Line Items app. */
export function fioriScript(url: string, version = 1): Script {
  return {
    name: 'sap-fiori-line-items',
    version,
    startUrl: `${url}/acme/login`,
    steps: [
      ...SIGN_IN_STEPS,
      { intent: 'Open the launchpad', goto: `${url}${SANDBOX.erp.fioriPath}` },
      { intent: 'Open Manage Line Items', click: { role: 'link', name: 'Manage Line Items' } },
      { intent: 'Set the company code', fill: { field: { label: 'Company Code' }, value: '{{var.company}}' } },
      { intent: 'Set the from date', fill: { field: { label: 'From' }, value: '{{var.from}}' } },
      { intent: 'Set the to date', fill: { field: { label: 'To' }, value: '{{var.to}}' } },
      { intent: 'Go', click: { role: 'button', name: 'Go' } },
      { intent: 'Wait for the grid', waitFor: { target: { role: 'grid' } } },
      LINE_ITEMS,
    ],
  };
}

/** The classic web GUI export's declared checks: the company's line-item report, with its columns and at least one row. */
export const ERP_CHECK: FileCheck = { name: '^LINEITEMS_1000_', columns: ['Document', 'Posting Date', 'Company Code', 'Amount', 'Currency'], minRows: 1 };

/** The classic web GUI's Line Item Report exported as a checked CSV: sign in, pick the report, set the selection, execute, export. */
export function erpScript(url: string, version = 1): Script {
  const signIn = structuredClone(SIGN_IN_STEPS);
  const first = signIn[0];
  if ('signIn' in first) delete first.signIn.totp;
  return {
    name: 'sap-webgui-line-item-export',
    version,
    startUrl: `${url}/acme/login`,
    steps: [
      ...signIn,
      { intent: 'Open the web GUI', goto: `${url}${SANDBOX.erp.webguiPath}` },
      { intent: 'Open Line Item Report', click: { role: 'button', name: 'Line Item Report' } },
      { intent: 'Pick the company code', select: { field: { label: 'Company Code' }, value: '{{var.company}}' } },
      { intent: 'Set the from date', fill: { field: { label: 'From' }, value: '{{var.from}}' } },
      { intent: 'Set the to date', fill: { field: { label: 'To' }, value: '{{var.to}}' } },
      { intent: 'Execute', click: { role: 'button', name: 'Execute' } },
      { intent: 'Export the line items', download: { trigger: { role: 'button', name: 'Export' }, mime: ['text/csv'], check: ERP_CHECK } },
    ],
  };
}
