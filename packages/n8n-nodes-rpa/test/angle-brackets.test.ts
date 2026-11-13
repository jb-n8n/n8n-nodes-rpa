// n8n's error view reads a message as markup: "policy apply <the recording's file>" shows as "policy apply". Every
// message and guidance text the engine or the node exports must say its placeholders in words, with no < or >.
import { describe, expect, it } from 'vitest';
import * as engineMessages from '../../engine/src/messages.js';
import * as config from '../nodes/Playwright/config.js';
import * as credentialTests from '../nodes/Playwright/credential-tests.js';
import * as errors from '../nodes/Playwright/errors.js';
import * as execute from '../nodes/Playwright/execute.js';
import * as guardStore from '../nodes/Playwright/guard-store.js';
import * as guard from '../nodes/Playwright/guard.js';
import * as codeWorkflow from '../nodes/Playwright/operations/codeWorkflow.js';
import * as common from '../nodes/Playwright/operations/common.js';
import * as importSteps from '../nodes/Playwright/operations/importSteps.js';
import * as quick from '../nodes/Playwright/operations/quick.js';
import * as runDesktopSteps from '../nodes/Playwright/operations/runDesktopSteps.js';
import * as runSteps from '../nodes/Playwright/operations/runSteps.js';
import * as runStepsParams from '../nodes/Playwright/operations/runStepsParams.js';
import * as output from '../nodes/Playwright/output.js';
import * as redisStore from '../nodes/Playwright/redis-store.js';

/** Sample arguments for the builders whose parameters are not plain strings (as in the engine's wording test). */
const SAMPLE_ARGS: Record<string, unknown[]> = {
  offListSite: ['cdn.example.com', ['example.com']],
  describeForUser: [{ text: 'Sign In' }],
  formPostsElsewhere: ['other.example', ['example.com']],
  expectedFileInvalid: [['check.name is not a valid regex']],
  runnerNoTcpAnswer: ['wss://10.0.0.20:8765/rpa/v1', 10, '10.0.0.20'],
  runnerConnected: [{ interactive: true }],
};
const SAMPLE = ['sample', 'sample', 'sample'];

/** A builder's text with sample arguments, or undefined when it is not a message builder (it throws or gives no text). */
function built(name: string, fn: (...args: unknown[]) => unknown): string | undefined {
  try {
    const text = fn(...(SAMPLE_ARGS[name] ?? SAMPLE));
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Every string export, and every builder's text: all of messages.ts, and the node's UPPER_CASE message exports. */
function texts(): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(engineMessages)) {
    if (typeof value === 'string') out.push([`messages.${name}`, value]);
    else if (typeof value === 'function') {
      const text = built(name, value as (...args: unknown[]) => unknown);
      if (text !== undefined) out.push([`messages.${name}`, text]);
    }
  }
  const node = { config, credentialTests, errors, execute, guardStore, guard, codeWorkflow, common, importSteps, quick, runDesktopSteps, runSteps, runStepsParams, output, redisStore };
  for (const [module, exports] of Object.entries(node)) {
    for (const [name, value] of Object.entries(exports)) {
      if (!/^[A-Z][A-Z0-9_]+$/.test(name)) continue;
      if (typeof value === 'string') out.push([`${module}.${name}`, value]);
      else if (typeof value === 'function') {
        const text = built(name, value as (...args: unknown[]) => unknown);
        if (text !== undefined) out.push([`${module}.${name}`, text]);
      }
    }
  }
  for (const [code, text] of Object.entries(errors.GUIDANCE)) out.push([`GUIDANCE.${code}`, text]);
  return out;
}

describe('no angle brackets in a text that can reach n8n', () => {
  it('every exported message and guidance text says its placeholders in words', () => {
    const all = texts();
    expect(all.length).toBeGreaterThan(150);
    for (const [name, text] of all) expect(text, name).not.toMatch(/[<>]/);
  });

  it('the Connection Line parser too', () => {
    for (const line of ['rpa-runner://', 'rpa-runner:///rpa/v1#token=t&fingerprint=f', 'rpa-browser://host/#token=t']) {
      for (const kind of ['runner', 'browser'] as const) {
        let message = '';
        try {
          config.parseConnectionLine(kind, line);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message, `${kind} ${line}`).not.toBe('');
        expect(message, `${kind} ${line}`).not.toMatch(/[<>]/);
      }
    }
  });
});
