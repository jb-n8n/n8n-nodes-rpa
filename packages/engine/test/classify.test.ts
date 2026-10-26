import { describe, expect, it } from 'vitest';
import { classifyFailure, DETECTED_PREFIX, shownFailure, toErrorCode } from '../src/classify/classify.js';
import { BROWSER_ERROR_PAGE, PDF_NEEDS_HEADLESS } from '../src/messages.js';
import * as api from '../src/index.js';

const fail = (message: string) => ({ index: 3, intent: 'x', message });

describe('classifyFailure', () => {
  it('a failed download check is drift', () => {
    expect(classifyFailure({ violations: [], failure: fail('download check failed: the file has no column "A"') })).toBe('drift');
  });
  it('capture: and limit: failures are incomplete', () => {
    expect(classifyFailure({ violations: [], failure: fail('capture: x') })).toBe('incomplete');
    expect(classifyFailure({ violations: [], failure: fail('limit: x') })).toBe('incomplete');
    expect(classifyFailure({ violations: [], failure: fail(PDF_NEEDS_HEADLESS) })).toBe('incomplete');
  });
  it('limit: failures are incomplete', () => {
    expect(classifyFailure({ violations: [], failure: fail('limit: more than 10000 rows') })).toBe('incomplete');
  });
  it("start status in 'report' mode: 404/410 are not_found, 5xx and errors site_down", () => {
    expect(classifyFailure({ violations: [], startStatus: 404, startStatusMode: 'report' })).toBe('not_found');
    expect(classifyFailure({ violations: [], startStatus: 410, startStatusMode: 'report' })).toBe('not_found');
    expect(classifyFailure({ violations: [], startStatus: 503, startStatusMode: 'report' })).toBe('site_down');
    expect(classifyFailure({ violations: [], startError: BROWSER_ERROR_PAGE, startStatusMode: 'report' })).toBe('site_down');
    expect(classifyFailure({ violations: [], startStatus: 404, startStatusMode: 'classify' })).toBe('drift');
  });
  it('shown messages drop the limit: and capture: prefixes and keep the intent otherwise', () => {
    expect(shownFailure('Read', 'limit: more than 10000 rows')).toBe('more than 10000 rows');
    expect(shownFailure('Save', 'capture: Save as PDF needs headless Chromium')).toBe('Save as PDF needs headless Chromium');
    expect(shownFailure('Open', 'No element found for Visible Text "x"')).toBe('Open: No element found for Visible Text "x"');
  });
  it('fatal violations win over everything', () => {
    expect(classifyFailure({ violations: [{ kind: 'host', url: 'http://evil', fatal: true }], failure: fail('detected:login_failed') })).toBe('policy_violation');
  });
  it('ignores non-fatal (blocked) violations', () => {
    expect(classifyFailure({ violations: [{ kind: 'websocket', url: 'ws://x', fatal: false }], failure: fail('no unique visible element') })).toBe('drift');
  });
  it('start page failures are site_down', () => {
    expect(classifyFailure({ violations: [], startError: 'net::ERR_CONNECTION_REFUSED' })).toBe('site_down');
    expect(classifyFailure({ violations: [], startStatus: 503 })).toBe('site_down');
  });
  it('maps login detect results', () => {
    expect(classifyFailure({ violations: [], failure: fail('detected:login_failed') })).toBe('login_failed');
    expect(classifyFailure({ violations: [], failure: fail('detected:account_locked') })).toBe('account_locked');
    expect(classifyFailure({ violations: [], failure: fail('detected:mfa_sms') })).toBe('auth_blocked');
    expect(classifyFailure({ violations: [], failure: fail('detected:mfa_totp') })).toBe('auth_blocked');
  });
  it('recognises lockout text on the page', () => {
    expect(classifyFailure({ violations: [], failure: fail('x'), pageText: 'Your account has been locked.' })).toBe('account_locked');
    expect(classifyFailure({ violations: [], failure: fail('x'), pageText: 'Too many failed sign-in attempts' })).toBe('account_locked');
  });
  it('ignores lockout text once login was confirmed', () => {
    expect(classifyFailure({ violations: [], failure: fail('x'), pageText: 'Your account has been locked.', loginConfirmed: true })).toBe('drift');
    expect(classifyFailure({ violations: [], failure: fail('x'), pageText: 'Your account has been locked.', loginConfirmed: false })).toBe('account_locked');
  });
  it('treats runaway pagination and rejected downloads as incomplete', () => {
    expect(classifyFailure({ violations: [], failure: fail('paginate: still a next page after 10 pages') })).toBe('incomplete');
    expect(classifyFailure({ violations: [], failure: fail('download exceeds 52428800 bytes') })).toBe('incomplete');
    expect(classifyFailure({ violations: [], failure: fail('download type text/html is not allowed') })).toBe('incomplete');
    expect(classifyFailure({ violations: [], failure: fail('paginate: page did not change after clicking next') })).toBe('drift');
  });
  it('maps classes to error codes', () => {
    expect(DETECTED_PREFIX).toBe('detected:');
    expect(toErrorCode('drift')).toBe('drift_detected');
    expect(toErrorCode('login_failed')).toBe('login_failed');
    expect(toErrorCode('incomplete')).toBe('incomplete');
  });
  it('does not expose the handler registry from the package entry point', () => {
    expect('registerHandlers' in api).toBe(false);
    expect(typeof api.toErrorCode).toBe('function');
    expect(api.DETECTED_PREFIX).toBe('detected:');
  });
  it('network and 5xx errors mid-run are site_down; anything else is drift', () => {
    expect(classifyFailure({ violations: [], failure: fail('page.goto: net::ERR_TIMED_OUT') })).toBe('site_down');
    expect(classifyFailure({ violations: [], failure: fail('HTTP 502 at http://p/x') })).toBe('site_down');
    expect(classifyFailure({ violations: [], failure: fail('no unique visible element for role=link') })).toBe('drift');
  });
  it('a missing start page is drift; any other 4xx start page is site_down', () => {
    expect(classifyFailure({ violations: [], startStatus: 404 })).toBe('drift');
    expect(classifyFailure({ violations: [], startStatus: 410 })).toBe('drift');
    expect(classifyFailure({ violations: [], startStatus: 403 })).toBe('site_down');
    expect(classifyFailure({ violations: [], startStatus: 429 })).toBe('site_down');
  });
});
