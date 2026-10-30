// The desktop runner protocol (version 1): JSON-RPC 2.0 over a WebSocket over TLS, one request per message. The runner
// is a user-mode process in an interactive Windows session; it drives apps through UI Automation and enforces its own
// local policy (allowed apps, declared write controls, gated keys, repair limits, export directory confinement).

import type { DesktopApp, UiaCond, WindowSel } from '../types.js';

export const PROTOCOL_VERSION = 1;
/** The runner's default port, used when the credential URL names none. */
export const DEFAULT_RUNNER_PORT = 8765;
/** The WebSocket path of protocol version 1. */
export const RUNNER_PATH = '/rpa/v1';

/** A target as the runner takes it: the step's locator with its fallbacks inline. */
export interface RunnerTarget { window?: WindowSel; path: UiaCond[]; fallbacks?: RunnerTarget[] }
export type RunnerAction = 'click' | 'doubleClick' | 'type' | 'select' | 'check' | 'uncheck' | 'key' | 'read' | 'expand' | 'focus';
/** For `type`: literal text, or the run's export directory, filled in by the runner. Text segments are never interpreted. */
export type Segment = { text: string } | { exportDir: true };
/** One element of a snapshot. `ref` is stable within one snapshot only. Password and credential-like values are never sent. */
export interface RunnerNode {
  ref: string;
  depth: number;
  controlType: string;
  name: string;
  automationId: string;
  className: string;
  enabled: boolean;
  value?: string;
  valueHidden?: true;
}
/** One top-level window of the run, as `windows` lists it. */
export interface RunnerWindow { title: string; exe: string; automationId: string; className: string; foreground: boolean }

export interface HelloResult {
  protocol: number;
  runner: { version: string; os: string; session: { interactive: boolean; locked: boolean } };
}

/** Methods, their params and results. Every method except hello and run.begin needs the active runId. */
export interface RunnerMethods {
  hello: { params: Record<string, never>; result: HelloResult };
  'run.begin': { params: { runId: string; leaseMs: number }; result: { exportDir: string } };
  'run.heartbeat': { params: { runId: string }; result: Record<string, never> };
  'run.end': { params: { runId: string }; result: Record<string, never> };
  'app.launch': { params: { runId: string; app: DesktopApp }; result: { pid: number } };
  snapshot: {
    params: { runId: string; window?: WindowSel; maxNodes?: number; maxDepth?: number };
    /** `truncated`: maxNodes or maxDepth cut the tree short. */
    result: { window: { title: string; exe: string }; nodes: RunnerNode[]; truncated?: true };
  };
  isVisible: { params: { runId: string; target: RunnerTarget }; result: { visible: boolean } };
  resolve: { params: { runId: string; target: RunnerTarget; timeoutMs: number }; result: { candidate: number } };
  act: {
    params: {
      /** Absent only for `key` without a target: the key goes to the focused element of the run's window. */
      runId: string; target?: RunnerTarget; action: RunnerAction; value?: string; segments?: Segment[]; write?: boolean;
      mode?: 'step' | 'repair'; timeoutMs: number;
    };
    result: { text?: string };
  };
  'file.retrieve': { params: { runId: string; pattern: string; timeoutMs: number; maxBytes: number }; result: { name: string; size: number; base64: string } };
  screenshot: { params: { runId: string }; result: { base64: string } };
  /** The run's top-level windows: the foreground window first when it is the run's, then front to back. */
  windows: { params: { runId: string }; result: { windows: RunnerWindow[] } };
  /**
   * The clipboard's Unicode text ('' when it holds none). policy_refused unless the runner's policy sets clipboardRead
   * and one of the run's windows holds the foreground, and for more than 1000 characters. -32601 from an older runner.
   */
  'clipboard.read': { params: { runId: string }; result: { text: string } };
}
export type RunnerMethod = keyof RunnerMethods;

/** JSON-RPC error codes of the runner. */
export const RUNNER_ERROR_CODES = {
  runner_busy: -32001,
  desktop_unavailable: -32002,
  policy_refused: -32003,
  not_found: -32004,
  not_unique: -32005,
  expected_file_missing: -32006,
  timeout: -32007,
  no_run: -32008,
} as const;
export type RunnerErrorKind = keyof typeof RUNNER_ERROR_CODES | 'cannot_act' | 'runner_error';
/** JSON-RPC's invalid params: the runner's answer to a malformed request, and its driver's to a control that cannot take the action. */
export const INVALID_PARAMS = -32602;
/** JSON-RPC's method not found: a runner older than the method. */
export const METHOD_NOT_FOUND = -32601;
/**
 * The runner's driver answers invalid params for an element that cannot take the action asked of it (WindowsDesktop:
 * "the element does not take typed text", "the element cannot be checked or unchecked", "the element cannot expand"):
 * the target now resolves to another kind of control, so the steps no longer match the app.
 */
const CANNOT_ACT = /^invalid params: the element (does not|cannot) /;

/**
 * An error the runner answered with. `message` is the runner's (it never contains typed values); `code` the JSON-RPC
 * code. Subclasses name the kind, so callers can tell a busy runner from a missing element.
 */
export class RunnerError extends Error {
  readonly kind: RunnerErrorKind = 'runner_error';
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'RunnerError';
  }
}
export class RunnerBusyError extends RunnerError { override readonly kind = 'runner_busy'; override name = 'RunnerBusyError'; }
export class DesktopUnavailableError extends RunnerError { override readonly kind = 'desktop_unavailable'; override name = 'DesktopUnavailableError'; }
export class PolicyRefusedError extends RunnerError { override readonly kind = 'policy_refused'; override name = 'PolicyRefusedError'; }
export class ElementNotFoundError extends RunnerError { override readonly kind = 'not_found'; override name = 'ElementNotFoundError'; }
export class ElementNotUniqueError extends RunnerError { override readonly kind = 'not_unique'; override name = 'ElementNotUniqueError'; }
export class ExpectedFileMissingError extends RunnerError { override readonly kind = 'expected_file_missing'; override name = 'ExpectedFileMissingError'; }
export class RunnerTimeoutError extends RunnerError { override readonly kind = 'timeout'; override name = 'RunnerTimeoutError'; }
export class NoRunError extends RunnerError { override readonly kind = 'no_run'; override name = 'NoRunError'; }
/** The element the target matched cannot take the action (a fill on a button, a check on a text field): drift. */
export class ElementCannotActError extends RunnerError { override readonly kind = 'cannot_act'; override name = 'ElementCannotActError'; }

const BY_CODE: Record<number, new (code: number, message: string) => RunnerError> = {
  [RUNNER_ERROR_CODES.runner_busy]: RunnerBusyError,
  [RUNNER_ERROR_CODES.desktop_unavailable]: DesktopUnavailableError,
  [RUNNER_ERROR_CODES.policy_refused]: PolicyRefusedError,
  [RUNNER_ERROR_CODES.not_found]: ElementNotFoundError,
  [RUNNER_ERROR_CODES.not_unique]: ElementNotUniqueError,
  [RUNNER_ERROR_CODES.expected_file_missing]: ExpectedFileMissingError,
  [RUNNER_ERROR_CODES.timeout]: RunnerTimeoutError,
  [RUNNER_ERROR_CODES.no_run]: NoRunError,
};

/** The typed error for a JSON-RPC error object. Unknown codes become a plain RunnerError. */
export function runnerError(code: unknown, message: unknown): RunnerError {
  const c = typeof code === 'number' && Number.isInteger(code) ? code : 0;
  const text = (typeof message === 'string' && message ? message : `runner error ${c}`).split('\n')[0].slice(0, 500);
  const Kind = c === INVALID_PARAMS && CANNOT_ACT.test(text) ? ElementCannotActError : BY_CODE[c] ?? RunnerError;
  return new Kind(c, text);
}

// Errors before any JSON-RPC exchange: the connection itself.

/** The runner could not be reached, the TLS handshake failed, or the upgrade was not a WebSocket. */
export class RunnerConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerConnectError';
  }
}
/** The runner's certificate is not the pinned one. Nothing was sent. */
export class FingerprintMismatchError extends RunnerConnectError {
  constructor(message: string, public readonly presented: string) {
    super(message);
    this.name = 'FingerprintMismatchError';
  }
}
/** The runner answered the upgrade with 401: wrong or missing token. */
export class RunnerTokenRefusedError extends RunnerConnectError {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerTokenRefusedError';
  }
}
/** The connection closed (or broke) while requests were pending. */
export class RunnerDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerDisconnectedError';
  }
}
