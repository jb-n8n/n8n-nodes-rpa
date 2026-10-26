import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import type { PortalPolicy, PortalSecrets, Script } from '../src/types.js';
import { LOCAL, signedLaneInput } from './helpers.js';

// The realistic SAP look-alike behind the sandbox's identity provider: sign in with email and password,
// then a TOTP code, then the IdP's auto-submitted assertion POST to the SAP side, then the classic GUI export.
let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal({ sap: 'realistic', sapLogin: 'sso' }); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const SECRETS: PortalSecrets = { username: 'rpa-bot@rpa.example', password: 'idp-demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };

const policy = (): PortalPolicy => ({
  startUrl: `${portal.url}${SANDBOX.erp.webguiPath}`,
  navHosts: [portal.host],
  subresourceHosts: [],
  login: [
    { host: portal.host, path: '/idp/login' },
    { host: portal.host, path: '/idp/mfa' },
    { host: portal.host, path: '/sap/saml2/acs' },
  ],
  allowedSubmits: [],
  readPosts: [{ host: portal.host, path: '/sap*/bc/gui/sap/its/webgui' }],
  allowPrivateNetwork: true,
});

function steps(): Script {
  return {
    name: 'sap-sso-export',
    version: 1,
    startUrl: `${portal.url}${SANDBOX.erp.webguiPath}`,
    steps: [
      {
        intent: 'Sign in at the identity provider',
        signIn: {
          username: { label: 'Email' },
          password: { label: 'Password' },
          submit: { role: 'button', name: 'Sign in' },
          totp: { field: { label: 'Code' }, submit: { role: 'button', name: 'Verify' } },
        },
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

describe('the realistic SAP look-alike behind single sign-on with MFA', () => {
  it('signs in at the IdP with a code and exports XLSX through the classic GUI', async () => {
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
  }, 120_000);
});
