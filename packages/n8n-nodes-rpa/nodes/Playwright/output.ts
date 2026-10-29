import type { IBinaryKeyData, IDataObject, INodeExecutionData, IPairedItemData } from 'n8n-workflow';
import type { DesktopProposal, DownloadedFile, ErrorCode, Proposal, RequestRecord, TaskResult } from 'n8n-rpa-engine';
import type { NodeContext } from './context.js';
import type { Compiled, LaneSuccess } from './operations/quick/shared.js';
import type { Engine } from './engine.js';
import { errorJson, type FailureDetails } from './errors.js';
import { changeList, evidenceLine, fullSafetyFlags, safetyLine } from './format.js';

/** A file-name-safe form of a name (lowercase, dashes), 'rpa' when nothing is left. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rpa';

/** The failure screenshot and trace of a failed run as binary `screenshot` / `trace`, or undefined when there are none. */
async function failureBinary(ctx: NodeContext, r: { screenshot?: Buffer; trace?: Buffer }, label: string): Promise<IBinaryKeyData | undefined> {
  const binary: IBinaryKeyData = {};
  if (r.screenshot) binary.screenshot = await ctx.helpers.prepareBinaryData(r.screenshot, `${slug(label)}-failure.png`, 'image/png');
  if (r.trace) binary.trace = await ctx.helpers.prepareBinaryData(r.trace, `${slug(label)}-trace.zip`, 'application/zip');
  return Object.keys(binary).length ? binary : undefined;
}

type RunOk = Extract<TaskResult, { ok: true }>;
type RunFailure = Extract<TaskResult, { ok: false }>;
/** A JSON copy: log entries and step documents are plain data; n8n items must not share objects with the engine result. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Facts a success may carry: the script lane always has them; the agent lane reports the files, blocked writes and the
 * base steps' name, version and hash once the engine sets them. Read from the result when present, never invented.
 */
interface RunFacts {
  name?: string | null;
  version?: number | null;
  hash?: string | null;
  files?: DownloadedFile[];
  blockedRequests?: RequestRecord[];
  verified?: boolean;
  /** Both lanes always carry it (it also keeps this interface from being a weak type). */
  submitted: boolean;
}

/** Run Steps Data item: page facts, identity, lane, the step log, and rows/files/blocked writes when present. */
export async function dataItem(
  ctx: NodeContext, r: RunOk, extra: { name: string | null; version: number | null; hash: string | null },
): Promise<INodeExecutionData> {
  const f: RunFacts = r;
  const binary: IBinaryKeyData = {};
  for (const o of r.outputs) {
    if (o.binary) binary[o.binary.name] = await ctx.helpers.prepareBinaryData(o.binary.data, o.binary.fileName, o.binary.mimeType);
  }
  const files: IDataObject[] = [];
  for (const file of f.files ?? []) {
    binary[file.binaryName] = await ctx.helpers.prepareBinaryData(file.data, file.fileName, file.mimeType);
    files.push({ fileName: file.fileName, mimeType: file.mimeType, bytes: file.data.length, binaryProperty: file.binaryName });
  }
  const name = f.name ?? extra.name;
  // Desktop read steps name their text (`as`); browser outputs never carry a name, so their items are unchanged.
  const values: IDataObject = Object.fromEntries(r.outputs.flatMap((o) => (o.as !== undefined ? [[o.as, o.text ?? '']] : [])));
  if (r.trace) binary.trace = await ctx.helpers.prepareBinaryData(r.trace, `${slug(name ?? '')}-trace.zip`, 'application/zip');
  const blocked = f.blockedRequests ?? [];
  const json: IDataObject = {
    url: r.page.url,
    title: r.page.title,
    status: r.page.status,
    name,
    version: f.version ?? extra.version,
    hash: f.hash ?? extra.hash,
    lane: r.lane,
    confirmed: r.confirmed,
    llmCalls: r.lane === 'agent' ? r.llmCalls : 0,
    // The run log columns (template 2): wall time of the whole run, and chat model tokens (script lane: none).
    durationMs: r.durationMs,
    llmTokens: r.lane === 'agent' ? r.tokens : 0,
    log: plain(r.log) as unknown as IDataObject[],
    // Rows only when row checks ran: an extract step on the script lane, always for agent-lane rows (the proof ran).
    ...(r.lane === 'agent' || f.verified ? { rows: r.rows.map((row) => ({ ...row })) } : {}),
    ...(Object.keys(values).length ? { values } : {}),
    ...(files.length ? { files } : {}),
    ...(blocked.length ? { blockedRequests: blocked.map((b) => ({ ...b })) } : {}),
    ...(f.submitted ? { submitted: true } : {}),
  };
  return { json, ...(Object.keys(binary).length ? { binary } : {}) };
}

/**
 * Repaired steps item with the before/after screenshots as binaries, and the proof run's trace (`trace`): the new
 * steps replayed alone, for the reviewer to step through in a Trace Viewer. `attachmentNames` names only the screenshots.
 * Never uses the word "proposal".
 */
export async function repairedStepsItem(ctx: NodeContext, engine: Engine, p: Proposal): Promise<INodeExecutionData> {
  const binary: IBinaryKeyData = {};
  const names: string[] = [];
  for (const [which, version] of [['before', p.baseVersion ?? 0], ['after', p.version]] as const) {
    const png = p.screenshots[which];
    if (!png) continue;
    binary[which] = await ctx.helpers.prepareBinaryData(png, `${which}-v${version}.png`, 'image/png');
    names.push(which);
  }
  if (p.trace) binary.trace = await ctx.helpers.prepareBinaryData(p.trace, `${slug(p.name)}-v${p.version}-proof-trace.zip`, 'application/zip');
  return { json: repairedStepsJson(engine, p, names.join(',')), ...(Object.keys(binary).length ? { binary } : {}) };
}

/**
 * The JSON of a Repaired steps item. The safety flags are the full list (fullSafetyFlags: every host, submission and
 * download, not only the new ones the engine flags), and the digest is computed over that list. Sign Steps recomputes
 * the same list and refuses an item that carries another one.
 */
export function repairedStepsJson(engine: Engine, proposal: Proposal, attachmentNames = ''): IDataObject {
  const safetyFlags = fullSafetyFlags(engine, engine.parseScript(proposal.steps), {
    unverifiedCount: proposal.safetyFlags.includes(engine.UNVERIFIED_COUNT_FLAG), fieldsDropped: proposal.safetyFlags.includes(engine.EXTRACT_FIELDS_DROPPED),
  });
  const p: Proposal = { ...proposal, safetyFlags };
  return {
    name: p.name,
    baseVersion: p.baseVersion,
    version: p.version,
    steps: plain(p.steps) as unknown as IDataObject,
    hash: p.hash,
    digest: engine.proposalDigest(p),
    evidence: { count: p.evidence.count, total: p.evidence.total, diff: { missing: [...p.evidence.diff.missing], extra: [...p.evidence.diff.extra] },
      ...(p.evidence.readPosts?.length ? { readPosts: [...p.evidence.readPosts] } : {}),
      ...(p.evidence.file ? { file: { ...p.evidence.file, columns: p.evidence.file.columns ? [...p.evidence.file.columns] : null } } : {}),
    },
    changes: p.changes.map((c) => ({ was: c.was, now: c.now })),
    safetyFlags: [...safetyFlags],
    evidenceLine: evidenceLine(p, engine),
    changeList: changeList(p),
    safetyLine: safetyLine(p),
    attachmentNames,
  };
}

/**
 * The JSON of a Repaired steps item for desktop steps from an import (engine desktopProposal): the same fields as a
 * browser item, so the approval template and Sign Steps take it unchanged. Nothing was replayed: the evidence is empty,
 * the evidence line says so, and there are no screenshots. The safety flags are the engine's full list
 * (desktopSafetyFlags), which Sign Steps recomputes; the digest covers them.
 */
export function desktopRepairedStepsJson(engine: Engine, proposal: DesktopProposal): IDataObject {
  const safetyFlags = engine.desktopSafetyFlags(engine.parseDesktopScript(proposal.steps));
  const p: DesktopProposal = { ...proposal, safetyFlags };
  return {
    name: p.name,
    baseVersion: p.baseVersion,
    version: p.version,
    steps: plain(p.steps) as unknown as IDataObject,
    hash: p.hash,
    digest: engine.proposalDigest(p),
    evidence: { count: p.evidence.count, total: p.evidence.total, diff: { missing: [...p.evidence.diff.missing], extra: [...p.evidence.diff.extra] } },
    changes: p.changes.map((c) => ({ was: c.was, now: c.now })),
    safetyFlags: [...safetyFlags],
    evidenceLine: evidenceLine(p, engine),
    changeList: changeList(p),
    safetyLine: safetyLine(p),
    attachmentNames: '',
  };
}

/** Error item for a failed or blocked run: `{ error: "<code>: <message>", message, details }` plus screenshot and trace binaries. */
export async function failureItem(
  ctx: NodeContext, f: RunFailure | { code: ErrorCode; message: string },
  details: { name: string | null; version: number | null; hash: string }, paired: IPairedItemData[],
): Promise<INodeExecutionData> {
  const full = 'ok' in f ? f : undefined;
  const binary = full ? await failureBinary(ctx, full, details.name ?? '') : undefined;
  const d: FailureDetails = {
    code: f.code,
    message: f.message,
    name: details.name,
    version: full?.version ?? details.version,
    hash: full?.hash ?? details.hash,
    lane: full?.lane ?? null,
    stepIntent: full?.failure?.intent ?? null,
    traceRef: binary?.trace ? 'trace' : null,
    durationMs: full?.durationMs ?? 0,
    llmTokens: full?.tokens ?? 0,
    log: full ? (plain(full.log) as unknown as IDataObject[]) : [],
    submitted: full?.submitted === true,
  };
  return { json: errorJson(`${f.code}: ${f.message}`, f.message, d), pairedItem: paired, ...(binary ? { binary } : {}) };
}

/** Error item for a configuration problem: the message as is, `configError: true`, no code. */
export function configErrorItem(message: string, name: string | null, paired: IPairedItemData[]): INodeExecutionData {
  return {
    json: errorJson(message, message, { configError: true, code: null, name, version: null, hash: '', lane: null, log: [], submitted: false }),
    pairedItem: paired,
  };
}

/**
 * The Data item of a quick operation: `{ url, title, status, ...fields, steps, blockedRequests? }`.
 * `steps` is a JSON copy of the compiled step document (`{ steps }`), ready to paste into Run Steps. It has no
 * startUrl: the start page comes from the first goto, so Run Steps does not load it twice.
 * `blockedRequests` is present only when a write was blocked and logged.
 */
export function quickEnvelope(r: LaneSuccess, compiled: Compiled, fields: IDataObject = {}): IDataObject {
  return {
    url: r.page.url,
    title: r.page.title,
    status: r.page.status,
    ...fields,
    steps: plain(compiled.script) as unknown as IDataObject,
    ...(r.blockedRequests.length ? { blockedRequests: r.blockedRequests.map((b) => ({ method: b.method, host: b.host, path: b.path })) } : {}),
  };
}

const CAPTURE_EXTENSIONS: Record<string, string> = { 'image/png': '.png', 'application/pdf': '.pdf' };

/**
 * The run's screenshot or PDF as a binary under `property` (Options → Put Output in Field). The file is named after the
 * binary field plus the capture's extension (`screenshot.png`, `pdf.pdf`, `pageShot.png`), never after the step index.
 * Missing output throws: executeQuickOp turns that into an `incomplete` error item, never a silent success.
 */
export async function stepBinary(ctx: NodeContext, r: LaneSuccess, verb: 'screenshot' | 'pdf', property: string): Promise<IBinaryKeyData> {
  const out = r.outputs.find((o) => o.verb === verb && o.binary !== undefined);
  if (!out?.binary) throw new Error(`the run finished without a ${verb} output`);
  const ext = /\.[a-z0-9]+$/i.exec(out.binary.fileName)?.[0] ?? CAPTURE_EXTENSIONS[out.binary.mimeType] ?? '';
  return { [property]: await ctx.helpers.prepareBinaryData(out.binary.data, `${property}${ext}`, out.binary.mimeType) };
}

export type ExtractOutputMode = 'rowPerItem' | 'allInOne';

/**
 * Extract Data success items. One Item per Row: the row's fields plus
 * `_meta: { url, title, status, rowCount, confirmed, row }` (1-based `row`); the first row's `_meta` also carries `steps`
 * and `blockedRequests` (when any). A zero-row success is one item with `rowCount: 0` and `row: null`. All Rows in One
 * Item: the envelope plus `rows`, `rowCount`, `confirmed`. No pairedItem: executeQuickOp sets it on every item.
 * `confirmed` needs a Stated Total Pattern. The engine checks a stated total only when one is set, so the
 * guard below changes nothing for a real run; it keeps that rule in the node's own contract.
 * A row key `_meta` (a table column headed "_meta") is renamed in place to the next free `_meta_<n>` (n ≥ 2).
 */
export function extractItems(r: LaneSuccess, compiled: Compiled, mode: ExtractOutputMode): INodeExecutionData[] {
  const rowCount = r.rows.length;
  const confirmed = r.confirmed && compiled.output?.totalPattern !== undefined;
  if (mode === 'allInOne') return [{ json: quickEnvelope(r, compiled, { rows: r.rows.map((row) => ({ ...row })), rowCount, confirmed }) }];
  const envelope = quickEnvelope(r, compiled);
  const meta = (row: number | null, first: boolean): IDataObject => ({
    url: envelope.url, title: envelope.title, status: envelope.status, rowCount, confirmed, row,
    ...(first ? { steps: envelope.steps, ...(envelope.blockedRequests !== undefined ? { blockedRequests: envelope.blockedRequests } : {}) } : {}),
  });
  if (rowCount === 0) return [{ json: { _meta: meta(null, true) } }];
  return r.rows.map((row, k) => ({ json: { ...freeMetaKey(row), _meta: meta(k + 1, k === 0) } }));
}

/** A copy of the row with its `_meta` key (if any) renamed in place to the first `_meta_<n>` (n ≥ 2) the row lacks. */
function freeMetaKey(row: Record<string, string>): IDataObject {
  if (!Object.hasOwn(row, '_meta')) return { ...row };
  let n = 2;
  while (Object.hasOwn(row, `_meta_${n}`)) n++;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key === '_meta' ? `_meta_${n}` : key, value]));
}
