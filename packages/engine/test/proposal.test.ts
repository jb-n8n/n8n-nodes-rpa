import { describe, expect, it } from 'vitest';
import { STEPS_CHANGED_AFTER_REVIEW, STEPS_HASH_MISMATCH, STEPS_NAME_MISMATCH, STEPS_VERSION_MISMATCH } from '../src/messages.js';
import { submitLabel } from '../src/policy/submits.js';
import { oneLine } from '../src/proposal/describe.js';
import { buildProposal, changeListMatches, describeCheck, describeInterrupt, describeStep, NO_REVIEW_DIGEST, proposalDigest, signSteps, stepChanges, UNVERIFIED_COUNT_FLAG, type FileEvidence, type Proposal } from '../src/proposal/proposal.js';
import type { ProveResult } from '../src/prove/prove.js';
import { createMasker } from '../src/secrets/mask.js';
import { scriptHash, verifyScript } from '../src/sign.js';
import type { Script, Step } from '../src/types.js';
import { APPROVER, baselineScript, policyFor, SECRETS, TEST_KEY } from './helpers.js';

const portal = { url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' };
const policy = policyFor(portal);
const masker = createMasker([SECRETS.username, SECRETS.password]);
const IDS = ['N26-0417', 'N26-0412', 'N26-0398', 'N26-0391', 'N26-0384', 'N26-0376', 'N26-0369'];
const proved = (over: Partial<ProveResult> = {}): ProveResult => ({ ok: true, rows: IDS.map((id) => ({ id })), total: 7, reasons: [], diff: { missing: [], extra: [] }, policyViolation: false, readPosts: [], ...over });
const READ: Step = { intent: 'Read the rows on this page', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}', textMode: 'textContent' } };
function repaired(): Script {
  const base = baselineScript(portal.url, 1);
  return {
    ...base, version: 2,
    steps: [
      ...base.steps.slice(0, 4),
      { intent: 'Open Field Actions', click: { role: 'link', name: 'Field Actions', exact: true }, checkpoint: true, expect: { url: '/acme/service/field-actions' } },
      READ,
    ],
  };
}

describe('step changes from the canonical steps, not intents', () => {
  const base = baselineScript(portal.url, 1);
  const bump = (over: (s: Script) => void): Script => {
    const s = structuredClone({ ...base, version: 2 });
    over(s);
    return s;
  };
  it('describes a step by intent, verb and locator, in a short human form', () => {
    expect(describeStep(base.steps[4])).toBe('Open Recalls & Stop-Sales (click role "link" name "Recalls & Stop-Sales")');
    // Every candidate the locator may match: the primary with exact, within and frame, then each fallback.
    expect(describeStep(base.steps[3])).toBe('Open Service (click role "link" name "Service" exact within [role "navigation"] or css "#nav-service")');
    expect(describeStep({ intent: 'Find', fill: { field: { label: 'Search', frame: 'iframe#f' }, value: 'x' } })).toBe('Find (fill label "Search" in frame "iframe#f" with "x")');
    expect(describeStep({ intent: 'Go', goto: 'https://example.com/a?b=1' })).toBe('Go (go to "https://example.com/a?b=1")');
    expect(describeStep({ intent: 'Skip', when: { visible: { css: '#later' } }, click: { css: '#later' } })).toBe('Skip (if css "#later" shows, click css "#later")');
    expect(describeInterrupt({ target: { css: '#cookie-overlay' }, click: { role: 'button', name: 'Accept all', fallbacks: [{ testId: 'ok' }] } }))
      .toBe('Pop-up handler: when css "#cookie-overlay" shows, click role "button" name "Accept all" or test id "ok"');
    // Names are JSON-quoted: page text cannot fake a separator or a second candidate.
    expect(describeStep({ intent: 'x', click: { text: 'A" or css "#b' } })).toBe('x (click text "A\\" or css \\"#b")');
  });
  it('lists a step whose locator changed even though its intent is the same', () => {
    const script = bump((s) => { s.steps[4] = { ...s.steps[4], click: { role: 'link', name: 'Cancel order' } } as Step; });
    expect(stepChanges(base, script)).toEqual([{
      was: 'Open Recalls & Stop-Sales (click role "link" name "Recalls & Stop-Sales")',
      now: 'Open Recalls & Stop-Sales (click role "link" name "Cancel order")',
    }]);
    const p = buildProposal({ base, script, prove: proved(), safetyFlags: [], masker });
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0].now).toContain('Cancel order');
  });
  it('shows a change confined to a fallback, and names the fields of a change the short form cannot show', () => {
    const script = bump((s) => { s.steps[3] = { ...s.steps[3], click: { role: 'link', name: 'Service', exact: true, within: { role: 'navigation' }, fallbacks: [{ css: '#cancel-all' }] } } as Step; });
    expect(stepChanges(base, script)).toEqual([{
      was: 'Open Service (click role "link" name "Service" exact within [role "navigation"] or css "#nav-service")',
      now: 'Open Service (click role "link" name "Service" exact within [role "navigation"] or css "#cancel-all")',
    }]);
    const quiet = bump((s) => { s.steps[4] = { ...s.steps[4], expect: { heading: 'Other' }, timeoutMs: 100 } as Step; });
    expect(stepChanges(base, quiet)).toEqual([{
      was: 'Open Recalls & Stop-Sales (click role "link" name "Recalls & Stop-Sales")',
      now: 'Open Recalls & Stop-Sales (click role "link" name "Recalls & Stop-Sales") (also changed: expect.heading, timeoutMs)',
    }]);
  });
  it('lists added and removed pop-up handlers (interrupts) and nothing for unchanged steps', () => {
    expect(stepChanges(base, bump(() => undefined))).toEqual([]);
    const added = bump((s) => { s.interrupts = [...(s.interrupts ?? []), { target: { css: '#promo' }, click: { role: 'link', name: 'Unsubscribe' } }]; });
    expect(stepChanges(base, added)).toEqual([{ was: null, now: 'Pop-up handler: when css "#promo" shows, click role "link" name "Unsubscribe"' }]);
    const removed = bump((s) => { s.interrupts = s.interrupts?.slice(1); });
    expect(stepChanges(base, removed)).toEqual([{ was: 'Pop-up handler: when css "#cookie-overlay" shows, click role "button" name "Accept all"', now: null }]);
  });
  it('changeListMatches accepts the change list stepChanges builds and refuses a description the steps do not have', () => {
    const quiet = bump((s) => { s.steps[4] = { ...s.steps[4], expect: { heading: 'Other' }, timeoutMs: 100 } as Step; });
    const added = bump((s) => { s.interrupts = [...(s.interrupts ?? []), { target: { css: '#promo' }, click: { role: 'link', name: 'Unsubscribe' } }]; });
    for (const script of [quiet, added]) expect(changeListMatches(script, stepChanges(base, script))).toBe(true);
    expect(changeListMatches(base, [{ was: 'x', now: null }, 'not an entry', null])).toBe(true);
    for (const now of ['Open it (click css "#safe")', 'Pop-up handler: when css "#x" shows, click css "#y"', 42]) {
      expect(changeListMatches(base, [{ was: null, now }])).toBe(false);
    }
    const masked = (t: string) => t.replace('Recalls', '[secret]');
    expect(changeListMatches(base, [{ was: null, now: masked(describeStep(base.steps[4])) }], masked)).toBe(true);
    expect(changeListMatches(base, [{ was: null, now: describeStep(base.steps[4]) }], masked)).toBe(false);
  });
  it('masks every description', () => {
    const script = bump((s) => { s.steps[4] = { intent: 'Open it', click: { text: SECRETS.username } } as Step; });
    const p = buildProposal({ base, script, prove: proved(), safetyFlags: [], masker });
    expect(JSON.stringify(p.changes)).not.toContain(SECRETS.username);
    expect(JSON.stringify(p.changes)).toContain('[secret]');
  });
});

describe('buildProposal', () => {
  it('describes a repair: versions, hash, evidence and plain-English changes', () => {
    const base = baselineScript(portal.url, 1);
    const script = repaired();
    const before = Buffer.from('before');
    const p = buildProposal({ base, script, prove: proved({ diff: { missing: [], extra: ['N26-0369'] } }), safetyFlags: [], masker, beforeScreenshot: before });
    expect(p).toMatchObject({ name: 'demo-sandbox', baseVersion: 1, version: 2, hash: scriptHash(script), safetyFlags: [] });
    expect(p.evidence).toEqual({ count: 7, total: 7, diff: { missing: [], extra: ['N26-0369'] } });
    expect(p.changes).toEqual([
      { was: 'Open Recalls & Stop-Sales (click role "link" name "Recalls & Stop-Sales")', now: 'Open Field Actions (click role "link" name "Field Actions" exact)' },
      { was: 'Read every page of notices (paginate next text "Next page" until absent, at most 10 pages)', now: 'Read the rows on this page (extract rows from css "main", ID pattern N26-\\d{4})' },
      { was: 'Read notices on this page (extract rows from css "main", ID pattern N26-\\d{4})', now: null },
    ]);
    expect(p.screenshots).toEqual({ before });
  });
  it('a first proposal lists every step as new; no stated total raises a red flag; intents are masked', () => {
    const script = { ...repaired(), version: 1 };
    script.steps[4] = { ...script.steps[4], intent: `Open ${SECRETS.username} profile` };
    const p = buildProposal({ script, prove: proved({ total: null }), safetyFlags: [`new host: ${portal.host}`], masker });
    expect(p.baseVersion).toBeNull();
    expect(p.changes.every((c) => c.was === null)).toBe(true);
    expect(p.changes.map((c) => c.now)).toContain('Open [secret] profile (click role "link" name "Field Actions" exact)');
    // The pop-up handlers of a first proposal are new too.
    expect(p.changes.filter((c) => c.now?.startsWith('Pop-up handler: '))).toHaveLength(2);
    expect(p.safetyFlags).toEqual([`new host: ${portal.host}`, UNVERIFIED_COUNT_FLAG]);
  });
});

describe('signSteps', () => {
  const proposal = (): Proposal => buildProposal({ base: baselineScript(portal.url, 1), script: repaired(), prove: proved(), safetyFlags: [], masker });
  it('re-validates, then signs the exact script for the approver', () => {
    const p = proposal();
    const r = signSteps({ proposal: p, key: TEST_KEY, approverId: APPROVER, policy, secrets: SECRETS, now: new Date('2026-10-05T12:00:00Z'), reviewedDigest: proposalDigest(p) });
    if (!r.ok) throw new Error(r.reasons.join('; '));
    expect(r.row).toMatchObject({ name: 'demo-sandbox', version: 2, approvedBy: APPROVER, approvedAt: '2026-10-05T12:00:00.000Z', status: 'active', hash: scriptHash(repaired()) });
    expect(verifyScript(r.row.steps, TEST_KEY, { approvedBy: APPROVER, signature: r.row.signature })).toBe(true);
  });
  it('refuses a script changed after review, an unsafe script, an old version and missing approver or key', () => {
    const tampered = proposal();
    tampered.steps.steps.push({ intent: 'Leave', goto: 'https://evil.example/x' });
    const t = signSteps({ proposal: tampered, key: TEST_KEY, approverId: APPROVER, policy, secrets: SECRETS, reviewedDigest: proposalDigest(tampered) });
    if (t.ok) throw new Error('expected refusal');
    expect(t.reasons).toContain('the steps do not match the hash that was reviewed');
    expect(t.reasons.some((r) => /evil\.example is not in the allowed hosts/.test(r))).toBe(true);
    const old = { ...proposal(), baseVersion: 2 };
    const o = signSteps({ proposal: old, key: TEST_KEY, approverId: APPROVER, policy, secrets: SECRETS, reviewedDigest: proposalDigest(old) });
    expect(o.ok ? [] : o.reasons).toContain('version 2 is not newer than the base version 2');
    const nobody = signSteps({ proposal: proposal(), key: '', approverId: '', policy, secrets: SECRETS, reviewedDigest: proposalDigest(proposal()) });
    expect(nobody.ok ? [] : nobody.reasons).toEqual(['approver id is empty', 'signing key is empty']);
  });
});

describe('review binding and input hardening', () => {
  const mk = (): Proposal => buildProposal({ base: baselineScript(portal.url, 1), script: repaired(), prove: proved(), safetyFlags: [], masker });
  const ok = (extra: object) => signSteps({ proposal: mk(), key: TEST_KEY, approverId: APPROVER, policy, secrets: SECRETS, reviewedDigest: proposalDigest(mk()), ...extra });
  it('digest is stable and covers script, changes and flags but not screenshots', () => {
    const d = proposalDigest(mk());
    expect(proposalDigest(mk())).toBe(d);
    const a = mk(); a.changes = [...a.changes, { was: null, now: 'x' }];
    const b = mk(); b.safetyFlags = ['x'];
    const c = mk(); c.steps = { ...c.steps, steps: c.steps.steps.slice(1) };
    const e = mk(); e.screenshots = { before: Buffer.from('z') };
    expect([a, b, c].map(proposalDigest).every((x) => x !== d)).toBe(true);
    expect(proposalDigest(e)).toBe(d);
  });
  it('pins approval to the reviewed digest', () => {
    expect(ok({ reviewedDigest: proposalDigest(mk()) }).ok).toBe(true);
    const stale = ok({ reviewedDigest: 'f'.repeat(64) });
    expect(stale.ok ? [] : stale.reasons).toContain('the repaired steps changed after they were reviewed');
    const swapped = mk();
    swapped.steps = { ...swapped.steps, steps: [...swapped.steps.steps, { intent: 'Extra', click: { role: 'link', name: 'X' } }] };
    swapped.hash = scriptHash(swapped.steps);
    const r = signSteps({ proposal: swapped, key: TEST_KEY, approverId: APPROVER, policy, secrets: SECRETS, reviewedDigest: proposalDigest(mk()) });
    expect(r.ok ? [] : r.reasons).toContain('the repaired steps changed after they were reviewed');
  });
  it('refuses an absent or empty review digest, signing nothing', () => {
    const none = ok({ reviewedDigest: undefined });
    expect(none).toEqual({ ok: false, reasons: [NO_REVIEW_DIGEST] });
    expect(NO_REVIEW_DIGEST).toBe('the proposal has no review digest');
    expect(ok({ reviewedDigest: '' })).toEqual({ ok: false, reasons: [NO_REVIEW_DIGEST] });
    expect(ok({ reviewedDigest: '   ' })).toEqual({ ok: false, reasons: [NO_REVIEW_DIGEST] });
  });
  it('treats blank approver/key as empty and refuses an invalid time', () => {
    const r = ok({ key: '  ', approverId: ' ' });
    expect(r.ok ? [] : r.reasons).toEqual(['approver id is empty', 'signing key is empty']);
    const n = ok({ now: new Date('nope') });
    expect(n.ok ? [] : n.reasons).toEqual(['approval time is invalid']);
  });
  it('refuses to build from a failed prove and does not duplicate the unverified flag', () => {
    expect(() => buildProposal({ script: repaired(), prove: proved({ ok: false }), safetyFlags: [], masker })).toThrow('a proposal needs a passing prove');
    const p = buildProposal({ script: repaired(), prove: proved({ total: null }), safetyFlags: [UNVERIFIED_COUNT_FLAG], masker });
    expect(p.safetyFlags).toEqual([UNVERIFIED_COUNT_FLAG]);
  });
});

describe('signSteps with name and steps', () => {
  const mk = (): Proposal => buildProposal({ base: baselineScript(portal.url, 1), script: repaired(), prove: proved(), safetyFlags: [], masker });
  const sign = (p: Proposal) => signSteps({ proposal: p, key: TEST_KEY, approverId: APPROVER, policy, secrets: SECRETS, now: new Date('2026-10-06T12:00:00Z'), reviewedDigest: proposalDigest(p) });
  it('a repaired steps item carries name and steps, and signs into a SignedStepsRow with steps', () => {
    const p = mk();
    expect(p).toMatchObject({ name: 'demo-sandbox', steps: repaired() });
    expect(p).not.toHaveProperty('portal');
    expect(p).not.toHaveProperty('script');
    const r = sign(p);
    if (!r.ok) throw new Error(r.reasons.join('; '));
    expect(r.row).toEqual({
      name: 'demo-sandbox', version: 2, steps: repaired(), hash: scriptHash(repaired()), signature: expect.stringMatching(/^[0-9a-f]{64}$/),
      approvedBy: APPROVER, approvedAt: '2026-10-06T12:00:00.000Z', status: 'active',
    });
  });
  it('each reworded refusal reason', () => {
    const renamed = { ...mk(), name: 'other-steps' };
    expect(sign(renamed)).toEqual({ ok: false, reasons: [STEPS_NAME_MISMATCH] });
    const bumped = { ...mk(), version: 3 };
    expect(sign(bumped)).toEqual({ ok: false, reasons: [STEPS_VERSION_MISMATCH] });
    const edited = mk();
    edited.steps = { ...edited.steps, steps: edited.steps.steps.slice(0, -1) };
    expect(sign(edited)).toEqual({ ok: false, reasons: [STEPS_HASH_MISMATCH] });
    const stale = mk();
    const r = signSteps({ proposal: stale, key: TEST_KEY, approverId: APPROVER, policy, secrets: SECRETS, reviewedDigest: 'f'.repeat(64) });
    expect(r).toEqual({ ok: false, reasons: [STEPS_CHANGED_AFTER_REVIEW] });
  });
});

describe('signSteps binds the Site Login', () => {
  it('signs with the Site Login id when given, and only that id verifies', () => {
    const proposal = buildProposal({ base: baselineScript(portal.url, 1), script: repaired(), prove: proved(), safetyFlags: [], masker });
    const r = signSteps({ proposal, key: TEST_KEY, approverId: APPROVER, policy, secrets: SECRETS, reviewedDigest: proposalDigest(proposal), siteLoginId: 'cred-1' });
    if (!r.ok) throw new Error(r.reasons.join('; '));
    expect(verifyScript(r.row.steps, TEST_KEY, { approvedBy: APPROVER, siteLoginId: 'cred-1', signature: r.row.signature })).toBe(true);
    expect(verifyScript(r.row.steps, TEST_KEY, { approvedBy: APPROVER, signature: r.row.signature })).toBe(false);
    expect(verifyScript(r.row.steps, TEST_KEY, { approvedBy: APPROVER, siteLoginId: 'cred-2', signature: r.row.signature })).toBe(false);
  });
});

describe('read-only POSTs in the evidence', () => {
  const mk = (readPosts?: string[]): Proposal => buildProposal({ base: baselineScript(portal.url, 1), script: repaired(), prove: proved(readPosts ? { readPosts } : {}), safetyFlags: [], masker });
  it('the digest covers evidence.readPosts', () => {
    const a = mk(['POST h /a']);
    const b = mk(['POST h /b']);
    expect(proposalDigest(a)).not.toBe(proposalDigest(b));
    expect(proposalDigest(a)).not.toBe(proposalDigest(mk()));
    expect(mk().evidence).not.toHaveProperty('readPosts');
    expect(a.evidence.readPosts).toEqual(['POST h /a']);
  });
});

describe('a download\'s checks in the change list', () => {
  const dl = (check?: object): Step => ({ intent: 'Download the export', download: { trigger: { css: 'a.dl' }, ...(check ? { check } : {}) } } as Step);
  const full = { name: '^LINEITEMS_', minBytes: 100, columns: ['Document', 'Posting Date'], minRows: 1 };
  it('describeStep shows a download\'s checks', () => {
    const step = { intent: 'Download the export', download: { trigger: { css: 'a.dl' }, mime: ['text/csv'], check: full } } as Step;
    expect(describeStep(step)).toBe('Download the export (download with css "a.dl"; checks: type text/csv; name /^LINEITEMS_/; at least 100 bytes; columns "Document", "Posting Date"; at least 1 row)');
    expect(describeCheck({ mime: ['text/csv'], check: full })).toBe('type text/csv; name /^LINEITEMS_/; at least 100 bytes; columns "Document", "Posting Date"; at least 1 row');
  });
  it('a download without check describes as before', () => {
    expect(describeStep(dl())).toBe('Download the export (download with css "a.dl")');
  });
  it('stepChanges lists a changed check even when the trigger is the same', () => {
    const mk = (check: object): Script => ({ ...baselineScript(portal.url, 1), steps: [dl(check)] });
    const out = stepChanges(mk({ columns: ['Amount'] }), mk({ columns: ['Currency'] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.now).toContain('columns "Currency"');
  });
});

describe('file evidence', () => {
  const FILE: FileEvidence = { fileName: 'LINEITEMS_1000.csv', mimeType: 'text/csv', bytes: 2048, columns: ['Document', 'Amount'], rows: 12 };
  const fileScript = (): Script => ({
    ...baselineScript(portal.url, 1), version: 2,
    steps: [...baselineScript(portal.url, 1).steps.slice(0, 4), { intent: 'Download the export', download: { trigger: { css: 'a.dl' }, mime: ['text/csv'], check: { name: '^LINEITEMS_' } } }],
  });
  const mk = (file = FILE, over: Partial<ProveResult> = {}): Proposal => buildProposal({
    base: baselineScript(portal.url, 1), script: fileScript(), prove: proved({ rows: [], total: null, file, ...over }), safetyFlags: [], masker,
  });
  it('a file proposal carries evidence.file and no count-unverified flag', () => {
    const p = mk();
    expect(p.evidence).toEqual({ count: 0, total: null, diff: { missing: [], extra: [] }, file: FILE });
    expect(p.safetyFlags).not.toContain(UNVERIFIED_COUNT_FLAG);
    // Without a file, a null total still raises the flag.
    expect(buildProposal({ script: fileScript(), prove: proved({ rows: [], total: null }), safetyFlags: [], masker }).safetyFlags).toContain(UNVERIFIED_COUNT_FLAG);
    // Page-derived strings are masked; columns are clipped to 50 entries of 80 characters.
    const long = Array.from({ length: 60 }, (_, i) => `${i}`.padEnd(100, 'x'));
    const hostile = mk({ fileName: `${SECRETS.username}.csv`, mimeType: 'text/csv', bytes: 9, columns: [SECRETS.password, ...long], rows: null });
    expect(hostile.evidence.file?.fileName).toBe('[secret].csv');
    expect(hostile.evidence.file?.columns).toHaveLength(50);
    expect(hostile.evidence.file?.columns?.[0]).toBe('[secret]');
    expect(hostile.evidence.file?.columns?.every((c) => c.length <= 80)).toBe(true);
    expect(JSON.stringify(hostile)).not.toContain(SECRETS.password);
  });
  it('the digest changes when evidence.file changes', () => {
    const a = mk();
    expect(proposalDigest(a)).toBe(proposalDigest(mk()));
    expect(proposalDigest(a)).not.toBe(proposalDigest(mk({ ...FILE, rows: 13 })));
    expect(proposalDigest(a)).not.toBe(proposalDigest(mk({ ...FILE, fileName: 'LINEITEMS_2000.csv' })));
    expect(proposalDigest(a)).not.toBe(proposalDigest({ ...a, evidence: { ...a.evidence, file: undefined } }));
  });
});

describe('describe text cannot be spoofed', () => {
  it('unsafe values render on one line and cannot fake a clause', () => {
    const intent = describeStep({ intent: 'Open\nRemoved: x', click: { css: 'a' } } as Step);
    expect(intent).toBe('Open\\nRemoved: x (click css "a")');
    expect(intent).not.toContain('\n');
    expect(describeStep({ intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'a;b' } } as Step)).toContain('ID pattern "a;b"');
    expect(describeStep({ intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'A-\\d+' } } as Step)).toContain('ID pattern A-\\d+');
    expect(describeCheck({ check: { name: 'x\ny' } })).toBe('name "x\\ny"');
    expect(describeCheck({ mime: ['text/csv; x'], check: {} })).toBe('type "text/csv; x"');
    expect(describeCheck({ check: { name: 'a\u200bb' } })).toBe('name "a\\u200bb"');
  });
  it('safe values are byte-identical', () => {
    expect(describeCheck({ mime: ['text/csv', 'text/plain'], check: { name: '^LINEITEMS_', minBytes: 5 } })).toBe('type text/csv, text/plain; name /^LINEITEMS_/; at least 5 bytes');
    expect(describeStep({ intent: 'Accept cookies (if shown)', submit: { button: { css: 'b' }, host: 'a.example.com', path: '/x' } } as Step))
      .toBe('Accept cookies (if shown) (submit with css "b" to POST a.example.com/x)');
  });
  it('an empty check reads no checks', () => {
    expect(describeCheck({ check: {} })).toBe('no checks');
  });
});

describe('describe text quoting', () => {
  it('locator and column quoting escapes U+2028, C1 and Cf characters', () => {
    const step = { intent: 'x', click: { text: 'a\u2028b\u0085c\u202ed' } } as Step;
    expect(describeStep(step)).toBe('x (click text "a\\u2028b\\u0085c\\u202ed")');
    expect(describeCheck({ check: { columns: ['a\u202eb'] } })).toBe('columns "a\\u202eb"');
  });
  it('submitLabel quotes an unsafe host or path and keeps safe labels byte-identical', () => {
    expect(submitLabel({ method: 'post', host: 'a.example.com', path: '/x?y=1' })).toBe('POST a.example.com/x?y=1');
    expect(submitLabel({ method: 'POST', host: 'h\n', path: '/p; new host: evil' })).toBe('POST "h\\n""/p; new host: evil"');
    expect(submitLabel({ method: 'POST', host: 'h\n', path: '/p' })).not.toContain('\n');
  });
  it('oneLine escapes each UTF-16 unit of an astral format character', () => {
    expect(oneLine('\u{1d173}')).toBe('\\ud834\\udd73');
    expect(oneLine('\u{1d173}')).not.toBe(oneLine('\u{1d174}'));
    expect(oneLine('\u{e0041}')).toBe('\\udb40\\udc41');
  });
});
