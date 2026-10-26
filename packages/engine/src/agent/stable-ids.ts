import { SESSION_SEGMENT } from '../steps/urls.js';

const GENERATED: RegExp[] = [
  /\d{3,}/,
  /[0-9a-f]{8}-[0-9a-f]{4}/i,
  /\d{4}-\d{2}-\d{2}/,
  // SAP Unified Rendering: M0:46:<salt>::<r>:<c>
  /^M\d+:\d+:/,
  // UI5 auto ids: __xmlview0, __button12, __component0---__xmlview1
  /__[a-z]+\d/i,
  // React useId and Radix
  /(^|[^a-z]):r[0-9a-z]+:/i,
  // Ember, ExtJS, GWT, JSF counters
  /^(ember|ext-gen|ext-comp|gwt-uid-|j_id)\d/i,
];

/** True when an element id looks produced per response (counters, salts, uuids, dates), so it would not match on replay. */
export function looksGenerated(id: string): boolean {
  if (GENERATED.some((r) => r.test(id))) return true;
  // A hex salt: a run of 6 or more hex characters with both a digit and a letter.
  return (id.match(/[0-9a-f]{6,}/gi) ?? []).some((run) => /\d/.test(run) && /[a-f]/i.test(run));
}

/** True when a path has a session-shaped segment (SAP's `/sap(<token>)/`), which is a credential, not an address. */
export function hrefHasSession(path: string): boolean {
  return path.split('/').some((seg) => SESSION_SEGMENT.test(seg));
}
