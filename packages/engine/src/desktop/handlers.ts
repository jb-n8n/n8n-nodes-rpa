// Desktop step handlers: each step becomes runner calls (resolve, then act), with this run's id. The runner enforces
// its own floor (allowed apps and windows, declared write controls, gated keys); a step declared `write: true` by its
// owner is the only one that carries the write marker.

import { runBinaryTooLarge } from '../messages.js';
import { renderVars } from '../secrets/render.js';
import { FILE_CHECK_FAILED_PREFIX, checkFile } from '../steps/file-check.js';
import { MAX_TEXT_BYTES, truncateUtf8 } from '../steps/handlers/capture.js';
import { binaryName, DEFAULT_MAX_BYTES, DEFAULT_MIME, sanitizeFileName, sniffMime } from '../steps/handlers/files.js';
import { registerHandlers } from '../steps/handlers/index.js';
import { assertRunBinaryRoom, runBinaryBytes, MAX_RUN_BINARY_BYTES } from '../steps/limits.js';
import { EXPORT_DIR_TOKEN, MAX_EXPECTED_FILE_BYTES } from '../steps/parse.js';
import { poll } from '../steps/poll.js';
import type { Handler, StepContext } from '../steps/run.js';
import type { DesktopLocator, DesktopStep, DesktopStepBase, RunState } from '../types.js';
import { PolicyRefusedError, type RunnerAction, type Segment } from './protocol.js';
import { describeDesktopLocator, DesktopDriftError, runnerTarget, type DesktopSurface } from './surface.js';

type D<K extends string> = Extract<DesktopStep, Record<K, unknown>>;
const POLL_MS = 250;
/** The shortest time an action gets after its target resolved. */
const MIN_ACT_MS = 1000;

function desktopOf(ctx: StepContext): DesktopSurface {
  const s = ctx.surface;
  if (s?.kind !== 'desktop') throw new Error('a desktop step needs the desktop surface');
  return s as DesktopSurface;
}

/**
 * Wraps a handler so any error it throws is recorded against the running step (DesktopSurface.errors): runner errors
 * are recorded by the surface already, the handlers' own (a file check, a wait) here.
 */
const recorded = (h: Handler): Handler => async (ctx, step, state, timeout) => {
  try {
    return await h(ctx, step, state, timeout);
  } catch (err) {
    desktopOf(ctx).record(err);
    throw err;
  }
};

/**
 * Resolves the target (waiting up to the step timeout), then acts on it with what is left of it. Returns the
 * candidate that matched (0 = primary) and any text the action read. A declared write carries the write marker; once
 * the runner took it (or its outcome is unknown) the run says it submitted.
 */
async function actOn(
  ctx: StepContext, step: DesktopStepBase, loc: DesktopLocator | undefined, action: RunnerAction, state: RunState, timeout: number,
  extra: { value?: string; segments?: Segment[] } = {},
): Promise<{ candidate?: number; text?: string }> {
  const s = desktopOf(ctx);
  const t0 = Date.now();
  const target = loc ? runnerTarget(loc) : undefined;
  const candidate = target ? (await s.rpc('resolve', { target, timeoutMs: timeout })).candidate : undefined;
  const timeoutMs = Math.max(MIN_ACT_MS, timeout - (Date.now() - t0));
  const write = step.write === true;
  try {
    const r = await s.rpc('act', { ...(target ? { target } : {}), action, ...extra, ...(write ? { write: true } : {}), mode: 'step', timeoutMs });
    if (write) state.submitted = true;
    return { ...(candidate !== undefined ? { candidate } : {}), ...(r.text !== undefined ? { text: r.text } : {}) };
  } catch (err) {
    // A refused write never happened; any other failure of a write may have happened after the runner took it.
    if (write && !(err instanceof PolicyRefusedError)) state.submitted = true;
    throw err;
  }
}

const VAR_REF = /\{\{\s*var\.([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * A text the run types into a field, rendered ({{var.x}}). The value of every variable it uses is kept for masking
 * (DesktopSurface.typed): such values come from outside the signed steps (a password, an account number) and are masked
 * out of messages, logs and read outputs. Literal text is part of the signed steps and is not.
 */
function typedText(ctx: StepContext, template: string): string {
  const text = renderVars(template, ctx.vars, ctx.masker);
  const typed = desktopOf(ctx).typed;
  for (const m of template.matchAll(VAR_REF)) {
    const v = ctx.vars[m[1]];
    if (typeof v === 'string' && v && !typed.includes(v)) typed.push(v);
  }
  return text;
}

/**
 * The fill value as segments: split at {{$exportDir}} first (as signed), then each text part rendered on its own, so
 * a variable whose value reads "{{$exportDir}}" stays literal text. The runner fills only the marker segments.
 */
export function fillSegments(ctx: StepContext, value: string): Segment[] {
  const parts = value.split(new RegExp(EXPORT_DIR_TOKEN.source));
  const out: Segment[] = [];
  parts.forEach((part, i) => {
    if (i > 0) out.push({ exportDir: true });
    const text = typedText(ctx, part);
    if (text) out.push({ text });
  });
  return out;
}

const click: Handler = async (ctx, step, state, timeout) => {
  const s = step as unknown as D<'click'>;
  return (await actOn(ctx, s, s.click, 'click', state, timeout)).candidate;
};

const fill: Handler = async (ctx, step, state, timeout) => {
  const s = step as unknown as D<'fill'>;
  const segments = fillSegments(ctx, s.fill.value);
  return (await actOn(ctx, s, s.fill.field, 'type', state, timeout, { segments })).candidate;
};

const select: Handler = async (ctx, step, state, timeout) => {
  const s = step as unknown as D<'select'>;
  // An option is the name of an item the app lists, not typed text: rendered, not masked.
  return (await actOn(ctx, s, s.select.field, 'select', state, timeout, { value: renderVars(s.select.option, ctx.vars, ctx.masker) })).candidate;
};

const check: Handler = async (ctx, step, state, timeout) => {
  const s = step as unknown as D<'check'>;
  return (await actOn(ctx, s, s.check.field, s.check.checked === false ? 'uncheck' : 'check', state, timeout)).candidate;
};

const key: Handler = async (ctx, step, state, timeout) => {
  const s = step as unknown as D<'key'>;
  return (await actOn(ctx, s, s.key.target, 'key', state, timeout, { value: s.key.key })).candidate;
};

const waitFor: Handler = async (ctx, step, _state, timeout) => {
  const w = (step as unknown as D<'waitFor'>).waitFor;
  const s = desktopOf(ctx);
  const want = (w.state ?? 'visible') === 'visible';
  const ok = await poll(async () => (await s.isVisible(w.target as never)) === want, timeout, POLL_MS);
  if (!ok) throw new DesktopDriftError(`waited ${Math.round(timeout / 100) / 10} s for ${describeDesktopLocator(w.target)} to be ${want ? 'visible' : 'hidden'}`);
};

const read: Handler = async (ctx, step, state, timeout) => {
  const s = step as unknown as D<'read'>;
  const r = await actOn(ctx, s, s.read.target, 'read', state, timeout);
  // Masked for secrets here; the desktop task masks the outputs again for the typed variable values once the run ends.
  const { text, truncated } = truncateUtf8(ctx.masker.mask(r.text ?? ''), MAX_TEXT_BYTES);
  state.outputs.push({ index: ctx.stepIndex ?? 0, verb: 'read', as: s.read.as, text, ...(truncated ? { truncated: true } : {}) });
  return r.candidate;
};

const expectFile: Handler = async (ctx, step, state, timeout) => {
  const e = (step as unknown as D<'expectFile'>).expectFile;
  const s = desktopOf(ctx);
  // Never more than the runner's ceiling (parseDesktopScript refuses a larger maxBytes too); the runner's policy
  // maxFileBytes is the effective limit and the runner caps the request at it.
  const max = Math.min(e.maxBytes ?? DEFAULT_MAX_BYTES, MAX_EXPECTED_FILE_BYTES);
  // The runner never sends more than the step or the run may still hold. It takes maxBytes of at least 1: with no room
  // left the step fails here with the run limit instead of asking for nothing.
  const room = MAX_RUN_BINARY_BYTES - runBinaryBytes(state);
  if (room < 1) throw new Error(runBinaryTooLarge(runBinaryBytes(state) + 1));
  const r = await s.rpc('file.retrieve', { pattern: e.pattern, timeoutMs: timeout, maxBytes: Math.min(max, room) });
  const data = Buffer.from(r.base64 ?? '', 'base64');
  if (data.length > max) throw new Error(`expected file exceeds ${max} bytes`);
  assertRunBinaryRoom(state, data.length);
  const fileName = sanitizeFileName(ctx.masker.mask(String(r.name ?? '')));
  const mimeType = sniffMime(data, fileName);
  const allowed = e.mime ?? DEFAULT_MIME;
  if (!allowed.includes(mimeType)) throw new Error(`expected file type ${mimeType} is not allowed`);
  const name = binaryName(state, 'download', ctx.stepIndex ?? 0);
  if (!e.check) {
    state.downloads.push({ fileName, mimeType, data, binaryName: name });
    return;
  }
  const checked = checkFile({ fileName, mimeType, data }, e.check);
  if (!checked.ok) throw new Error(`${FILE_CHECK_FAILED_PREFIX}${ctx.masker.mask(checked.reason)}`);
  const facts = { columns: checked.facts.columns && checked.facts.columns.map((c) => ctx.masker.mask(c)), rows: checked.facts.rows };
  state.downloads.push({ fileName, mimeType, data, binaryName: name, facts });
};

registerHandlers('desktop', {
  click: recorded(click), fill: recorded(fill), select: recorded(select), check: recorded(check), key: recorded(key),
  waitFor: recorded(waitFor), read: recorded(read), expectFile: recorded(expectFile),
});
