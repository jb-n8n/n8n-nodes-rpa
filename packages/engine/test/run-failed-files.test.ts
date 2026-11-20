// A run that fails after some steps downloaded files returns those files on its failure, under the binary names a
// success gives them; the import's draft run never returns them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { runDraft } from '../src/lane/draft.js';
import { FILES_ON_FAILURE, filesOnFailure, runScriptLane } from '../src/lane/script-lane.js';
import { MAX_RUN_BINARY_BYTES } from '../src/steps/limits.js';
import type { DownloadedFile, ErrorCode, Script, Step, Violation } from '../src/types.js';
import { LOCAL, publicPolicy, signedLaneInput } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });

const steps = (): Step[] => [
  { intent: 'Open the files page', goto: `${portal.url}/public/files` },
  { intent: 'Download the report', download: { trigger: { css: '#csv' }, mime: ['text/csv'], check: { name: '^report', columns: ['code'] } } },
  { intent: 'Download the archive', download: { trigger: { css: '#zip' }, mime: ['application/zip'] } },
  { intent: 'Open the next section', timeoutMs: 500, click: { role: 'link', name: 'Next section' } },
];
const script = (): Script => ({ name: 'files', version: 1, startUrl: `${portal.url}/public/files`, steps: steps() });

describe('a run that fails after it downloaded files', () => {
  it('returns each file it already downloaded on its failure, with the binary names of a success', async () => {
    const r = await runScriptLane(signedLaneInput(script(), { policy: publicPolicy(portal, { startUrl: `${portal.url}/public/files` }), endpoint: LOCAL, defaultStepTimeoutMs: 3000 }));
    if (r.ok) throw new Error('expected a failure');
    expect(r.code).toBe('drift_detected');
    expect(r.files?.map((f) => [f.binaryName, f.fileName, f.mimeType])).toEqual([['file_1', 'report.csv', 'text/csv'], ['file_2', 'archive.zip', 'application/zip']]);
    expect(r.files?.[0].data.toString()).toBe('code,name\nSKU-1,Widget\n');
  });

  it('a file whose own check failed is not returned, and a run that downloaded nothing has no files', async () => {
    const bad = steps();
    bad[2] = { intent: 'Download the archive', download: { trigger: { css: '#zip' }, mime: ['application/zip'], check: { name: '^nothing' } } };
    const r = await runScriptLane(signedLaneInput({ ...script(), steps: bad }, { policy: publicPolicy(portal, { startUrl: `${portal.url}/public/files` }), endpoint: LOCAL, defaultStepTimeoutMs: 3000 }));
    if (r.ok) throw new Error('expected a failure');
    expect(r.files?.map((f) => f.binaryName)).toEqual(['file_1']);
    const none = await runScriptLane(signedLaneInput({ ...script(), steps: [steps()[0], steps()[3]] }, { policy: publicPolicy(portal, { startUrl: `${portal.url}/public/files` }), endpoint: LOCAL, defaultStepTimeoutMs: 3000 }));
    expect(none).toMatchObject({ ok: false });
    expect(none).not.toHaveProperty('files');
  });

  it('a run the policy stopped after a download returns no file: the stop is the protection', async () => {
    // On the allowed site, a link that sends the browser to a site the rules do not list: stopped while the run goes on.
    const offList: Step = { intent: 'Open the next section', goto: `${portal.url}/public/redirect?to=${encodeURIComponent('http://elsewhere.example.invalid/next')}` };
    const r = await runScriptLane(signedLaneInput({ ...script(), steps: [...steps().slice(0, 3), offList] }, { policy: publicPolicy(portal, { startUrl: `${portal.url}/public/files` }), endpoint: LOCAL, defaultStepTimeoutMs: 3000 }));
    if (r.ok) throw new Error('expected a failure');
    expect(r.code).toBe('policy_violation');
    expect(r.violations.some((v) => v.fatal)).toBe(true);
    expect(r).not.toHaveProperty('files');
  });

  it('files come back only for an ordinary site failure, never after a fatal violation, and within the run\'s binary cap', () => {
    const file = (name: string, bytes: number): DownloadedFile => ({ fileName: `${name}.csv`, mimeType: 'text/csv', data: { length: bytes } as Buffer, binaryName: name });
    const two = { outputs: [], downloads: [file('file_1', 10), file('file_2', 20)] };
    expect([...FILES_ON_FAILURE].sort()).toEqual(['drift_detected', 'incomplete', 'not_found', 'site_down']);
    expect(filesOnFailure('drift_detected', two, []).files?.map((f) => f.binaryName)).toEqual(['file_1', 'file_2']);
    const refused: ErrorCode[] = ['policy_violation', 'script_untrusted', 'login_failed', 'account_locked', 'auth_blocked', 'locked_out', 'busy', 'password_change_failed', 'browser_unavailable', 'runner_unavailable'];
    for (const code of refused) expect(filesOnFailure(code, two, []), code).toEqual({});
    const fatal: Violation = { kind: 'host', url: 'http://elsewhere.example.invalid/', fatal: true };
    const blocked: Violation = { ...fatal, fatal: false };
    expect(filesOnFailure('drift_detected', two, [fatal])).toEqual({});
    expect(filesOnFailure('drift_detected', two, [blocked]).files).toHaveLength(2);
    // Over the run's cap, as a success would refuse it: the file that goes over is dropped, the others stay.
    const big = { outputs: [], downloads: [file('file_1', 10), file('file_2', MAX_RUN_BINARY_BYTES), file('file_3', 20)] };
    expect(filesOnFailure('incomplete', big, []).files?.map((f) => f.binaryName)).toEqual(['file_1', 'file_3']);
    expect(filesOnFailure('drift_detected', { outputs: [], downloads: [] }, [])).toEqual({});
  });

  it('the import\'s draft run returns no file from a failure', async () => {
    const r = await runDraft({ script: { ...script(), steps: [steps()[0], steps()[1], steps()[3]] }, policy: publicPolicy(portal, { startUrl: `${portal.url}/public/files` }), endpoint: LOCAL, defaultStepTimeoutMs: 3000 });
    expect(r).toMatchObject({ ok: false, code: 'drift_detected' });
    expect(r).not.toHaveProperty('files');
  });
});
