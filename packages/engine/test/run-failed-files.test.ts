// A run that fails after some steps downloaded files returns those files on its failure, under the binary names a
// success gives them; the import's draft run never returns them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { runDraft } from '../src/lane/draft.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import type { Script, Step } from '../src/types.js';
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

  it('the import\'s draft run returns no file from a failure', async () => {
    const r = await runDraft({ script: { ...script(), steps: [steps()[0], steps()[1], steps()[3]] }, policy: publicPolicy(portal, { startUrl: `${portal.url}/public/files` }), endpoint: LOCAL, defaultStepTimeoutMs: 3000 });
    expect(r).toMatchObject({ ok: false, code: 'drift_detected' });
    expect(r).not.toHaveProperty('files');
  });
});
