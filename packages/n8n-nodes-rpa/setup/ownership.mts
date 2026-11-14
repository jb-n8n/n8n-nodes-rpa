// Who owns what: the API key and its owner, the project this run works in (and whether it is shared), and the
// credentials of the names this command uses, found, reused or made there.
import { Buffer } from 'node:buffer';
import { CREDENTIALS } from '../nodes/Playwright/config.js';
import { clean, type Client } from './n8n-api.mjs';
import { ask, interactive, say, Stop } from './io.mjs';
import { EMAIL } from './options.mjs';

const MAX_PROJECT_LOOKUPS = 50;

/**
 * What an n8n API key says about itself: n8n 2.x keys are JWTs whose subject is the user's id, with an expiry (exp) when
 * the key was given one (PublicApiKeyService.generateApiKey). Read without checking the signature (n8n checks it on every
 * call); nothing for a key of any other form. Its scopes are kept in n8n, not in the key.
 */
export function keyClaims(apiKey: string): { userId?: string; keyExpires?: number | null } {
  const parts = apiKey.split('.');
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const sub = payload?.sub;
    const exp = payload?.exp;
    return { userId: typeof sub === 'string' && sub ? sub : undefined, keyExpires: typeof exp === 'number' && Number.isFinite(exp) ? exp : null };
  } catch {
    return {};
  }
}

/** The API key owner's email, when n8n tells it (GET /users/{id}: the owner or an admin); undefined otherwise. */
export async function keyOwnerEmail(client: Client, userId: string | undefined): Promise<string | undefined> {
  if (!userId) return undefined;
  const r = await client.api('GET', `/users/${encodeURIComponent(userId)}`).catch(() => undefined);
  const email = r?.status === 200 ? r.json?.email : undefined;
  // Only a plain address: one with a control character (it could change what a printed line looks like) is not used.
  return typeof email === 'string' && EMAIL.test(email) && clean(email, '') === email ? email : undefined;
}

/** One line about the API key, at the end of a run: what it can do, when it expires (never the key). */
export function keyAdvice(keyExpires: number | null | undefined): string {
  const can = 'The API key you gave can do everything its owner can in n8n, within its scopes';
  // n8n's own labels (2.45): the place, then the action, so that the words still lead there when a label changes.
  const where = "when the setup is done: in n8n, Settings → n8n API, the key's ⋯ menu → Revoke";
  if (typeof keyExpires === 'number') return `${can}, until ${new Date(keyExpires * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC. Revoke it ${where}.`;
  // n8n sets a key's expiry only when the key is made: a key without one is revoked, or the next one made with one.
  if (keyExpires === null) return `${can}, and it never expires. Revoke it ${where}. Make the next one with an expiry.`;
  return `${can}. Revoke it ${where}. Make the next one with an expiry.`;
}

/** The project that owns a list item: its one shared entry with the owner role, or undefined when n8n does not say. */
export function ownerProject(item: any, kind: 'credential' | 'workflow'): string | undefined {
  if (!Array.isArray(item?.shared)) return undefined;
  const owners = item.shared.filter((s: any) => s?.role === `${kind}:owner`);
  if (owners.length !== 1) return undefined;
  const id = kind === 'credential' ? owners[0].id : owners[0].projectId;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * The API key owner's personal project: the owner project of a visible workflow whose project is personal and was made
 * for that user. Undefined when no visible workflow lives there, or the key or n8n's answers do not say.
 */
export async function personalProject(client: Client, workflows: any[], userId: string | undefined): Promise<string | undefined> {
  if (!userId) return undefined;
  const asked = new Set<string>();
  for (const w of workflows) {
    const pid = ownerProject(w, 'workflow');
    if (!pid || asked.has(pid)) continue;
    if (asked.size >= MAX_PROJECT_LOOKUPS) return undefined;
    asked.add(pid);
    const r = await client.api('GET', `/workflows/${encodeURIComponent(String(w.id))}`);
    const project = r.status === 200 && Array.isArray(r.json?.shared) ? r.json.shared.find((s: any) => s?.role === 'workflow:owner')?.project : undefined;
    if (project?.id === pid && project.type === 'personal' && project.creatorId === userId) return pid;
  }
  return undefined;
}

/** The project's owner entry on a workflow read with GET (it carries the project's type and creator). */
export const ownerEntryProject = (json: any) => (Array.isArray(json?.shared) ? json.shared.find((s: any) => s?.role === 'workflow:owner')?.project : undefined);

/**
 * Whether this run's project is shared, and what to call it. Only the API key owner's own personal project is not
 * shared; a team project, someone else's personal project, or a project whose type n8n does not tell, is.
 */
export const shared = { is: false, label: '', reuse: false, announced: false, basic: false };
export function setProject(project: any, id: string, userId: string | undefined, callersOwn = false) {
  // callersOwn: the project n8n put a workflow in that this key made without a projectId, which is the key owner's own.
  const mine = callersOwn || (userId !== undefined && project?.creatorId === userId);
  shared.is = !(project?.id === id && project.type === 'personal' && mine);
  const name = clean(project?.name, '');
  shared.label = name ? `"${name}" (id ${clean(id)})` : `id ${clean(id)}`;
  if (shared.is && !shared.announced) {
    shared.announced = true;
    say(shared.basic
      ? `The project ${shared.label} is shared: everyone in it can use the form's login and the signing key this command sets up there. A personal project keeps them to one person.`
      : `The project ${shared.label} is shared: everyone in it who may run its workflows can open the form, and use the signing key this command sets up there. A personal project keeps them to one person.`);
  }
}

/** The project's details, from a workflow it owns; undefined when it owns none this key can see. */
export async function projectOf(client: Client, workflows: any[], id: string) {
  const w = workflows.find((x) => ownerProject(x, 'workflow') === id);
  if (!w) return undefined;
  const r = await client.api('GET', `/workflows/${encodeURIComponent(String(w.id))}`);
  return r.status === 200 ? ownerEntryProject(r.json) : undefined;
}

/**
 * In a shared project, what was found there is used only as one set, and only when the person says so at a terminal or
 * the flag does: listed by name and id, one question. Anywhere else (the key owner's personal project) it is used.
 */
export async function useFound(found: { kind: string; name: string; id: string }[]): Promise<boolean> {
  if (!shared.is || !found.length) return true;
  say(`Found in the shared project ${shared.label}:`);
  for (const f of found) say(`  ${f.kind} "${clean(f.name, f.id)}" (id ${clean(f.id)})`);
  if (shared.reuse) return true;
  if (!interactive()) {
    say('Not used: without a terminal they are used only with --reuse-project-credentials.');
    return false;
  }
  return /^y(es)?$/i.test(await ask('Use these? Anyone in that project could have made them. [y/N] '));
}

export interface Ref { id: string; name: string }

/**
 * The credentials of this name: the one this run's project owns (mine), and those it leaves alone (others: another
 * project or user, or an owner n8n does not tell), each said in one line. Stops on a same-name credential of another
 * type in the project, or on two of the same name and type there (it could not tell which one is meant).
 */
export function sameName(items: any[], spec: { name: string; type: string }, home: string | undefined) {
  const same = items.filter((c) => c?.name === spec.name);
  const ours = home ? same.filter((c) => ownerProject(c, 'credential') === home) : [];
  const conflict = ours.find((c) => c.type !== spec.type);
  if (conflict) throw new Stop(`A credential named "${spec.name}" (id ${clean(conflict.id)}) has the type ${clean(conflict.type)}, not ${spec.type}. Rename it in n8n, then run this again.`);
  if (ours.length > 1) throw new Stop(`Your project has ${ours.length} credentials named "${spec.name}" (ids ${ours.map((c) => clean(c.id)).join(', ')}), and this command cannot tell which one is meant. Rename or delete all but one in n8n, then run this again.`);
  const others = same.filter((c) => !ours.includes(c));
  for (const o of others) leftAlone('credential', o, clean(o.type), home);
  return { mine: ours[0] as any, others };
}

/**
 * Why --site-login found nothing to pick, with the RPA Site Logins this run's project has, by name and id (cleaned).
 * Those of other projects or users were each named in a line of their own already.
 */
export function noSiteLogin(name: string, items: any[], home: string | undefined): string {
  const ours = items.filter((c) => c?.type === CREDENTIALS.siteLogin && home !== undefined && ownerProject(c, 'credential') === home);
  const listed = ours.length ? `Your project's RPA Site Logins: ${ours.map((c) => `"${clean(c.name, c.id)}" (id ${clean(c.id)})`).join(', ')}.` : 'Your project has no RPA Site Login.';
  return `No RPA Site Login named "${clean(name)}" in your project. ${listed} Create it in n8n (+ → New credential → RPA Site Login), or give its name as n8n shows it. Nothing was changed.`;
}

/** This run's project's credentials of a type (the owner n8n names is that project), by id and name only. */
export const projectCredentials = (items: any[], type: string, home: string | undefined) => (home === undefined ? [] : items.filter((c) => c?.type === type && ownerProject(c, 'credential') === home));
export const byNameAndId = (items: any[]) => items.map((c) => `"${clean(c.name, c.id)}" (id ${clean(c.id)})`).join(', ');

/** Why --desktop-runner found nothing to pick, with the RPA Desktop Runners this run's project has, by name and id. */
export function noDesktopRunner(name: string, items: any[], home: string | undefined): string {
  const ours = projectCredentials(items, CREDENTIALS.desktopRunner, home);
  const listed = ours.length ? `Your project's RPA Desktop Runners: ${byNameAndId(ours)}.` : 'Your project has no RPA Desktop Runner.';
  return `No RPA Desktop Runner named "${clean(name)}" in your project. ${listed} Give its name as n8n shows it, or leave --desktop-runner out and give the Windows machine's Connection Line instead. Nothing was changed.`;
}

/** One line for something of the same name that this run leaves alone. */
export function leftAlone(kind: string, item: any, typeOrNothing: string, home: string | undefined) {
  const owner = ownerProject(item, kind === 'credential' ? 'credential' : 'workflow');
  const why = !home ? 'this run could not tell which project is yours'
    : owner === home ? 'the API key does not say whose it is, so this run could not tell it was yours before it made a new one'
      : owner ? 'it belongs to another project or user' : 'n8n does not say whose it is';
  const id = clean(item.id);
  say(`left alone ${kind} "${clean(item.name, id)}"${typeOrNothing ? ` (${typeOrNothing}, id ${id})` : ` (id ${id})`}: ${why}, so it is not used`);
}

/** The credential this run uses: the one found (mine, when the run uses what it found), else one made in the project. */
export async function credential(client: Client, found: { mine?: any; others: any[] }, projectId: string | undefined, spec: { name: string; type: string }, data: () => Record<string, unknown>, keptNote: string) {
  const { mine, others } = found;
  if (mine) {
    say(`reused   credential "${spec.name}" (id ${clean(mine.id)}): ${keptNote}`);
    return { ref: { id: String(mine.id), name: spec.name }, created: false };
  }
  const r = await client.api('POST', '/credentials', { name: spec.name, type: spec.type, data: data(), ...(projectId ? { projectId } : {}) });
  if ((r.status !== 200 && r.status !== 201) || !r.json?.id) throw new Stop(`Could not create the credential "${spec.name}" (${client.reason(r)}).`);
  const id = clean(r.json.id);
  say(`created  credential "${spec.name}" (id ${id})`);
  if (others.length) say(`         n8n now has more than one credential named "${spec.name}": this run's is id ${id}. Do not pick ids ${others.map((o) => clean(o.id)).join(', ')}.`);
  return { ref: { id: String(r.json.id), name: spec.name }, created: true };
}

/** Replaces the data of a credential made earlier (n8n keeps its id, so every node that uses it keeps it). */
export async function replaceData(client: Client, ref: Ref, type: string, data: Record<string, unknown>) {
  const r = await client.api('PATCH', `/credentials/${encodeURIComponent(ref.id)}`, { name: ref.name, type, data });
  if (r.status !== 200) throw new Stop(`Could not change the credential "${ref.name}" (${client.reason(r)}). Nothing else was changed.`);
}
