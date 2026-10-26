import { describe, expect, it } from 'vitest';
import { workEntry } from '../src/prove/entry.js';
import type { PortalPolicy, Script, Step } from '../src/types.js';

// The page a reused healing session opens to start the work.
const ORIGIN = 'https://erp.example.com';
const policy: PortalPolicy = {
  startUrl: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, navHosts: ['erp.example.com', 'idp.example.com'], subresourceHosts: [],
  login: [{ host: 'idp.example.com', path: '/login' }], allowedSubmits: [],
};
const SIGN_IN: Step = { intent: 'Sign in', signIn: { username: { label: 'User' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Log On' } } };
const KMSI: Step = { intent: 'Stay signed in', when: { visible: { role: 'button', name: 'No' } }, click: { role: 'button', name: 'No' } };
const DETECT: Step = { intent: 'Check sign-in worked', detect: { name: 'afterLogin', checks: { logged_in: { role: 'menubar' } }, require: 'logged_in' } };
const TILE: Step = { intent: 'Open the report', click: { role: 'button', name: 'Line Item Report' } };
const script = (after: Step[], startUrl = `${ORIGIN}/sap/bc/gui/sap/its/webgui`): Script => ({ name: 's', version: 1, startUrl, steps: [SIGN_IN, KMSI, DETECT, ...after] });
const goto = (url: string, over: Partial<Step> = {}): Step => ({ intent: 'Open the GUI', goto: url, ...over } as Step);

describe('workEntry', () => {
  it('is the goto that starts the work right after the login block', () => {
    expect(workEntry(script([goto(`${ORIGIN}/sap/bc/gui/sap/its/webgui?~transaction=ZLINEITEMS`), TILE]), 3, policy))
      .toEqual({ url: `${ORIGIN}/sap/bc/gui/sap/its/webgui?~transaction=ZLINEITEMS`, fromGoto: true });
  });
  it('resolves a relative goto against the start URL', () => {
    expect(workEntry(script([goto('/sap/bc/ui2/flp'), TILE]), 3, policy)).toEqual({ url: `${ORIGIN}/sap/bc/ui2/flp`, fromGoto: true });
  });
  it('is the start URL when the work starts with something other than a goto', () => {
    expect(workEntry(script([TILE, goto(`${ORIGIN}/sap/bc/ui2/flp`)]), 3, policy)).toEqual({ url: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, fromGoto: false });
    expect(workEntry(script([TILE]), 3, policy)).toEqual({ url: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, fromGoto: false });
  });
  it('is the start URL when the step at `from` is not a goto (prove never asks on the re-anchored-detect resume path: it opens the captured URL there)', () => {
    expect(workEntry(script([goto('/sap/bc/ui2/flp')]), 2, policy)).toEqual({ url: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, fromGoto: false });
  });
  it('is never a declared login page: undefined, so the captured URL is opened (a login page can sign the user out)', () => {
    const login = 'https://idp.example.com/login';
    expect(workEntry(script([TILE], login), 3, policy)).toBeUndefined();
    expect(workEntry(script([goto(login), TILE], login), 3, policy)).toBeUndefined();
    expect(workEntry(script([goto('https://idp.example.com/login?prompt=none'), TILE], login), 3, policy)).toBeUndefined();
    // A goto to the login page after the login block: the start URL when that is no login page.
    expect(workEntry(script([goto(login), TILE]), 3, policy)).toEqual({ url: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, fromGoto: false });
  });
  it('allows a login page only when it is the captured page with its session segment cut (SAP serves the work at its logon address)', () => {
    const webgui = `${ORIGIN}/sap/bc/gui/sap/its/webgui`;
    const sap = { ...policy, login: [{ host: 'erp.example.com', path: '/sap/bc/gui/sap/its/webgui' }] };
    const captured = `${ORIGIN}/sap(cz1TSUQ6QU5PTjp2aGNhbGxzX0RFVl8wMDo)/bc/gui/sap/its/webgui?sap-client=100`;
    expect(workEntry(script([TILE]), 3, sap, captured)).toEqual({ url: webgui, fromGoto: false });
    // Without the captured URL, with a captured page elsewhere, or one that is the login page itself: never.
    expect(workEntry(script([TILE]), 3, sap)).toBeUndefined();
    expect(workEntry(script([TILE]), 3, sap, `${ORIGIN}/sap/bc/ui2/flp`)).toBeUndefined();
    expect(workEntry(script([TILE]), 3, sap, webgui)).toBeUndefined();
    expect(workEntry(script([TILE], 'https://idp.example.com/login'), 3, policy, 'https://idp.example.com/login')).toBeUndefined();
  });
  it('cuts a session segment to its name: the entry is session-free', () => {
    const token = 'cz1TSUQ6QU5PTjp2aGNhbGxzX0RFVl8wMDo';
    expect(workEntry(script([goto(`${ORIGIN}/sap(${token})/bc/gui/sap/its/webgui`), TILE]), 3, policy))
      .toEqual({ url: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, fromGoto: true });
    expect(workEntry(script([TILE], `${ORIGIN}/sap(${token})/bc/gui/sap/its/webgui?sap-client=100`), 3, policy))
      .toEqual({ url: `${ORIGIN}/sap/bc/gui/sap/its/webgui?sap-client=100`, fromGoto: false });
  });
  it('never uses a conditional goto or one with run variables: the start URL instead', () => {
    expect(workEntry(script([goto('/sap/bc/ui2/flp', { when: { visible: { css: '#x' } } } as Partial<Step>), TILE]), 3, policy))
      .toEqual({ url: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, fromGoto: false });
    expect(workEntry(script([goto('/sap/bc/ui2/flp?company={{var.company}}'), TILE]), 3, policy))
      .toEqual({ url: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, fromGoto: false });
  });
  it('never opens a URL outside the policy', () => {
    // A goto to a site that is not allowed falls back to the start URL; nothing at all when that is not allowed either.
    expect(workEntry(script([goto('https://evil.example.net/sap/bc/ui2/flp'), TILE]), 3, policy))
      .toEqual({ url: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, fromGoto: false });
    expect(workEntry(script([TILE], 'https://evil.example.net/start'), 3, policy)).toBeUndefined();
    expect(workEntry(script([goto('https://evil.example.net/x'), TILE], 'https://evil.example.net/start'), 3, policy)).toBeUndefined();
    // Not http(s), userinfo, a run variable in the path: never an entry.
    for (const bad of ['javascript:alert(1)', 'https://user:pw@erp.example.com/sap/x', '/sap/{{var.path}}/x', 'file:///etc/passwd']) {
      expect(workEntry(script([goto(bad), TILE]), 3, policy)?.fromGoto ?? false).toBe(false);
    }
    expect(workEntry(script([TILE], 'file:///etc/passwd'), 3, policy)).toBeUndefined();
  });
  it('is undefined past the end of the steps only when the start URL is not allowed', () => {
    expect(workEntry(script([]), 3, policy)).toEqual({ url: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, fromGoto: false });
  });
});
