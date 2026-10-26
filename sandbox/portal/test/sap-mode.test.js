import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sapLogin, sapMode } from '../sap-mode.js';

test('light mode is the default and ignores other values', () => {
  const before = process.env.SANDBOX_SAP;
  try {
    delete process.env.SANDBOX_SAP;
    assert.equal(sapMode(), 'light');
    for (const v of ['', 'REALISTIC', 'light']) {
      process.env.SANDBOX_SAP = v;
      assert.equal(sapMode(), 'light', v);
    }
    process.env.SANDBOX_SAP = 'realistic';
    assert.equal(sapMode(), 'realistic');
  } finally {
    if (before === undefined) delete process.env.SANDBOX_SAP; else process.env.SANDBOX_SAP = before;
  }
});

test('the SAP logon is the default and only "sso" or "sso2" switches to single sign-on', () => {
  const before = process.env.SANDBOX_SAP_LOGIN;
  try {
    delete process.env.SANDBOX_SAP_LOGIN;
    assert.equal(sapLogin(), 'sap');
    for (const v of ['', 'SSO', 'saml', 'sap']) {
      process.env.SANDBOX_SAP_LOGIN = v;
      assert.equal(sapLogin(), 'sap', v);
    }
    process.env.SANDBOX_SAP_LOGIN = 'sso';
    assert.equal(sapLogin(), 'sso');
    process.env.SANDBOX_SAP_LOGIN = 'sso2';
    assert.equal(sapLogin(), 'sso2');
  } finally {
    if (before === undefined) delete process.env.SANDBOX_SAP_LOGIN; else process.env.SANDBOX_SAP_LOGIN = before;
  }
});
