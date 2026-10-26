import * as real from 'n8n-rpa-engine';
import type { TaskInput, TaskResult } from 'n8n-rpa-engine';
import type { Engine } from '../nodes/Playwright/engine.js';

export interface FakeEngine extends Engine {
  readonly calls: TaskInput[];
}

/** The real engine's pure functions, with runTask replaced by a scripted result and openSession refused. `call` counts runTask calls from 0. */
export function fakeEngine(run: (input: TaskInput, call: number) => TaskResult | Promise<TaskResult>): FakeEngine {
  const calls: TaskInput[] = [];
  return {
    ...real,
    calls,
    runTask: async (input) => {
      calls.push(input);
      return run(input, calls.length - 1);
    },
    openSession: async () => {
      throw new Error('openSession is not used by unit tests');
    },
  };
}

type ScriptOk = Extract<TaskResult, { ok: true; lane: 'script' }>;
type AgentOk = Extract<TaskResult, { ok: true; lane: 'agent' }>;
type Failure = Extract<TaskResult, { ok: false }>;

/** The page every builder reports unless a test overrides it. */
export const PAGE = { url: 'https://example.com/list', title: 'Items', status: 200 };

export function scriptOk(over: Partial<ScriptOk> = {}): ScriptOk {
  return {
    ok: true, lane: 'script', name: 'items', version: 1, hash: 'a1'.repeat(32), rows: [], files: [], outputs: [], log: [], violations: [],
    blockedRequests: [], writes: [], submitted: false, page: { ...PAGE }, verified: false, confirmed: false, durationMs: 1200, ...over,
  };
}

export function agentOk(over: Partial<AgentOk> = {}): AgentOk {
  return {
    ok: true, lane: 'agent', name: null, version: null, hash: null, rows: [], files: [], confirmed: false, agentLog: [], log: [], violations: [],
    blockedRequests: [], tokens: 1000, llmCalls: 2, durationMs: 20_000, note: '', transcript: [], page: { ...PAGE }, outputs: [], submitted: false, ...over,
  };
}

export function taskFail(code: Failure['code'], message: string, over: Partial<Failure> = {}): Failure {
  return { ok: false, code, message, violations: [], log: [], blockedRequests: [], durationMs: 900, lane: 'script', ...over };
}
