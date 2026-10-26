import { describe, expect, it } from 'vitest';
import { checkTrust, hasSignature, isEmptySteps, unsignedWrites, type TrustInput } from '../src/lane/trust.js';
import {
  nameMismatch, SIGNATURE_INVALID, SIGNATURE_WITHOUT_KEY, startSiteMismatch, UNSIGNED_REQUIRED, UNSIGNED_WRITES, versionMismatch,
} from '../src/messages.js';
import { signScript } from '../src/sign.js';
import type { Script, Step } from '../src/types.js';
import { APPROVER, baselineScript, policyFor, TEST_KEY } from './helpers.js';

const site = { url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' };
const policy = policyFor(site);
const RUN = { policy, firstRun: false };
const WAIT: Step = { intent: 'Wait for the table', waitFor: { target: { css: 'table.results' } } };
/** No signIn, submit or download: allowed unsigned. */
const readOnly = (over: Partial<Script> = {}): Script => ({ name: 'table', version: 1, startUrl: `${site.url}/public/table`, steps: [WAIT], ...over });
const sig = (doc: unknown, siteLoginId?: string) =>
  signScript(doc, TEST_KEY, { approvedBy: APPROVER, ...(siteLoginId ? { siteLoginId } : {}) }).signature;
const signedTrust = (doc: unknown, over: Partial<TrustInput> = {}): TrustInput => ({
  required: true, signature: sig(doc), approvedBy: APPROVER, key: TEST_KEY, ...over,
});
const refused = (message: string) => ({ ok: false, code: 'script_untrusted', message });
const BAD = 'a'.repeat(64);

describe('golden trust messages', () => {
  it('are verbatim', () => {
    expect(UNSIGNED_REQUIRED).toBe('The steps are not signed, or the signature is not valid, and Require Signed Steps is on. Sign them with Sign Steps first.');
    expect(SIGNATURE_INVALID).toBe('The signature is not valid for these steps: it does not match their name, version, start site, Site Login or approver.');
    expect(SIGNATURE_WITHOUT_KEY).toBe('a signature is present but no Step Signing credential is attached');
    expect(UNSIGNED_WRITES).toBe('Unsigned steps cannot sign in, submit a form or download through a form. Sign them with Sign Steps, or turn on Options → Allow Unsigned Writes.');
    expect(nameMismatch('prices', 'stock')).toBe('the signed steps are named "prices", not "stock"');
    expect(versionMismatch(3, 4)).toBe('the signed steps are version 3, but Expected Version is 4');
    expect(startSiteMismatch('a.example', 'b.example')).toBe('the signed steps start on a.example, but this run starts on b.example');
  });
});

describe('checkTrust: signatures', () => {
  it('unsigned steps run when Require Signed Steps is off', () => {
    expect(checkTrust(readOnly(), { required: false }, RUN)).toEqual({ ok: true, signed: false });
  });
  it('a missing signature fails when Require Signed Steps is on', () => {
    expect(checkTrust(readOnly(), { required: true, key: TEST_KEY }, RUN)).toEqual(refused(UNSIGNED_REQUIRED));
  });
  it('a wrong signature is UNSIGNED_REQUIRED when required and SIGNATURE_INVALID when not', () => {
    expect(checkTrust(readOnly(), { required: true, signature: BAD, approvedBy: APPROVER, key: TEST_KEY }, RUN)).toEqual(refused(UNSIGNED_REQUIRED));
    expect(checkTrust(readOnly(), { required: false, signature: BAD, approvedBy: APPROVER, key: TEST_KEY }, RUN)).toEqual(refused(SIGNATURE_INVALID));
  });
  it('a signature without a signing key fails, even when Require Signed Steps is off', () => {
    const doc = readOnly();
    for (const key of [undefined, '', '   ']) {
      expect(checkTrust(doc, { required: false, signature: sig(doc), approvedBy: APPROVER, key }, RUN)).toEqual(refused(SIGNATURE_WITHOUT_KEY));
      expect(checkTrust(doc, { required: true, signature: sig(doc), approvedBy: APPROVER, key }, RUN)).toEqual(refused(SIGNATURE_WITHOUT_KEY));
    }
  });
  it('a valid signature passes and reports signed, whatever the toggle', () => {
    const doc = readOnly();
    expect(checkTrust(doc, signedTrust(doc), RUN)).toEqual({ ok: true, signed: true });
    expect(checkTrust(doc, signedTrust(doc, { required: false }), RUN)).toEqual({ ok: true, signed: true });
  });
  it('the approver is bound', () => {
    const doc = readOnly();
    expect(checkTrust(doc, signedTrust(doc, { approvedBy: 'mallory@example.com' }), RUN)).toEqual(refused(UNSIGNED_REQUIRED));
  });
});

describe('blank trust inputs from a Data Table bootstrap item', () => {
  it('undefined, empty and whitespace signatures are absent', () => {
    for (const signature of [undefined, '', '   ']) {
      expect(hasSignature({ required: false, signature })).toBe(false);
      expect(checkTrust(readOnly(), { required: false, signature, approvedBy: '', key: '' }, RUN)).toEqual({ ok: true, signed: false });
      expect(checkTrust(readOnly(), { required: true, signature, approvedBy: '', key: TEST_KEY }, RUN)).toEqual(refused(UNSIGNED_REQUIRED));
    }
  });
  it("the strings 'null' and 'undefined' are present signatures and never valid", () => {
    for (const signature of ['null', 'undefined']) {
      expect(hasSignature({ required: false, signature })).toBe(true);
      expect(checkTrust(readOnly(), { required: false, signature, approvedBy: APPROVER, key: TEST_KEY }, RUN)).toEqual(refused(SIGNATURE_INVALID));
      expect(checkTrust(readOnly(), { required: true, signature, approvedBy: APPROVER, key: TEST_KEY }, RUN)).toEqual(refused(UNSIGNED_REQUIRED));
      expect(checkTrust(readOnly(), { required: false, signature }, RUN)).toEqual(refused(SIGNATURE_WITHOUT_KEY));
    }
  });
  it('isEmptySteps: only absent, blank and empty step lists are empty', () => {
    for (const raw of [undefined, null, '', '  ', [], { steps: [] }, { name: 'x', steps: [] }]) expect(isEmptySteps(raw), String(JSON.stringify(raw))).toBe(true);
    // A JSON string is parsed by the node, never by the engine: '[]' is a non-empty string here.
    for (const raw of [{}, { steps: [WAIT] }, '[]', 0, false, { name: 'x' }]) expect(isEmptySteps(raw), String(JSON.stringify(raw))).toBe(false);
  });
  it('empty steps outside a first run: UNSIGNED_REQUIRED when required, otherwise left to the shape check', () => {
    for (const raw of [undefined, null, '', '  ', [], { steps: [] }]) {
      expect(checkTrust(raw, { required: true, key: TEST_KEY }, RUN)).toEqual(refused(UNSIGNED_REQUIRED));
      expect(checkTrust(raw, { required: false }, RUN)).toEqual({ ok: true, signed: false });
    }
  });
  it('{} is not empty: unsigned and not required, it passes the gate (the shape check then fails it)', () => {
    expect(isEmptySteps({})).toBe(false);
    expect(checkTrust({}, { required: false }, RUN)).toEqual({ ok: true, signed: false });
    expect(checkTrust({}, { required: true, key: TEST_KEY }, RUN)).toEqual(refused(UNSIGNED_REQUIRED));
  });
});

describe('first-run exemption', () => {
  it('a first run passes whatever the trust input says', () => {
    const first = { policy, firstRun: true };
    expect(checkTrust(undefined, { required: true }, first)).toEqual({ ok: true, signed: false });
    expect(checkTrust('', { required: true, signature: 'null' }, first)).toEqual({ ok: true, signed: false });
    expect(checkTrust({ steps: [] }, { required: true, signature: BAD, approvedBy: APPROVER, key: TEST_KEY }, first)).toEqual({ ok: true, signed: false });
  });
});

describe('unsigned writes', () => {
  const PAGE = `${site.url}/public/form`;
  const submit: Step = { intent: 'Send the form', submit: { button: { role: 'button', name: 'Send' }, path: '/public/form/submit' } };
  const viaInPaginate: Step = {
    intent: 'Export every page',
    paginate: {
      next: { text: 'Next page' }, until: 'absent', max: 3,
      each: [{ intent: 'Export this page', download: { trigger: { role: 'button', name: 'Export via POST' }, via: { path: '/public/files/export' } } }],
    },
  };
  const plainDownload: Step = { intent: 'Download the CSV', download: { trigger: { css: '#csv' } } };
  it('lists signIn, submit and download-with-via intents, paginate bodies included', () => {
    expect(unsignedWrites(baselineScript(site.url).steps)).toEqual(['Sign in']);
    expect(unsignedWrites([WAIT, submit, viaInPaginate, plainDownload])).toEqual(['Send the form', 'Export this page']);
    expect(unsignedWrites([WAIT, plainDownload])).toEqual([]);
  });
  it('unsigned steps that write are refused unless Allow Unsigned Writes is on', () => {
    for (const steps of [baselineScript(site.url).steps, [WAIT, submit], [WAIT, viaInPaginate]]) {
      const doc = readOnly({ startUrl: PAGE, steps });
      expect(checkTrust(doc, { required: false }, RUN)).toEqual(refused(UNSIGNED_WRITES));
      expect(checkTrust(doc, { required: false, allowUnsignedWrites: true }, RUN)).toEqual({ ok: true, signed: false });
    }
  });
  it('signed steps may write', () => {
    const doc = readOnly({ startUrl: PAGE, steps: [WAIT, submit] });
    expect(checkTrust(doc, signedTrust(doc), RUN)).toEqual({ ok: true, signed: true });
  });
});

describe('bound values', () => {
  it('the Site Login id is bound: signed with one id and verified with another or none, it fails', () => {
    const doc = readOnly();
    const withA: TrustInput = { required: true, signature: sig(doc, 'cred-a'), approvedBy: APPROVER, key: TEST_KEY };
    expect(checkTrust(doc, { ...withA, expect: { siteLoginId: 'cred-a' } }, RUN)).toEqual({ ok: true, signed: true });
    expect(checkTrust(doc, { ...withA, expect: { siteLoginId: 'cred-b' } }, RUN)).toEqual(refused(UNSIGNED_REQUIRED));
    expect(checkTrust(doc, withA, RUN)).toEqual(refused(UNSIGNED_REQUIRED));
    expect(checkTrust(doc, { ...withA, required: false }, RUN)).toEqual(refused(SIGNATURE_INVALID));
    // Signed without a Site Login, verified with one: fails too.
    expect(checkTrust(doc, { ...signedTrust(doc), expect: { siteLoginId: 'cred-a' } }, RUN)).toEqual(refused(UNSIGNED_REQUIRED));
  });
  it('Name and Expected Version must equal the signed values when set', () => {
    const doc = readOnly({ name: 'prices', version: 3 });
    expect(checkTrust(doc, signedTrust(doc, { expect: { name: 'prices', version: 3 } }), RUN)).toEqual({ ok: true, signed: true });
    expect(checkTrust(doc, signedTrust(doc, { expect: { name: '' } }), RUN)).toEqual({ ok: true, signed: true });
    expect(checkTrust(doc, signedTrust(doc, { expect: { name: 'stock' } }), RUN)).toEqual(refused(nameMismatch('prices', 'stock')));
    // Expected Name is trimmed like Options → Name: spaces around it never refuse, blank means unset.
    expect(checkTrust(doc, signedTrust(doc, { expect: { name: '  prices \t' } }), RUN)).toEqual({ ok: true, signed: true });
    expect(checkTrust(doc, signedTrust(doc, { expect: { name: '   ' } }), RUN)).toEqual({ ok: true, signed: true });
    expect(checkTrust(doc, signedTrust(doc, { expect: { name: ' stock ' } }), RUN)).toEqual(refused(nameMismatch('prices', 'stock')));
    expect(checkTrust(doc, signedTrust(doc, { expect: { version: 4 } }), RUN)).toEqual(refused(versionMismatch(3, 4)));
  });
  it('Expected Version compares numerically; non-numeric values refuse; empty is unset', () => {
    const doc = readOnly({ name: 'prices', version: 4 });
    const withV = (version: unknown) => checkTrust(doc, signedTrust(doc, { expect: { version: version as never } }), RUN);
    expect(withV('4')).toEqual({ ok: true, signed: true });
    expect(withV('5')).toEqual(refused(versionMismatch(4, '5' as never)));
    expect(withV('abc')).toEqual(refused(versionMismatch(4, 'abc' as never)));
    for (const unset of ['', '  ', null, undefined]) expect(withV(unset)).toEqual({ ok: true, signed: true });
  });
  it('a document with valid name and version but broken steps passes the gate when signed', () => {
    const doc = { name: 'broken', version: 1, startUrl: `${site.url}/public/table`, steps: 'nope' };
    expect(checkTrust(doc, signedTrust(doc), RUN)).toEqual({ ok: true, signed: true });
  });
  it('the signed start site must be the run start site', () => {
    const doc = readOnly();
    const elsewhere = { ...policy, startUrl: 'https://example.com/login', navHosts: ['example.com', site.host] };
    expect(checkTrust(doc, signedTrust(doc), { policy: elsewhere, firstRun: false })).toEqual(refused(startSiteMismatch(site.host, 'example.com')));
  });
});
