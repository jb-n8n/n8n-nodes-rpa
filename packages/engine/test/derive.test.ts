import { describe, expect, it } from 'vitest';
import { effectivePolicy, effectiveWriteMode, noWritePolicy } from '../src/policy/derive.js';
import type { PortalPolicy, Script } from '../src/types.js';
import { policyFor } from './helpers.js';

const base = policyFor({ url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' });

describe('effectiveWriteMode', () => {
  const cases: [PortalPolicy['writeMode'], boolean, boolean, 'fatal' | 'block'][] = [
    ['block', false, false, 'block'],
    ['block', true, false, 'fatal'],
    ['block', false, true, 'fatal'],
    ['block', true, true, 'fatal'],
    ['fatal', false, false, 'fatal'],
    [undefined, false, false, 'fatal'],
    [undefined, true, true, 'fatal'],
  ];
  it.each(cases)('requested %s, signed %s, Site Login %s → %s', (writeMode, signed, hasSecrets, want) => {
    expect(effectiveWriteMode({ ...base, writeMode }, { signed, hasSecrets })).toBe(want);
  });
});

describe('noWritePolicy', () => {
  it('drops every allowed submission and frame-host write and forces fatal writes, keeping hosts, login pages and the private-network setting', () => {
    const p: PortalPolicy = { ...base, writeMode: 'block', subresourceHosts: '*', frameHosts: ['widget.example'] };
    const before = structuredClone(p);
    const n = noWritePolicy(p);
    // Agent and prove sessions cannot write, frame widgets included.
    expect(n).toEqual({ ...p, allowedSubmits: [], writeMode: 'fatal', frameHostWrites: false, submitsFromSteps: false, refuseDestructiveNavigation: true });
    expect(n.frameHosts).toEqual(['widget.example']);
    expect(n.login).toEqual(base.login);
    expect(n.allowPrivateNetwork).toBe(true);
    expect(p).toEqual(before);
  });
});

describe('read-only POSTs survive the derived policies', () => {
  const readPosts = [{ host: '127.0.0.1:9999', path: '/sap*/bc/gui/sap/its/webgui' }];
  const withReads: PortalPolicy = { ...base, readPosts, allowedSubmits: [{ host: '127.0.0.1:9999', path: '/acme/reports/export', method: 'POST' }] };
  it('noWritePolicy keeps readPosts', () => {
    const n = noWritePolicy(withReads);
    expect(n.readPosts).toEqual(readPosts);
    expect(n.allowedSubmits).toEqual([]);
  });
  it('effectivePolicy keeps readPosts', () => {
    const clicks: Script = { version: 1, name: 'n', steps: [{ intent: 'x', goto: '/acme/home' }] } as unknown as Script;
    const e = effectivePolicy(withReads, clicks, { signed: false, hasSecrets: false });
    expect(e.readPosts).toEqual(readPosts);
    expect(e.allowedSubmits).toEqual([]);
  });
});

describe('effectivePolicy', () => {
  const base: PortalPolicy = {
    startUrl: 'https://shop.example/form', navHosts: ['shop.example', 'files.example'], subresourceHosts: '*', login: [], allowedSubmits: [],
    writeMode: 'block',
  };
  const script: Script = {
    name: 'derive-test', version: 1, startUrl: 'https://shop.example/form',
    steps: [
      { intent: 'Send', submit: { button: { css: 'button' }, path: '/form/submit' } },
      { intent: 'Export', download: { trigger: { css: '#x' }, via: { host: 'files.example', path: '/export', method: 'post' } } },
      { intent: 'Elsewhere', submit: { button: { css: 'b' }, host: 'evil.example', path: '/steal' } },
      { intent: 'Pages', paginate: { next: { css: '.next' }, until: 'absent', max: 2, each: [{ intent: 'Again', submit: { button: { css: 'button' }, path: '/form/submit' } }] } },
    ],
  };
  const unsigned = { signed: false, hasSecrets: false };
  it('takes the declared submit and download.via targets on navigation hosts, once each, when submitsFromSteps is on', () => {
    expect(effectivePolicy({ ...base, submitsFromSteps: true }, script, unsigned).allowedSubmits).toEqual([
      { host: 'shop.example', path: '/form/submit', method: 'POST' },
      { host: 'files.example', path: '/export', method: 'POST' },
    ]);
  });
  it('with a Site Login (or without submitsFromSteps) keeps only the listed forms the steps declare', () => {
    const listed = [
      { host: 'shop.example', path: '/listed', method: 'POST' },
      { host: 'shop.example', path: '/form/submit', method: 'post' },
      { host: 'files.example', path: '/export', method: 'POST' },
      { host: 'files.example', path: '/export', method: 'PUT' },
    ];
    const declared = [{ host: 'shop.example', path: '/form/submit', method: 'post' }, { host: 'files.example', path: '/export', method: 'POST' }];
    const siteLogin = { signed: true, hasSecrets: true };
    expect(effectivePolicy({ ...base, allowedSubmits: listed, submitsFromSteps: true }, script, siteLogin).allowedSubmits).toEqual(declared);
    expect(effectivePolicy({ ...base, allowedSubmits: listed }, script, unsigned).allowedSubmits).toEqual(declared);
    // Steps with only clicks may post nothing, whatever the credential lists.
    const clicks: Script = { ...script, steps: [{ intent: 'Click', click: { css: 'button' } }] };
    expect(effectivePolicy({ ...base, allowedSubmits: listed }, clicks, siteLogin).allowedSubmits).toEqual([]);
  });
  it('sets the effective write mode and keeps the write window', () => {
    const windowed = { ...base, writeWindow: { step: 0, maxPosts: 3 as const, hosts: ['shop.example'] } };
    expect(effectivePolicy(windowed, script, unsigned)).toMatchObject({ writeMode: 'block', writeWindow: windowed.writeWindow });
    expect(effectivePolicy(windowed, script, { signed: true, hasSecrets: false }).writeMode).toBe('fatal');
    expect(effectivePolicy(windowed, script, { signed: false, hasSecrets: true }).writeMode).toBe('fatal');
  });
  it('noWritePolicy drops the write window and submitsFromSteps', () => {
    const p = noWritePolicy({ ...base, submitsFromSteps: true, writeWindow: { step: 0, maxPosts: 3, hosts: ['shop.example'] } });
    expect(p.writeWindow).toBeUndefined();
    expect('writeWindow' in p).toBe(false);
    expect(p.submitsFromSteps).toBe(false);
  });
});
