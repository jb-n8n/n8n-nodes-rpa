// The realistic Fiori app on real OpenUI5 1.148.10, loaded through the sandbox's UI5 proxy (network required on the first run;
// later runs read the proxy's disk cache). Skipped unless SANDBOX_UI5 is set, so CI stays offline. With SANDBOX_UI5_RECORD=1 the
// first test writes every $batch body UI5 sent to sandbox/portal/test/fixtures/ui5-batch-recorded.txt, which odata.test.js replays.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { SANDBOX, startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession } from '../src/browser/session.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import { createMasker } from '../src/secrets/mask.js';
import type { PortalPolicy, PortalSecrets, Script } from '../src/types.js';
import { LOCAL, signedLaneInput } from './helpers.js';

// Deliberately not UTC: the app must still send midnight-UTC datetime literals, which the OData mock insists on.
const TIMEZONE = 'America/New_York';
const BATCH = '/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch';
const FIXTURE = new URL('../../../sandbox/portal/test/fixtures/ui5-batch-recorded.txt', import.meta.url);
const SECRETS: PortalSecrets = { username: 'RPA_BOT', password: 'sap-demo-password' };
const RANGE = 'Sep 1, 2026 - Sep 30, 2026';

let portal: Awaited<ReturnType<typeof startPortal>>;
const savedTz = process.env.TZ;
beforeAll(async () => {
  process.env.TZ = TIMEZONE; // the locally launched browser inherits it
  portal = await startPortal({ sap: 'realistic' });
});
afterAll(async () => {
  if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  await portal?.close();
});
beforeEach(() => { portal.reset(); });

const policy = (): PortalPolicy => ({
  startUrl: `${portal.url}${SANDBOX.erp.fioriPath}`,
  navHosts: [portal.host],
  subresourceHosts: [],
  login: [{ host: portal.host, path: SANDBOX.erp.fioriPath }],
  allowedSubmits: [],
  readPosts: [{ host: portal.host, path: BATCH }],
  allowPrivateNetwork: true,
});

/** The data rows of the first sheet of an XLSX file, as shared-string-resolved cell texts. */
function sheetRows(data: Uint8Array): string[][] {
  const parts = unzipSync(data);
  expect(Object.keys(parts)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']));
  const strings = [...strFromU8(parts['xl/sharedStrings.xml']!).matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]!);
  return [...strFromU8(parts['xl/worksheets/sheet1.xml']!).matchAll(/<row[^>]*>(.*?)<\/row>/g)].map((row) =>
    [...row[1]!.matchAll(/<c r="[A-Z]+\d+"( t="s")?><v>([^<]*)<\/v><\/c>/g)].map((c) => (c[1] ? strings[Number(c[2])]! : c[2]!)));
}

function expectSeptember(data: Uint8Array) {
  const rows = sheetRows(data);
  expect(rows[0]).toEqual(SANDBOX.erp.header.split(','));
  const body = rows.slice(1);
  expect(body).toHaveLength(SANDBOX.erp.rowsInSeptember1000);
  expect(body.map((r) => r[0])).toContain('1900000201');
  expect(body.map((r) => r[0])).not.toContain('1900000102');
  for (const r of body) expect(r[1]).toMatch(/^2026-09-\d\d$/);
}

describe.skipIf(!process.env.SANDBOX_UI5)('the realistic Fiori app on real OpenUI5', () => {
  it('the real UI5 app reads through $batch and exports XLSX', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policy(), masker: createMasker([]) });
    const batches: string[] = [];
    s.page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === BATCH) batches.push(r.postData() ?? ''); });
    try {
      const page = s.page;
      await page.goto(`${portal.url}${SANDBOX.erp.fioriPath}`);
      await page.getByLabel('User').fill(SECRETS.username);
      await page.getByLabel('Password').fill(SECRETS.password);
      await page.getByRole('button', { name: 'Log On' }).click();
      await page.getByRole('button', { name: 'Manage Line Items' }).click({ timeout: 60_000 });
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(TIMEZONE);
      await page.getByLabel('Company Code').fill(SANDBOX.erp.company);
      await page.getByLabel('Posting Date').fill(RANGE);
      const read = page.waitForResponse((r) => new URL(r.url()).pathname === BATCH);
      await page.getByRole('button', { name: 'Go', exact: true }).click();
      expect((await read).status()).toBe(200);
      const rows = page.locator('#application-LineItem-manage-component---worklist--table tbody tr.sapMListTblRow');
      await expect.poll(() => rows.count()).toBe(SANDBOX.erp.rowsInSeptember1000);
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export to Spreadsheet' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('LineItems.xlsx');
      expectSeptember(new Uint8Array(readFileSync((await file.path())!)));
      expect([...s.readPostsUsed]).toContain(`POST ${portal.host}${BATCH}`);
      expect(s.writesSent).toBe(0);
      expect(s.violations).toEqual([]);
      expect(batches.length).toBeGreaterThan(0);
      if (process.env.SANDBOX_UI5_RECORD) writeFileSync(FIXTURE, batches.join('\r\n'));
    } finally { await s.close(); }
  }, 180_000);

  it('the script lane logs on, filters and exports through the real UI5 app', async () => {
    const script: Script = {
      name: 'sap-ui5-export',
      version: 1,
      startUrl: `${portal.url}${SANDBOX.erp.fioriPath}`,
      steps: [
        { intent: 'Log on', signIn: { username: { label: 'User' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Log On' } } },
        { intent: 'Open Manage Line Items', click: { role: 'button', name: 'Manage Line Items' }, timeoutMs: 60_000 },
        { intent: 'Company code', fill: { field: { label: 'Company Code' }, value: SANDBOX.erp.company } },
        { intent: 'Posting date', fill: { field: { label: 'Posting Date' }, value: RANGE } },
        { intent: 'Go', click: { role: 'button', name: 'Go', exact: true } },
        { intent: 'Export', download: { trigger: { role: 'button', name: 'Export to Spreadsheet' } } },
      ],
    };
    const r = await runScriptLane(signedLaneInput(script, { policy: policy(), secrets: SECRETS, output: {}, endpoint: LOCAL, defaultStepTimeoutMs: 15_000 }));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 1500));
    expect(r.files).toHaveLength(1);
    expect(r.files[0]!.fileName).toBe('LineItems.xlsx');
    expectSeptember(new Uint8Array(r.files[0]!.data));
    expect(r.blockedRequests).toHaveLength(0);
    expect((r as { submitted?: boolean }).submitted).toBeFalsy();
  }, 180_000);
});
