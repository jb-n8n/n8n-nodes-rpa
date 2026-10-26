import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import type { PortalPolicy, PortalSecrets, Script } from '../src/types.js';
import { LOCAL, signedLaneInput } from './helpers.js';

// The realistic SAP look-alike behind the sandbox's identity-first identity provider: the email and Next,
// then a password page, then a TOTP code, then "Stay signed in?" (unless IDP_KMSI=off), then the IdP's auto-submitted
// assertion POST to the SAP side, then the classic GUI export. One signIn with `next` covers both pages; the
// "Stay signed in?" answer is a `when`-gated click inside the login block.
let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal({ sap: 'realistic', sapLogin: 'sso2' }); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });
afterEach(() => { delete process.env.IDP_KMSI; });

const SECRETS: PortalSecrets = { username: 'rpa-bot@rpa.example', password: 'idp-demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };

// Both the email page and the password page are declared login pages: the username is a secret too.
const policy = (): PortalPolicy => ({
  startUrl: `${portal.url}${SANDBOX.erp.webguiPath}`,
  navHosts: [portal.host],
  subresourceHosts: [],
  login: [
    { host: portal.host, path: '/idp/login' },
    { host: portal.host, path: '/idp/password' },
    { host: portal.host, path: '/idp/mfa' },
    { host: portal.host, path: '/idp/kmsi' },
    { host: portal.host, path: '/sap/saml2/acs' },
  ],
  allowedSubmits: [],
  readPosts: [{ host: portal.host, path: '/sap*/bc/gui/sap/its/webgui' }],
  allowPrivateNetwork: true,
});

const STAY_SIGNED_IN = 'Answer "Stay signed in?" with No';

function steps(): Script {
  return {
    name: 'sap-sso2-export',
    version: 1,
    startUrl: `${portal.url}${SANDBOX.erp.webguiPath}`,
    steps: [
      {
        intent: 'Sign in at the identity provider',
        signIn: {
          username: { label: 'Email' },
          next: { role: 'button', name: 'Next' },
          password: { label: 'Password' },
          submit: { role: 'button', name: 'Sign in' },
          totp: { field: { label: 'Code' }, submit: { role: 'button', name: 'Verify' } },
        },
      },
      {
        intent: STAY_SIGNED_IN,
        when: { visible: { role: 'heading', name: 'Stay signed in?' } },
        click: { role: 'button', name: 'No', exact: true },
      },
      { intent: 'Open Line Item Report', click: { role: 'button', name: 'Line Item Report' } },
      { intent: 'Company code', fill: { field: { label: 'Company Code' }, value: '1000' } },
      { intent: 'From', fill: { field: { label: 'From' }, value: '01.09.2026' } },
      { intent: 'To', fill: { field: { label: 'To' }, value: '30.09.2026' } },
      { intent: 'Execute', click: { role: 'button', name: 'Execute (F8)' } },
      { intent: 'Spreadsheet', click: { role: 'button', name: 'Spreadsheet... (Ctrl+Shift+F7)' } },
      { intent: 'Continue', download: { trigger: { role: 'button', name: 'Continue (Enter)' } } },
    ],
  };
}

async function runAndCheckExport(): Promise<{ log: { intent: string; status: string }[] }> {
  const r = await runScriptLane(signedLaneInput(steps(), { policy: policy(), secrets: SECRETS, output: {}, endpoint: LOCAL, defaultStepTimeoutMs: 5000 }));
  if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 1500));
  expect(r.files).toHaveLength(1);
  const file = r.files[0]!;
  expect(file.fileName).toBe('export.XLSX');
  const strings = strFromU8(unzipSync(new Uint8Array(file.data))['xl/sharedStrings.xml']!);
  expect(strings).toContain('Document No.');
  expect([...strings.matchAll(/>(19\d{8})</g)]).toHaveLength(SANDBOX.erp.rowsInSeptember1000);
  expect((r as { submitted?: boolean }).submitted).toBeFalsy();
  expect(r.violations).toHaveLength(0);
  expect(r.blockedRequests).toHaveLength(0);
  return r;
}

describe('the realistic SAP look-alike behind an identity-first sign-in with MFA', () => {
  it('signs in on two pages with a code, answers "Stay signed in?" and exports XLSX through the classic GUI', async () => {
    const r = await runAndCheckExport();
    expect(r.log.find((e) => e.intent === STAY_SIGNED_IN)?.status).toBe('ok');
  }, 120_000);

  it('skips the "Stay signed in?" click when the identity provider does not ask (IDP_KMSI=off)', async () => {
    process.env.IDP_KMSI = 'off';
    const r = await runAndCheckExport();
    expect(r.log.find((e) => e.intent === STAY_SIGNED_IN)?.status).toBe('skipped');
  }, 120_000);
});
