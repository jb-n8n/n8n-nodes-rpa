import type { DesktopProposal, DownloadTemplate, PortalPolicy, Proposal, Script, Step } from 'n8n-rpa-engine';
import type { Engine } from './engine.js';

/**
 * Every host, form submission, download and pop-up handler (interrupt) the steps have, then
 * the two flags only the run knows: extract-fields-dropped (needs the base steps) and count unverified (the page states no total).
 *
 * The engine flags only what is new compared with the base steps ("new host: …"). Sign Steps has no base, so both
 * Run Steps and Sign Steps list everything, from the steps alone: validateScript against an empty baseline (proposal
 * mode, no previous steps), with the "new " prefix dropped. The policy only satisfies the call; flags do not depend on
 * it. `script` is the parsed steps (engine parseScript).
 */
export function fullSafetyFlags(
  engine: Pick<Engine, 'validateScript' | 'UNVERIFIED_COUNT_FLAG' | 'EXTRACT_FIELDS_DROPPED'>,
  script: Script,
  known: { unverifiedCount: boolean; fieldsDropped: boolean },
): string[] {
  const policy: PortalPolicy = { startUrl: script.startUrl, navHosts: [], subresourceHosts: [], login: [], allowedSubmits: [] };
  const flags = engine.validateScript(script, { policy, mode: 'proposal' }).safetyFlags.map((f) => f.replace(/^new /, ''));
  if (known.fieldsDropped) flags.push(engine.EXTRACT_FIELDS_DROPPED);
  if (known.unverifiedCount) flags.push(engine.UNVERIFIED_COUNT_FLAG);
  return flags;
}

/** The single top-level download step's template, as the engine reads it (downloadTemplateOf), or undefined when there is not exactly one. */
function downloadTemplate(steps: Step[]): DownloadTemplate | undefined {
  const found = steps.filter((s): s is Extract<Step, { download: unknown }> => 'download' in s);
  if (found.length !== 1) return undefined;
  const { mime, maxBytes, check } = found[0].download;
  return { ...(mime ? { mime } : {}), ...(maxBytes !== undefined ? { maxBytes } : {}), check: check ?? {} };
}

/** True when the steps have a download step anywhere (paginate bodies included). */
export function hasDownloadStep(steps: Step[]): boolean {
  return steps.some((s) => 'download' in s || ('paginate' in s && hasDownloadStep(s.paginate.each)));
}

function hasExtractStep(steps: Step[]): boolean {
  return steps.some((s) => 'extract' in s || ('paginate' in s && hasExtractStep(s.paginate.each)));
}

/** The engine's file-document shape: exactly one top-level download, none inside paginate, and no extract step. */
export function isFileDocument(steps: Step[]): boolean {
  const top = steps.filter((s) => 'download' in s).length;
  const all = (list: Step[]): number => list.reduce((n, s) => n + ('download' in s ? 1 : 0) + ('paginate' in s ? all(s.paginate.each) : 0), 0);
  return top === 1 && all(steps) === 1 && !hasExtractStep(steps);
}

/** One line: control, format and line-separator characters become JSON escapes (same as the engine's oneLine; the engine loads lazily). */
const oneLine = (s: string): string =>
  s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (c) => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' })[c] ?? Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''));


/**
 * One line of evidence for the approver. For a file proposal it describes the PROVEN file (the evidence's), and the
 * checks come from the download step of the steps, never from the evidence.
 */
export function evidenceLine(p: Proposal | DesktopProposal, engine: Pick<Engine, 'describeCheck'>): string {
  if (isDesktopProposal(p)) return DESKTOP_EVIDENCE_LINE;
  const { count, total, diff, file: f } = p.evidence;
  const reads = p.evidence.readPosts?.length ? `; read-only requests the Site Login allowed: ${p.evidence.readPosts.join(', ')}` : '';
  if (f) {
    const checks = engine.describeCheck(downloadTemplate(p.steps.steps) ?? { check: {} });
    return oneLine(`Proven in a fresh browser: downloaded ${JSON.stringify(f.fileName)} (${f.mimeType}, ${f.bytes} bytes${f.rows !== null ? `, ${f.rows} rows` : ''}); checks: ${checks}${reads}`);
  }
  const head = total === null ? `Proven in a fresh browser: ${count} rows (the page states no total)` : `Proven in a fresh browser: ${count} of ${total} rows`;
  const delta = diff.missing.length || diff.extra.length ? `; compared with the repair run: ${diff.missing.length} missing, ${diff.extra.length} extra` : '';
  return oneLine(`${head}${delta}${reads}`);
}

/** The evidence line of desktop steps from an import: nothing was replayed, so the approver reviews the steps as written. */
export const DESKTOP_EVIDENCE_LINE =
  'Not replayed: desktop steps imported from UiPath are reviewed as written (there is no desktop proof yet). Check every step, and list in Write Steps the steps that save, post or submit.';

/** A proposal whose steps are a desktop step set (`surface: "desktop"`, own property, as the engine routes). */
export function isDesktopProposal(p: Proposal | DesktopProposal): p is DesktopProposal {
  const steps = p.steps as unknown;
  return typeof steps === 'object' && steps !== null && Object.hasOwn(steps, 'surface') && (steps as { surface?: unknown }).surface === 'desktop';
}

/**
 * Plain-English step changes, one per line. Desktop steps are a first version whose change list is every step in order,
 * so each line carries its step number (`Step 16: Click Save (…)`): the number the approver lists in Write Steps. The
 * numbers are added here, recomputed from the reviewed fields (the digest covers the changes, not this text).
 */
export function changeList(p: Proposal | DesktopProposal): string {
  if (p.changes.length === 0) return 'No step changes';
  if (isDesktopProposal(p)) return p.changes.map((c, i) => `Step ${i + 1}: ${c.now === null ? `Removed: ${oneLine(c.was ?? '')}` : oneLine(c.now)}`).join('\n');
  return p.changes
    .map((c) => {
      const was = c.was === null ? null : oneLine(c.was);
      const now = c.now === null ? null : oneLine(c.now);
      return was !== null && now !== null ? `Changed: ${was} -> ${now}` : now !== null ? `Added: ${now}` : `Removed: ${was ?? ''}`;
    })
    .join('\n');
}

export function safetyLine(p: Pick<Proposal, 'safetyFlags'>): string {
  return p.safetyFlags.length ? p.safetyFlags.map(oneLine).join('; ') : 'none';
}
