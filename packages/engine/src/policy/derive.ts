import type { PortalPolicy, Script } from '../types.js';
import { declaredTarget, submitKey, submitLabel, type AllowedSubmit } from './submits.js';
import { flattenSteps } from './validate.js';

/**
 * The policy for agent and prove sessions: no allowed submissions, no frame-host writes, no Fill and Submit window, no
 * submits taken from steps, fatal writes, and no main-frame navigation to a destructive-sounding path or query (a GET
 * can change something too). Declared login POSTs still pass, from the page or a login frame; frame hosts still load.
 */
export function noWritePolicy(p: PortalPolicy): PortalPolicy {
  const { writeWindow: _dropped, ...rest } = p;
  return { ...rest, allowedSubmits: [], writeMode: 'fatal', frameHostWrites: false, submitsFromSteps: false, refuseDestructiveNavigation: true };
}

/** 'block' only when asked for and the steps are unsigned and run without a Site Login; otherwise 'fatal'. */
export function effectiveWriteMode(p: PortalPolicy, ctx: { signed: boolean; hasSecrets: boolean }): 'fatal' | 'block' {
  if (ctx.signed || ctx.hasSecrets) return 'fatal';
  return p.writeMode === 'block' ? 'block' : 'fatal';
}

/**
 * The policy a script-lane run actually uses: the effective write mode, and as allowed submissions only the forms the
 * steps declare (submit and download.via targets). For Run Steps without a Site Login (`submitsFromSteps`) that is the
 * declared targets whose host is a navigation host; otherwise (a Site Login) the listed forms the
 * steps also declare, matched exactly. Steps never add a host or a form: an off-list target is simply not allowed. Each
 * allowed submission passes only while its own step runs (the session's step window).
 */
export function effectivePolicy(p: PortalPolicy, script: Script, ctx: { signed: boolean; hasSecrets: boolean }): PortalPolicy {
  const out: PortalPolicy = { ...p, writeMode: effectiveWriteMode(p, ctx) };
  const declared = new Map<string, AllowedSubmit>();
  for (const s of flattenSteps(script.steps)) {
    const t = declaredTarget(s);
    if (!t) continue;
    const k = submitKey(t, script.startUrl);
    declared.set(submitLabel(k), k);
  }
  out.allowedSubmits = p.submitsFromSteps && !ctx.hasSecrets
    ? [...declared.values()].filter((t) => p.navHosts.includes(t.host))
    : p.allowedSubmits.filter((a) => declared.has(submitLabel(a)));
  return out;
}
