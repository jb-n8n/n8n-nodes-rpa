// Desktop repair with screenshots (set-of-marks): each view also goes to the model as the runner's masked, labelled
// picture; only the latest picture is sent; pictures never reach the transcript; a model that does not take pictures,
// a runner that cannot make one, and an older runner all fall back to the text view; the film hook for demos.
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { latestPictureOnly, mayBePictureRefusal, PICTURE_OMITTED, PICTURES_REFUSED_NOTE } from '../src/agent/loop.js';
import { imageTokenEstimate, modelMessageText, type ChatModel, type ModelMessage } from '../src/agent/model.js';
import { DESKTOP_PICTURE_CAPTION } from '../src/desktop/repair/prompt.js';
import {
  PICTURE_MASK_TOO_MANY, PICTURE_MASK_TOO_SHORT, PICTURE_MAX_MASK_TEXT_LENGTH, PICTURE_MAX_MASK_TEXTS, pictureMaskTexts, RUNNER_TOO_OLD_FOR_PICTURES,
} from '../src/desktop/surface.js';
import { runDesktopTask, type DesktopRepairSuccess, type DesktopTaskInput, type DesktopTaskResult } from '../src/desktop/task.js';
import { costSentence } from '../src/messages.js';
import { desktopProposal, signDesktopSteps } from '../src/proposal/desktop.js';
import { proposalDigest } from '../src/proposal/proposal.js';
import type { DesktopScript } from '../src/types.js';
import { fakeModel } from './fake-model.js';
import { V2_TURNS } from './erp-v2-turns.js';
import { ERP_PASSWORD, ERP_POLICY, FAKE_PNG, FakeRunner, type FakeRunnerOptions } from './fake-runner.js';
import { EXPECTED, VARS } from './fixtures/erp-steps.js';

const KEY = 'desktop-signing-key-0123456789abcdef';
const OWNER = 'owner@example.com';
const PICTURE_TOKENS = imageTokenEstimate({ width: 800, height: 600 });

let runner: FakeRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

const CLICK_SIGN_IN: DesktopScript = (() => {
  const d = structuredClone(EXPECTED);
  d.steps[3] = { intent: 'Click Sign in', click: { uia: { window: { exe: 'erpdemo.exe', title: 'ERP Demo - Sign in' }, path: [{ controlType: 'Button', automationId: 'btnSignIn', name: 'Sign in' }] } } };
  return d;
})();

function signed(): { script: unknown; trust: DesktopTaskInput['trust'] } {
  const p = desktopProposal(CLICK_SIGN_IN);
  const s = signDesktopSteps({ proposal: p, key: KEY, approverId: OWNER, reviewedDigest: proposalDigest(p), writeSteps: [16] });
  if (!s.ok) throw new Error(s.reasons.join('; '));
  return { script: JSON.parse(JSON.stringify(s.row.steps)) as unknown, trust: { required: true, signature: s.row.signature, approvedBy: OWNER, key: KEY } };
}

async function run(opts: { runner?: Partial<FakeRunnerOptions>; repair?: Partial<NonNullable<DesktopTaskInput['repair']>>; model?: ChatModel } = {}) {
  runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2', ...opts.runner });
  const model = fakeModel(V2_TURNS);
  const r = await runDesktopTask({
    ...signed(), runner: runner.endpoint, vars: VARS, secretVars: ['password'], defaultStepTimeoutMs: 400, budgetMs: 120_000,
    repair: { model: opts.model ?? model, goal: 'Export the line items of a company as a CSV file', pictures: true, ...opts.repair },
  });
  return { r, model, runner };
}

const repaired = (r: DesktopTaskResult): DesktopRepairSuccess => {
  if (!r.ok || r.lane !== 'agent') throw new Error(`expected a repair, got ${r.ok ? r.lane : `${r.code}: ${r.message}`}`);
  return r as DesktopRepairSuccess;
};

const imageParts = (messages: ModelMessage[]) =>
  messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'image_url')));

describe('desktop repair with screenshots', () => {
  it('sends each view with its masked picture, only the latest picture per call, and never in the transcript', async () => {
    const { r, model, runner: fr } = await run();
    const out = repaired(r);
    expect(out.llmCalls).toBe(4);
    // The first message carries the first view's picture as a content part after the text.
    const first = model.invocations[0]!.find((m) => m.role === 'user')!;
    expect(Array.isArray(first.content)).toBe(true);
    expect(first.content).toEqual([
      { type: 'text', text: expect.stringContaining('Screenshot: sent with this view (800x600 pixels') },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${FAKE_PNG}` } },
    ]);
    // Every call sends exactly one picture: the latest; earlier ones are omitted.
    for (const sent of model.invocations) expect(imageParts(sent)).toHaveLength(1);
    const last = model.invocations.at(-1)!;
    expect(last.filter((m) => modelMessageText(m).includes(PICTURE_OMITTED)).length).toBeGreaterThan(0);
    // A later picture comes in a user message after the tool results, with the caption.
    const captioned = last.filter((m) => m.role === 'user' && modelMessageText(m).startsWith(DESKTOP_PICTURE_CAPTION));
    expect(captioned.length).toBeGreaterThan(0);
    const idx = last.indexOf(captioned.at(-1)!);
    expect(last[idx - 1]!.role).toBe('tool');
    // The system prompt explains the labels.
    expect(modelMessageText(model.invocations[0]![0]!)).toContain('label 12 is e12');

    // The transcript keeps the text only.
    const transcript = JSON.stringify(out.transcript);
    expect(transcript).not.toContain(FAKE_PNG);
    expect(transcript).not.toContain('image_url');
    expect(out.transcript.some((m) => 'images' in m)).toBe(false);
    expect(transcript).toContain('Screenshot: sent with this view');

    // What the pictures cost: one per call, each about 640 tokens, inside the reported tokens.
    expect(out.pictures).toEqual({ count: expect.any(Number), tokens: 4 * PICTURE_TOKENS });
    expect(out.pictures!.count).toBeGreaterThanOrEqual(3);

    // The runner was asked for pictures with the run's typed values to cover (4 characters or longer).
    const looks = fr.requests.filter((q) => q.method === 'look');
    expect(looks.length).toBe(out.pictures!.count);
    const masks = looks.at(-1)!.params.mask as string[];
    expect(masks).toEqual(expect.arrayContaining([VARS.username, VARS.in_DateFrom, VARS.in_DateTo]));
    expect(masks.every((t) => t.length >= 4)).toBe(true);
    // The same values the text view masks: the secret variable and the runner's own token too, but never the
    // step-signing key (the runner never gets it).
    expect(masks).toEqual(expect.arrayContaining([ERP_PASSWORD, fr.token]));
    expect(looks.some((q) => (q.params.mask as string[]).includes(KEY))).toBe(false);
    expect(looks.every((q) => Number.isInteger(q.params.labelStart))).toBe(true);
    // Never in the proposal or the outputs.
    expect(JSON.stringify(out.proposal)).not.toContain(FAKE_PNG);
    expect(JSON.stringify(out.log)).not.toContain(FAKE_PNG);
  });

  it('labels match the refs: labelStart is the first ref number of the view it comes with', async () => {
    const { runner: fr, model } = await run();
    const look = fr.requests.find((q) => q.method === 'look')!;
    const firstRef = /\[e(\d+)\]/.exec(modelMessageText(model.invocations[0]!.find((m) => m.role === 'user')!))![1];
    expect(look.params.labelStart).toBe(Number(firstRef));
  });

  it('pictures off: no look, no picture, the prompt does not mention them', async () => {
    const { r, model, runner: fr } = await run({ repair: { pictures: false } });
    repaired(r);
    expect(fr.requests.filter((q) => q.method === 'look')).toEqual([]);
    for (const sent of model.invocations) expect(imageParts(sent)).toEqual([]);
    expect(modelMessageText(model.invocations[0]![0]!)).not.toContain('screenshot');
    expect(JSON.stringify(model.invocations)).not.toContain('Screenshot:');
  });

  it('a runner without look: text views with a note, asked once', async () => {
    const { r, model, runner: fr } = await run({ runner: { noLookMethod: true } });
    const out = repaired(r);
    expect(fr.requests.filter((q) => q.method === 'look')).toHaveLength(1);
    for (const sent of model.invocations) expect(imageParts(sent)).toEqual([]);
    expect(modelMessageText(model.invocations[0]!.find((m) => m.role === 'user')!)).toContain(`Screenshot: none this time (${RUNNER_TOO_OLD_FOR_PICTURES})`);
    expect(out.pictures).toBeUndefined();
  });

  it('a runner that could not make a picture safely: that view goes as text, with the reason', async () => {
    const { r, model } = await run({ runner: { lookRefusal: 'the position of a control that must be covered cannot be read' } });
    repaired(r);
    for (const sent of model.invocations) expect(imageParts(sent)).toEqual([]);
    expect(modelMessageText(model.invocations[0]!.find((m) => m.role === 'user')!))
      .toContain('Screenshot: none this time (the position of a control that must be covered cannot be read); use the text view.');
  });

  it('more masked values than the runner can look for: no look at all, the views go as text with the reason', async () => {
    const vars = { ...VARS, ...Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`extra${i}`, `secret-value-${i}`])) };
    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2' });
    const model = fakeModel(V2_TURNS);
    const r = await runDesktopTask({
      ...signed(), runner: runner.endpoint, vars, secretVars: ['password', ...Object.keys(vars).filter((k) => k.startsWith('extra'))],
      defaultStepTimeoutMs: 400, budgetMs: 120_000,
      repair: { model, goal: 'Export the line items of a company as a CSV file', pictures: true },
    });
    repaired(r);
    expect(runner.requests.filter((q) => q.method === 'look')).toEqual([]);
    for (const sent of model.invocations) expect(imageParts(sent)).toEqual([]);
    expect(modelMessageText(model.invocations[0]!.find((m) => m.role === 'user')!)).toContain(`Screenshot: none this time (${PICTURE_MASK_TOO_MANY})`);
  });

  it('a chat model that does not take pictures: the call goes again without, and the repair goes on with text only', async () => {
    const inner = fakeModel(V2_TURNS);
    const refused: ModelMessage[][] = [];
    const picky: ChatModel = {
      bindTools(defs) {
        const bound = inner.bindTools(defs);
        return {
          async invoke(messages, options) {
            if (imageParts(messages).length) {
              refused.push(messages);
              throw new Error('400 image content is not supported by this model');
            }
            return bound.invoke(messages, options);
          },
        };
      },
    };
    const { r, runner: fr } = await run({ model: picky });
    const out = repaired(r);
    expect(refused).toHaveLength(1);
    // 4 answered calls and the refused one (attempts count).
    expect(out.llmCalls).toBe(5);
    expect(out.pictureNote).toBe(PICTURES_REFUSED_NOTE);
    expect(out.note).toContain(PICTURES_REFUSED_NOTE);
    for (const sent of inner.invocations) expect(imageParts(sent)).toEqual([]);
    // After the refusal the runner is asked for no more pictures.
    expect(fr.requests.filter((q) => q.method === 'look')).toHaveLength(1);
  });

  it('a model call that fails for another reason is not retried without pictures and fails the repair as before', async () => {
    const inner = fakeModel(V2_TURNS);
    const down: ChatModel = { bindTools(defs) { inner.bindTools(defs); return { async invoke() { throw new Error('connect ECONNRESET'); } }; } };
    const { r } = await run({ model: down });
    if (r.ok) throw new Error('expected a failure');
    expect(r.llmCalls).toBe(1);
    expect(r.pictureNote).toBeUndefined();
    expect(r.message).toContain('model unavailable: connect ECONNRESET');
  });

  it('a 4xx without pictures fails too: the first error is reported, and no note says pictures were the cause', async () => {
    const inner = fakeModel(V2_TURNS);
    const bad: ChatModel = {
      bindTools(defs) {
        inner.bindTools(defs);
        let n = 0;
        return { async invoke() { n++; throw Object.assign(new Error(n === 1 ? 'first: 400 bad request' : 'second: 400 again'), { status: 400 }); } };
      },
    };
    const { r } = await run({ model: bad });
    if (r.ok) throw new Error('expected a failure');
    expect(r.llmCalls).toBe(2);
    expect(r.pictureNote).toBeUndefined();
    expect(r.message).toContain('first: 400 bad request');
    expect(r.message).not.toContain('second');
  });

  it('a view without a picture stops the last picture from going to the model', async () => {
    let fr!: FakeRunner;
    const turns = [...V2_TURNS];
    const first = turns[0]!;
    turns[0] = (t, m) => { fr.lookRefusal = 'the position of a control that must be covered cannot be read'; return first(t, m); };
    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2' });
    fr = runner;
    const model = fakeModel(turns);
    const r = await runDesktopTask({
      ...signed(), runner: runner.endpoint, vars: VARS, secretVars: ['password'], defaultStepTimeoutMs: 400, budgetMs: 120_000,
      repair: { model, goal: 'Export the line items of a company as a CSV file', pictures: true },
    });
    repaired(r);
    expect(imageParts(model.invocations[0]!)).toHaveLength(1);
    for (const sent of model.invocations.slice(1)) expect(imageParts(sent)).toEqual([]);
  });

  it('a look that fails (not a refusal) leaves the view to the snapshot, with the reason; a policy refusal stays one', async () => {
    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2' });
    runner.errorFor.look = { code: -32007, message: 'timeout: the UI kept changing while the runner read it' };
    const model = fakeModel(V2_TURNS);
    const r = await runDesktopTask({
      ...signed(), runner: runner.endpoint, vars: VARS, secretVars: ['password'], defaultStepTimeoutMs: 400, budgetMs: 120_000,
      repair: { model, goal: 'Export the line items of a company as a CSV file', pictures: true },
    });
    repaired(r);
    expect(modelMessageText(model.invocations[0]!.find((m) => m.role === 'user')!)).toContain('Screenshot: none this time (the runner could not make a screenshot: timeout: the UI kept changing');
    for (const sent of model.invocations) expect(imageParts(sent)).toEqual([]);
  });

  it('the film folder gets every picture sent and every move, only when an engine script sets it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rpa-film-'));
    const { r } = await run({ repair: { debugFilmDir: dir } });
    repaired(r);
    const files = readdirSync(dir).sort();
    expect(files.filter((f) => f.endsWith('.png')).length).toBeGreaterThanOrEqual(3);
    expect(readFileSync(join(dir, 'picture-01.png')).toString('base64')).toBe(FAKE_PNG);
    const moves = readFileSync(join(dir, 'moves.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { turn: number; picture: string; move: string });
    expect(moves.map((m) => m.move.replace(/e\d+/, 'eN'))).toEqual([
      'use_target eN (Find)', 'expand eN (Reports)', 'use_target eN (Export line items...)', 'add_step eN (Continue)',
    ]);
    expect(moves[0]!.picture).toBe('picture-01.png');
    // The password never shows in the film's moves.
    expect(JSON.stringify(moves)).not.toContain(ERP_PASSWORD);
  });
});

describe('picture plumbing', () => {
  it('reads only 4xx (not 408 or 429) and errors naming images or content as a possible picture refusal', () => {
    expect(mayBePictureRefusal(Object.assign(new Error('bad request'), { status: 400 }))).toBe(true);
    expect(mayBePictureRefusal(Object.assign(new Error('x'), { response: { status: 422 } }))).toBe(true);
    expect(mayBePictureRefusal(Object.assign(new Error('slow down'), { status: 429 }))).toBe(false);
    expect(mayBePictureRefusal(Object.assign(new Error('timeout'), { status: 408 }))).toBe(false);
    expect(mayBePictureRefusal(Object.assign(new Error('overloaded'), { status: 529 }))).toBe(false);
    expect(mayBePictureRefusal(new Error('image_url content blocks are not supported'))).toBe(true);
    expect(mayBePictureRefusal(new Error('connect ECONNRESET'))).toBe(false);
  });

  it('a picture older than the latest view without one is not sent', () => {
    const img = { mime: 'image/png' as const, base64: 'AA', width: 10, height: 10 };
    const msgs = [{ role: 'user' as const, content: 'a', images: [img] }, { role: 'tool' as const, content: 't', tool_call_id: 'x' }];
    expect(latestPictureOnly(msgs, true, 0)[0]!.images).toEqual([img]);
    expect(latestPictureOnly(msgs, true, 2).every((m) => !m.images)).toBe(true);
  });

  it('asks the runner to cover every value the text view masks, except the signing key, and never a partial list', () => {
    const secrets = ['runner-token-0123456789', 'signing-key-abcdef', 'Secr3t!'];
    expect(pictureMaskTexts(secrets, ['clerk', 'abc', '2026-01-01'], ['copied text'], ['signing-key-abcdef'])).toEqual({
      texts: ['runner-token-0123456789', 'Secr3t!', 'clerk', '2026-01-01', 'copied text'],
    });
    // A typed value under 4 characters is not masked in the text view either; a secret that short is a refusal.
    expect(pictureMaskTexts(['abc'], [], [], [])).toEqual({ refused: PICTURE_MASK_TOO_SHORT });
    const many = Array.from({ length: PICTURE_MAX_MASK_TEXTS + 1 }, (_, i) => `value-${i}`);
    expect(pictureMaskTexts([], many, [], [])).toEqual({ refused: PICTURE_MASK_TOO_MANY });
    expect(pictureMaskTexts([], many.slice(1), [], [])).toEqual({ texts: many.slice(1) });
    expect(pictureMaskTexts(['x'.repeat(PICTURE_MAX_MASK_TEXT_LENGTH + 1)], [], [], [])).toEqual({ refused: PICTURE_MASK_TOO_MANY });
  });

  it('keeps only the latest picture and drops them all once pictures are off', () => {
    const img = { mime: 'image/png' as const, base64: 'AA', width: 10, height: 10 };
    const msgs = [
      { role: 'user' as const, content: 'a', images: [img] },
      { role: 'tool' as const, content: 't', tool_call_id: 'x' },
      { role: 'user' as const, content: 'b', images: [img] },
    ];
    expect(latestPictureOnly(msgs, true).map((m) => [m.content, !!m.images])).toEqual([[`a\n${PICTURE_OMITTED}`, false], ['t', false], ['b', true]]);
    expect(latestPictureOnly(msgs, false).every((m) => !m.images)).toBe(true);
  });

  it('says how much of the cost went to screenshots, and nothing more without them', () => {
    expect(costSentence(4, 27_321)).toBe('It used 4 chat model calls and 27,321 tokens.');
    expect(costSentence(4, 27_321, { count: 5, tokens: 2_560 })).toBe('It used 4 chat model calls and 27,321 tokens, about 2,560 of them for 5 screenshots.');
    expect(costSentence(1, 100, { count: 1, tokens: 640 })).toBe('It used 1 chat model call and 100 tokens, about 100 of them for 1 screenshot.');
    expect(imageTokenEstimate({ width: 1280, height: 800 })).toBe(1366);
  });
});
