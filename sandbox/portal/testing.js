// Test helper: start the sandbox portal in-process on a free port with a throwaway state file.
// One call per process: the server and its state are module singletons.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BULLETINS } from './notices.js';
import { LEDGER, LINE_ITEM_HEADER } from './erp.js';

export const SANDBOX = {
  username: 'summit-ops',
  password: 'demo-password',
  totpSecret: 'JBSWY3DPEHPK3PXP',
  bulletins: BULLETINS,
  erp: {
    header: LINE_ITEM_HEADER,
    company: '1000',
    from: '2026-09-01',
    to: '2026-09-30',
    rowsInSeptember1000: LEDGER.filter((r) => r.company === '1000' && r.postingDate >= '2026-09-01' && r.postingDate <= '2026-09-30').length,
    emptyFrom: '2026-12-01',
    emptyTo: '2026-12-31',
    idPattern: '19\\d{8}',
    webguiPath: '/sap/bc/gui/sap/its/webgui',
    fioriPath: '/sap/bc/ui2/flp',
    readPosts: (host) => [{ host, path: '/sap*/bc/gui/sap/its/webgui' }, { host, path: '/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch' }],
  },
};

// opts.sap picks the look-alike ('light' by default), and opts.sapLogin how the realistic one signs in ('sap' by default, or
// 'sso' or 'sso2' for the identity provider). They set SANDBOX_SAP and SANDBOX_SAP_LOGIN for the process, which the server reads per request.
export async function startPortal(opts = {}) {
  process.env.SANDBOX_SAP = opts.sap === 'realistic' ? 'realistic' : 'light';
  process.env.SANDBOX_SAP_LOGIN = ['sso', 'sso2'].includes(opts.sapLogin) ? opts.sapLogin : 'sap';
  if (!process.env.STATE_FILE) process.env.STATE_FILE = join(mkdtempSync(join(tmpdir(), 'pw-sandbox-')), 'state.json');
  const mod = await import('./server.js');
  mod.resetState();
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve));
  const { port } = mod.server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    port,
    setState: (change) => mod.applyChange(change),
    reset: () => mod.resetState(),
    state: () => mod.currentState(),
    close: () => new Promise((resolve) => { mod.server.closeAllConnections(); mod.server.close(() => resolve()); }),
  };
}
