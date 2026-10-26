// Shared fixtures for the quick-operation tests.
import { expect } from 'vitest';
import type { IDataObject, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { parseScript, validateScript, type ErrorCode, type TaskFailure } from 'n8n-rpa-engine';
import { policyFor, type PolicyOperation } from '../nodes/Playwright/config.js';
import { properties } from '../nodes/Playwright/description/index.js';
import type { Compiled, LaneSuccess } from '../nodes/Playwright/operations/quick.js';

export const PAGE_URL = 'https://example.com/pricing';
/** RPA Browser credential: a local headless Chromium (the sandbox runs on 127.0.0.1). */
export const BROWSER = { playwrightBrowserApi: { mode: 'local', headless: true } };
/** A valid 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Options every quick operation shows (quick ops + all browser ops + all operations). */
export const QUICK_COMMON_OPTIONS = ['waitUntil', 'waitFor', 'timeout', 'maxSeconds', 'viewport', 'allowedHosts', 'allowPrivateNetwork', 'saveTrace', 'maxItems'];

/** Node parameters of a quick operation as the editor saves them. */
export function quickParams(operation: string, fields: IDataObject = {}, options: IDataObject = {}): IDataObject {
  return { operation, url: PAGE_URL, ...fields, options: { saveTrace: 'never', ...options } };
}

/** A successful script-lane result (the shape of the engine's LaneSuccess). */
export function okResult(over: Partial<LaneSuccess> = {}): LaneSuccess {
  return {
    ok: true, lane: 'script', name: null, version: null, hash: 'a'.repeat(64), rows: [], files: [], log: [], violations: [], durationMs: 12,
    page: { url: PAGE_URL, title: 'Pricing', status: 200 }, verified: false, confirmed: false, outputs: [], blockedRequests: [], writes: [], submitted: false,
    ...over,
  };
}

export function failResult(code: ErrorCode, message: string, over: Partial<TaskFailure> = {}): TaskFailure {
  return { ok: false, code, message, lane: 'script', violations: [], log: [], blockedRequests: [], durationMs: 5, ...over };
}

/** Names of the Options collection entries shown for one operation. */
export function optionsFor(op: string): string[] {
  const collection = properties.find((p) => p.name === 'options' && p.type === 'collection');
  if (!collection) throw new Error('the node has no Options collection');
  return (collection.options as INodeProperties[])
    .filter((o) => {
      const show = o.displayOptions?.show?.['/operation'];
      const hide = o.displayOptions?.hide?.['/operation'];
      return (show === undefined || show.includes(op)) && !(hide?.includes(op) ?? false);
    })
    .map((o) => o.name);
}

/** The compiled steps parse and pass load-mode policy validation against the policy the node will build. */
export function assertRunnable(compiled: Compiled, operation: PolicyOperation = 'quick', url = PAGE_URL): void {
  const parsed = parseScript(compiled.script);
  expect(parsed.startUrl).toBe(new URL(url).href);
  const policy = policyFor({ url, allowedHosts: [], allowPrivateNetwork: false, operation });
  const verdict = validateScript(parsed, { policy, mode: 'load' });
  expect(verdict.violations).toEqual([]);
  expect(verdict.ok).toBe(true);
}

export const binaryOf = (item: INodeExecutionData, key: string): Buffer => Buffer.from(item.binary?.[key]?.data ?? '', 'base64');
export const pngSize = (png: Buffer): { width: number; height: number } => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

export interface PublicCounters { hits: Record<string, number>; posts: unknown[]; collect: number; css: number }
export async function publicCounters(baseUrl: string): Promise<PublicCounters> {
  const res = await fetch(`${baseUrl}/public/api/counters`);
  return (await res.json()) as PublicCounters;
}
export async function pageTitle(url: string): Promise<string> {
  const html = await (await fetch(url)).text();
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';
}
