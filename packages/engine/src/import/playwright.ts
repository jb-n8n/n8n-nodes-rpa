// Playwright code: a hand-written tokenizer and call-chain parser for the statements codegen writes
// with `--target javascript` or `playwright-test`. Nothing is evaluated: there is no eval, Function or vm, and the
// tokenizer, the statement splitter and the parser each walk the input once (expression nesting is capped). A statement
// outside the grammar becomes a report item with its line; an unterminated string, template, regular expression or
// comment ends the parse with an `error` item. Typed values only ever reach fill/select events, which stripSecrets checks
// and drops: never a report item.
import { IMPORT_UNSUPPORTED_TARGET } from '../messages.js';
import { cleanLabel } from './draft.js';
import type { Candidate, ImportEvent, ImportItem, ImportReport } from './types.js';

/** Code larger than this is refused before it is read. */
export const MAX_PLAYWRIGHT_BYTES = 2 * 1024 * 1024;
/** Code with more lines than this is refused. */
export const MAX_PLAYWRIGHT_LINES = 50_000;
/** Code with more statements than this is refused. */
export const MAX_PLAYWRIGHT_STATEMENTS = 10_000;
/** Brackets nested deeper than this inside one statement make the statement unreadable (reported, not parsed). */
const MAX_NESTING = 32;
/** Code with more tokens (words, strings, punctuation) than this is refused: ten thousand statements of codegen are far fewer. */
const MAX_TOKENS = 400_000;
/** Brackets nested deeper than this end the parse: codegen nests a handful. */
const MAX_BRACKETS = 200;
/** A locator chain may scope its target at most this many times (`within` inside `within`). */
const MAX_SCOPES = 8;
/** Test hooks run around each test: their bodies are not the recording. */
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
/** At most this many statements are reported one by one; the rest are counted in one item. */
const MAX_ITEMS = 200;

const WHAT = 'Playwright code';
const TOO_LARGE = 'the code is larger than 2 MiB, so it was not read';
const TOO_LONG = `the code has more than ${MAX_PLAYWRIGHT_LINES.toLocaleString('en-US')} lines, so it was not read`;
const TOO_MANY = `the code has more than ${MAX_PLAYWRIGHT_STATEMENTS.toLocaleString('en-US')} statements, so it was not read`;
const NOT_TEXT = 'the code must be text or a file';

const R = {
  unknown: 'it is not a statement the import understands: only the statements Playwright codegen writes are imported',
  control: 'loops, conditions and functions are not imported: the steps run once, in order',
  template: 'it builds text at run time (a template literal with ${…}): write the text out, or use a variable in the steps',
  pattern: 'a regular expression or URL pattern is not imported: use the exact text',
  unique: (m: string) => `.${m}() is not imported: a step finds one element by its locator; make the locator unique (a name, a label or a scope)`,
  method: (m: string) => `.${m}() is not imported`,
  options: (m: string) => `${m} options are not imported: the steps click, type or choose with defaults`,
  javascript: 'the steps do not run page JavaScript: add a waitFor on what the page shows when it is ready',
  handler: 'event handlers (dialogs, requests, routes) are not imported',
  hover: 'a hover is not a step: a menu that opens on hover needs a click on the menu',
  key: 'only Enter is imported: add a step for what this key does',
  wait: 'each step waits for its element itself, so a fixed or load wait is not needed',
  close: 'the run closes the browser itself when the steps end',
  firstTab: 'it runs on the first tab, but the steps continue in the new tab the popup opened',
  newTab: 'a tab the code opens itself is not imported: steps follow one page, or a new tab a click opens (popup)',
  noClick: 'no click between the event and its await: the event is not imported',
  event: 'only download and popup events are imported',
  check: 'only toBeVisible and toHaveURL checks are imported',
  negative: 'a negative check is not imported: add a waitFor for what the page shows instead',
  frames: 'only one frame, named first in the chain, is imported',
  selector: 'only CSS, text= and id= selectors are imported: XPath, chained (>>) and other selector engines are not',
  noAction: 'a locator without an action does nothing',
  test: 'test settings, hooks and annotations are not imported',
  saved: 'the run keeps the downloaded file itself and checks it against the Expected File',
  viewport: 'the node\'s Viewport option sets the window size',
  upload: 'uploading a file is not a step',
  value: 'the value must be written out as text',
  reassigned: 'the variable is assigned again, so the import cannot tell which element it names: use one const per locator',
  scoped: `a locator scoped more than ${MAX_SCOPES} times is not imported`,
  bareEvent: 'an event awaited on its own waits for nothing the steps do: codegen writes const p = page.waitForEvent(…), then the click, then await p',
} as const;

const ENTER = new Set(['Enter', 'NumpadEnter']);
/** Keys a report item may name. Any other key (a letter, a digit, a combination) reads "a key", so a password pressed key by key is never spelled out. */
const NAMED_KEYS = new Set(['Tab', 'Escape', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Insert']);
const LOCATOR_METHODS = new Set(['getByRole', 'getByLabel', 'getByText', 'getByTestId', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'locator', 'frameLocator', 'contentFrame', 'first', 'last', 'nth', 'filter', 'and', 'or']);
const NARROWING = new Set(['first', 'last', 'nth', 'filter', 'and', 'or']);
const LEGACY_ACTIONS = new Set(['click', 'dblclick', 'tap', 'fill', 'type', 'check', 'uncheck', 'setChecked', 'selectOption', 'press', 'hover', 'focus', 'setInputFiles', 'waitForSelector']);
const PAGE_JAVASCRIPT = new Set(['evaluate', 'evaluateHandle', '$eval', '$$eval', 'addInitScript', 'addScriptTag', 'addStyleTag', 'exposeFunction', 'exposeBinding', 'setContent']);
const HANDLERS = new Set(['on', 'once', 'off', 'route', 'unroute', 'routeFromHAR', 'addLocatorHandler']);
const WAITS = new Set(['waitForTimeout', 'waitForLoadState', 'waitForNavigation', 'waitForFunction']);
const SCAFFOLD = new Set(['launch', 'launchPersistentContext', 'launchServer', 'connect', 'connectOverCDP', 'newContext']);
const CONTROL = new Set(['for', 'while', 'do', 'if', 'else', 'switch', 'try', 'function', 'class', 'return', 'throw']);
/** Line starts that mark Playwright for Python, Java or C#. */
const OTHER_TARGETS = ['from playwright.', 'from playwright import', 'import com.microsoft.playwright', 'using Microsoft.Playwright'];

// ---------------------------------------------------------------------------------------------------------------------
// Tokenizer

type TokKind = 'id' | 'str' | 'num' | 'regex' | 'p' | 'nl';
interface Tok { k: TokKind; v: string; line: number; interp?: true }
type Lexed = { toks: Tok[] } | { error: string; line: number };

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'await', 'yield']);
const isIdStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
const isIdPart = (c: number) => isIdStart(c) || (c >= 48 && c <= 57);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/**
 * The code as tokens, in one pass: identifiers, numbers, strings (escapes decoded), templates (a template with `${…}`
 * is one string token marked `interp`, and whatever is inside its interpolations is skipped), regular expressions,
 * punctuation and newlines. Comments and other whitespace are dropped.
 */
function lex(src: string): Lexed {
  const toks: Tok[] = [];
  const n = src.length;
  let line = 1;
  /** Brace depth inside each open template interpolation; tokens inside one are not kept. */
  const stack: number[] = [];
  let templateLine = 0;
  let prev: Tok | undefined;
  let brackets = 0;
  let overflow = '';
  const emit = (t: Tok) => {
    prev = t;
    if (stack.length) return;
    if (t.k === 'p') {
      if (t.v === '(' || t.v === '[' || t.v === '{') { if (++brackets > MAX_BRACKETS) overflow = `brackets are nested more than ${MAX_BRACKETS} deep, so the code was not read`; }
      else if ((t.v === ')' || t.v === ']' || t.v === '}') && brackets > 0) brackets--;
    }
    if (toks.push(t) > MAX_TOKENS) overflow = 'the code is too long to read: it has more words and symbols than ten thousand statements would';
  };
  const newline = (): boolean => ++line > MAX_PLAYWRIGHT_LINES;
  /** A backslash at j that continues a string on the next line (LF or CRLF). */
  const continuation = (j: number): boolean => src[j + 1] === '\n' || (src[j + 1] === '\r' && src[j + 2] === '\n');

  /** An escape at src[j] === '\\': the text it stands for and where it ends, or undefined at the end of the input. */
  const escape = (j: number): { text: string; next: number } | undefined => {
    if (j + 1 >= n) return undefined;
    const c = src[j + 1];
    switch (c) {
      case 'n': return { text: '\n', next: j + 2 };
      case 't': return { text: '\t', next: j + 2 };
      case 'r': return { text: '\r', next: j + 2 };
      case 'b': return { text: '\b', next: j + 2 };
      case 'f': return { text: '\f', next: j + 2 };
      case 'v': return { text: '\v', next: j + 2 };
      case '0': return { text: '\0', next: j + 2 };
      case '\r': return { text: '', next: src[j + 2] === '\n' ? j + 3 : j + 2 };
      case '\n': return { text: '', next: j + 2 };
      case 'x': {
        if (isHex(src.charCodeAt(j + 2)) && isHex(src.charCodeAt(j + 3))) return { text: String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)), next: j + 4 };
        return { text: 'x', next: j + 2 };
      }
      case 'u': {
        if (src[j + 2] === '{') {
          let k = j + 3;
          while (k < n && k < j + 10 && isHex(src.charCodeAt(k))) k++;
          const cp = parseInt(src.slice(j + 3, k), 16);
          if (src[k] === '}' && k > j + 3 && cp <= 0x10ffff) return { text: String.fromCodePoint(cp), next: k + 1 };
          return { text: 'u', next: j + 2 };
        }
        let k = j + 2;
        while (k < j + 6 && isHex(src.charCodeAt(k))) k++;
        if (k === j + 6) return { text: String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)), next: j + 6 };
        return { text: 'u', next: j + 2 };
      }
      default: return { text: c, next: j + 2 };
    }
  };

  /** A template's text from j up to its closing backtick or its next `${`, or undefined when the input ends first. */
  const template = (j: number): { next: number; open: boolean; text: string } | 'lines' | undefined => {
    const parts: string[] = [];
    let start = j;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 96) { parts.push(src.slice(start, j)); return { next: j + 1, open: false, text: parts.join('') }; }
      if (c === 36 && src.charCodeAt(j + 1) === 123) { parts.push(src.slice(start, j)); return { next: j + 2, open: true, text: parts.join('') }; }
      if (c === 92) {
        parts.push(src.slice(start, j));
        if (continuation(j) && newline()) return 'lines';
        const e = escape(j);
        if (!e) return undefined;
        parts.push(e.text);
        j = start = e.next;
        continue;
      }
      if (c === 10 && newline()) return 'lines';
      j++;
    }
    return undefined;
  };

  let i = 0;
  while (i < n) {
    if (overflow) return { error: overflow, line };
    const c = src.charCodeAt(i);
    if (c === 10) {
      if (newline()) return { error: TOO_LONG, line: MAX_PLAYWRIGHT_LINES };
      emit({ k: 'nl', v: '\n', line: line - 1 });
      i++;
      continue;
    }
    if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029) { i++; continue; }
    if (c === 47 && src.charCodeAt(i + 1) === 47) { // a line comment, up to (not including) the newline
      const end = src.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === 47 && src.charCodeAt(i + 1) === 42) { // a block comment
      const startLine = line;
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return { error: 'a comment (/* …) is not closed: the code ends inside it', line: startLine };
      for (let k = i + 2; k < end; k++) if (src.charCodeAt(k) === 10 && newline()) return { error: TOO_LONG, line: MAX_PLAYWRIGHT_LINES };
      i = end + 2;
      continue;
    }
    if (c === 47 && (!prev || prev.k === 'nl' || (prev.k === 'p' && prev.v !== ')' && prev.v !== ']' && prev.v !== '}') || (prev.k === 'id' && REGEX_AFTER_WORD.has(prev.v)))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      for (;;) {
        const d = src.charCodeAt(j);
        if (j >= n || d === 10 || d === 13) break;
        if (d === 92) { if (src.charCodeAt(j + 1) === 10 || src.charCodeAt(j + 1) === 13) break; j += 2; continue; }
        if (d === 91) inClass = true;
        else if (d === 93) inClass = false;
        else if (d === 47 && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        j++;
        while (j < n && isIdPart(src.charCodeAt(j))) j++;
        emit({ k: 'regex', v: '', line });
        i = j;
        continue;
      }
      // At the start of a line a slash may be a division continuing the line before: the statement is reported, not the import.
      if (!prev || prev.k !== 'nl') return { error: 'a regular expression (/…/) is not closed on its line', line };
    }
    if (c === 39 || c === 34) { // a quoted string, on one line
      const quote = c;
      const startLine = line;
      const parts: string[] = [];
      let j = i + 1;
      let start = j;
      for (;;) {
        if (j >= n) return { error: 'a string is not closed: the code ends inside it', line: startLine };
        const d = src.charCodeAt(j);
        if (d === quote) break;
        if (d === 10) return { error: 'a string is not closed on its line', line: startLine };
        if (d === 92) {
          parts.push(src.slice(start, j));
          if (continuation(j) && newline()) return { error: TOO_LONG, line: MAX_PLAYWRIGHT_LINES };
          const e = escape(j);
          if (!e) return { error: 'a string is not closed: the code ends inside it', line: startLine };
          parts.push(e.text);
          j = start = e.next;
          continue;
        }
        j++;
      }
      parts.push(src.slice(start, j));
      emit({ k: 'str', v: parts.join(''), line: startLine });
      i = j + 1;
      continue;
    }
    if (c === 96) { // a template literal
      if (stack.length === 0) templateLine = line;
      const startLine = line;
      const t = template(i + 1);
      if (t === 'lines') return { error: TOO_LONG, line: MAX_PLAYWRIGHT_LINES };
      if (!t) return { error: 'a template literal (`…`) is not closed: the code ends inside it', line: templateLine };
      emit({ k: 'str', v: t.text, line: startLine, ...(t.open ? { interp: true as const } : {}) });
      if (t.open) { stack.push(0); prev = { k: 'p', v: '{', line }; }
      i = t.next;
      continue;
    }
    if (c === 123 && stack.length) { stack[stack.length - 1]++; emit({ k: 'p', v: '{', line }); i++; continue; }
    if (c === 125 && stack.length) {
      if (stack[stack.length - 1] > 0) { stack[stack.length - 1]--; emit({ k: 'p', v: '}', line }); i++; continue; }
      stack.pop(); // the interpolation ends: the template goes on
      const t = template(i + 1);
      if (t === 'lines') return { error: TOO_LONG, line: MAX_PLAYWRIGHT_LINES };
      if (!t) return { error: 'a template literal (`…`) is not closed: the code ends inside it', line: templateLine };
      prev = t.open ? { k: 'p', v: '{', line } : { k: 'str', v: '', line };
      if (t.open) stack.push(0);
      i = t.next;
      continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
      let j = i + 1;
      while (j < n && (isIdPart(src.charCodeAt(j)) || src.charCodeAt(j) === 46)) j++;
      emit({ k: 'num', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src.charCodeAt(j))) j++;
      emit({ k: 'id', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (src.startsWith('...', i)) { emit({ k: 'p', v: '...', line }); i += 3; continue; }
    if (two === '=>' || (two === '?.' && !isDigit(src.charCodeAt(i + 2)))) { emit({ k: 'p', v: two, line }); i += 2; continue; }
    emit({ k: 'p', v: src[i], line });
    i++;
  }
  if (overflow) return { error: overflow, line };
  if (stack.length) return { error: 'a template literal (`…`) is not closed: the code ends inside it', line: templateLine };
  return { toks };
}

// ---------------------------------------------------------------------------------------------------------------------
// Statements

interface Stmt { toks: Tok[]; line: number }
type Split = { stmts: Stmt[]; tests: number; testLine: number } | { error: string };

const isP = (t: Tok | undefined, v: string) => t !== undefined && t.k === 'p' && t.v === v;
const isId = (t: Tok | undefined, v?: string) => t !== undefined && t.k === 'id' && (v === undefined || t.v === v);
const CONTINUES_AFTER = new Set(['.', '?.', '=', ',', '=>', '+', '-', '*', '&', '|', ':', '?', '!', '<', '>']);
const CONTINUES_AFTER_WORD = new Set(['await', 'const', 'let', 'var', 'new', 'return', 'typeof', 'of', 'in']);

/** A statement head that opens a body whose statements are the recording: `test(…, async ({ page }) => {` or `(async () => {`. */
function isWrapperHead(cur: Tok[]): boolean {
  if (cur.length < 2) return false;
  const last = cur[cur.length - 1];
  const iife = isP(cur[0], '(') && (isId(cur[1], 'async') || isId(cur[1], 'function'));
  if (!isId(cur[0], 'test') && !iife) return false;
  if (isP(cur[1], '.') && isId(cur[2]) && HOOKS.has(cur[2].v)) return false;
  if (isP(last, '=>')) return true;
  return isP(last, ')') && cur.slice(0, 16).some((t) => isId(t, 'function'));
}

/**
 * Splits tokens into statements on `;` and on newlines at bracket depth 0, where a newline before `.` or after an
 * operator continues the statement (a chain broken over lines). A wrapper's body (`test(…) => {`, `(async () => {`) is
 * a block of statements of its own; its head and tail (`});`, `})();`) are dropped.
 */
function splitStatements(toks: Tok[]): Split {
  const stmts: Stmt[] = [];
  let depth = 0;
  const blocks: number[] = [];
  let cur: Tok[] = [];
  let tail = false;
  let tests = 0;
  let testLine = 0;
  const base = () => (blocks.length ? blocks[blocks.length - 1] : 0);
  const flush = (): boolean => {
    if (!tail && cur.length) stmts.push({ toks: cur, line: cur[0].line });
    cur = [];
    tail = false;
    return stmts.length > MAX_PLAYWRIGHT_STATEMENTS;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'nl') {
      if (depth !== base() || cur.length === 0) continue;
      let j = i + 1;
      while (j < toks.length && toks[j].k === 'nl') j++;
      const last = cur[cur.length - 1];
      const next = toks[j];
      const continues = isP(next, '.') || isP(next, '?.') || (last.k === 'p' && CONTINUES_AFTER.has(last.v)) || (last.k === 'id' && CONTINUES_AFTER_WORD.has(last.v));
      if (continues) { i = j - 1; continue; }
      if (flush()) return { error: TOO_MANY };
      continue;
    }
    if (t.k === 'p') {
      if (t.v === ';' && depth === base()) { if (flush()) return { error: TOO_MANY }; continue; }
      if (t.v === '{' && !tail && isWrapperHead(cur)) {
        if (isId(cur[0], 'test') && isP(cur[1], '(')) { tests++; if (tests === 1) testLine = cur[0].line; }
        depth++;
        blocks.push(depth);
        cur = [];
        continue;
      }
      if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') {
        if (t.v === '}' && blocks.length && depth === base()) {
          if (flush()) return { error: TOO_MANY };
          blocks.pop();
          depth--;
          tail = true;
          continue;
        }
        if (depth > base()) depth--;
      }
    }
    cur.push(t);
  }
  if (flush()) return { error: TOO_MANY };
  return { stmts, tests, testLine };
}

// ---------------------------------------------------------------------------------------------------------------------
// Expressions

type Node = NodeShape & { line?: number };
type NodeShape =
  | { k: 'id'; v: string }
  | { k: 'str'; v: string }
  | { k: 'num'; v: string }
  | { k: 'lit'; v: boolean | null }
  | { k: 'regex' }
  | { k: 'arr'; items: Node[] }
  | { k: 'obj'; props: Map<string, Node> }
  | { k: 'member'; obj: Node; prop: string }
  | { k: 'call'; callee: Node; args: Node[] }
  | { k: 'await'; e: Node };
interface Parsed { names?: string[]; destructured?: 'arr' | 'obj'; expr: Node }

const FAIL = Symbol('fail');
const NOT_VALUES = new Set(['async', 'function', 'new', 'class', 'typeof', 'void', 'delete', 'yield', 'this', 'super', 'import', 'export', ...CONTROL]);

/** A statement as `[const|let|var <binding> =] <expression>` in the grammar's expressions, or undefined when it is not one. */
function parseStatement(toks: Tok[]): Parsed | undefined {
  let p = 0;
  let depth = 0;
  const fail = (): never => { throw FAIL; };
  const expect = (v: string) => { if (!isP(toks[p], v)) fail(); p++; };
  const list = (close: string): Node[] => {
    const items: Node[] = [];
    while (!isP(toks[p], close)) {
      items.push(expr());
      if (isP(toks[p], ',')) p++;
      else if (!isP(toks[p], close)) fail();
    }
    p++;
    return items;
  };
  const primary = (): Node => {
    const t = toks[p];
    if (!t) return fail();
    const node = value();
    node.line = t.line;
    return node;
  };
  const value = (): Node => {
    const t = toks[p++];
    if (!t) return fail();
    switch (t.k) {
      case 'id':
        if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
        if (t.v === 'null' || t.v === 'undefined') return { k: 'lit', v: null };
        if (NOT_VALUES.has(t.v) || t.v === 'await') return fail();
        return { k: 'id', v: t.v };
      case 'str': return { k: 'str', v: t.v };
      case 'num': return { k: 'num', v: t.v };
      case 'regex': return { k: 'regex' };
      case 'p':
        if (t.v === '(') { const e = expr(); expect(')'); return e; }
        if (t.v === '[') return { k: 'arr', items: list(']') };
        if (t.v === '-' && toks[p]?.k === 'num') return { k: 'num', v: `-${toks[p++].v}` };
        if (t.v === '{') {
          const props = new Map<string, Node>();
          while (!isP(toks[p], '}')) {
            const key = toks[p++];
            if (!key || (key.k !== 'id' && key.k !== 'str' && key.k !== 'num')) return fail();
            if (isP(toks[p], ':')) { p++; props.set(key.v, expr()); } else if (key.k === 'id') props.set(key.v, { k: 'id', v: key.v });
            else return fail();
            if (isP(toks[p], ',')) p++;
            else if (!isP(toks[p], '}')) fail();
          }
          p++;
          return { k: 'obj', props };
        }
        return fail();
      default: return fail();
    }
  };
  const expr = (): Node => {
    if (++depth > MAX_NESTING) fail();
    if (isId(toks[p], 'await')) { p++; const e = expr(); depth--; return { k: 'await', e }; }
    let e = primary();
    for (;;) {
      if (isP(toks[p], '.') || isP(toks[p], '?.')) {
        const prop = toks[p + 1];
        if (!prop || prop.k !== 'id') fail();
        e = { k: 'member', obj: e, prop: prop.v };
        p += 2;
      } else if (isP(toks[p], '(')) {
        p++;
        e = { k: 'call', callee: e, args: list(')') };
      } else if (isP(toks[p], '!') && !isP(toks[p + 1], '=')) p++; // TypeScript's non-null assertion
      else break;
    }
    depth--;
    return e;
  };

  try {
    const out: Parsed = { expr: { k: 'lit', v: null } };
    if (isId(toks[0], 'const') || isId(toks[0], 'let') || isId(toks[0], 'var')) {
      p = 1;
      const t = toks[p];
      if (isId(t) && !NOT_VALUES.has(t.v)) { out.names = [t.v]; p++; }
      else if (isP(t, '[')) {
        p++;
        out.names = [];
        out.destructured = 'arr';
        while (!isP(toks[p], ']')) {
          if (isId(toks[p])) out.names.push(toks[p++].v);
          else if (isP(toks[p], ',')) out.names.push('');
          else fail();
          if (isP(toks[p], ',')) p++;
          else if (!isP(toks[p], ']')) fail();
        }
        p++;
      } else if (isP(t, '{')) {
        out.names = [];
        out.destructured = 'obj';
        let d = 0;
        for (; p < toks.length; p++) {
          if (isP(toks[p], '{')) d++;
          else if (isP(toks[p], '}') && --d === 0) break;
        }
        p++;
      } else fail();
      if (isP(toks[p], ':')) { // a TypeScript type annotation on a single name: skipped up to the '='
        while (p < toks.length && !isP(toks[p], '=')) p++;
      }
      expect('=');
    }
    out.expr = expr();
    if (p !== toks.length) fail();
    return out;
  } catch (err) {
    if (err === FAIL) return undefined;
    throw err;
  }
}

interface Seg { name: string; args?: Node[] }
/** A call chain `root.a(…).b.c(…)` as its root and its segments (a member followed by a call is one segment with args). */
function flatten(node: Node): { root: Node; segs: Seg[] } {
  const segs: Seg[] = [];
  let n = node;
  for (;;) {
    if (n.k === 'call' && n.callee.k === 'member') { segs.push({ name: n.callee.prop, args: n.args }); n = n.callee.obj; }
    else if (n.k === 'member') { segs.push({ name: n.prop }); n = n.obj; }
    else break;
  }
  return { root: n, segs: segs.reverse() };
}

const strOf = (n: Node | undefined): string | undefined => (n?.k === 'str' ? n.v : undefined);
const objOf = (n: Node | undefined): Map<string, Node> | undefined => (n?.k === 'obj' ? n.props : undefined);

/** Why a statement that is not an expression of the grammar was not imported. */
function unparsed(toks: Tok[]): string {
  if (isId(toks[0], 'test')) return R.test;
  const k = isId(toks[0], 'await') ? 1 : 0;
  if (isId(toks[k]) && isP(toks[k + 1], '.') && isId(toks[k + 2])) {
    if (PAGE_JAVASCRIPT.has(toks[k + 2].v)) return R.javascript;
    if (HANDLERS.has(toks[k + 2].v)) return R.handler;
  }
  return toks.some((t) => isP(t, '=>')) ? R.control : R.unknown;
}

/** The statement's shape for a report item: identifiers and punctuation, every literal as `…`, never a string's text. */
function shapeOf(toks: Tok[]): string {
  const parts: string[] = [];
  let prevWord = false;
  for (const t of toks.slice(0, 40)) {
    const word = t.k === 'id' || t.k === 'num';
    const text = t.k === 'id' ? t.v : t.k === 'p' ? t.v : '…';
    if (word && prevWord) parts.push(' ');
    if (t.k === 'p' && (t.v === '=' || t.v === '=>')) parts.push(` ${text} `);
    else parts.push(text);
    prevWord = word;
  }
  return cleanLabel(parts.join('')) || 'A statement';
}

// ---------------------------------------------------------------------------------------------------------------------
// Locators

interface Built {
  loc?: Candidate;
  frame?: string;
  /** The accessible name or text the locator names, for intents ('' for CSS). */
  label: string;
  /** What the report calls the element: the label, else the CSS. */
  shown: string;
  /** Strings the source used to find the element, for credential detection only (stripSecrets); never copied into steps. */
  hints: string[];
}
type ChainResult = { built: Built; next: number } | { fail: string; built: Built };

/** A CSS attribute selector that matches the attribute's exact value. */
function attrCss(attr: string, value: string): string {
  let out = '';
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if (ch === '\\' || ch === '"') out += `\\${ch}`;
    else if (c < 0x20 || c === 0x7f) out += `\\${c.toString(16)} `;
    else out += ch;
  }
  return `[${attr}="${out}"]`;
}

/** A selector string (`locator(…)`, or the first argument of the older `page.click(…)`) as a candidate, or the reason it is not one. */
function selectorCandidate(sel: string): Candidate | string {
  const s = sel.trim();
  if (!s) return R.selector;
  if (s.includes('>>') || s.startsWith('/') || s.startsWith('(/') || s.startsWith('..')) return R.selector;
  if (s.startsWith('"') || s.startsWith('\'')) { // the old quoted text selector
    const inner = s.slice(1, -1);
    return s.length > 1 && s.endsWith(s[0]) && inner ? { text: inner, exact: true } : R.selector;
  }
  let j = 0;
  while (j < s.length && j < 40) {
    const c = s.charCodeAt(j);
    if (!(isIdPart(c) && c <= 127) && c !== 45 && c !== 58) break;
    j++;
  }
  if (j > 0 && s[j] === '=') {
    const engine = s.slice(0, j);
    const body = s.slice(j + 1).trim();
    if (!body) return R.selector;
    if (engine === 'css') return { css: body };
    if (engine === 'id') return { css: attrCss('id', body) };
    if (engine === 'data-testid') return { testId: body };
    if (engine === 'text') {
      const quoted = body.length > 1 && (body[0] === '"' || body[0] === '\'') && body.endsWith(body[0]);
      return quoted ? { text: body.slice(1, -1), exact: true } : { text: body };
    }
    return R.selector;
  }
  return { css: s };
}

/** `getBy*(text, { exact })`'s exact option, or a failure reason for any other option. */
function exactOption(n: Node | undefined, method: string): { exact?: true } | string {
  if (n === undefined) return {};
  const props = objOf(n);
  if (!props) return R.options(method);
  for (const [k, v] of props) if (k !== 'exact' || v.k !== 'lit') return R.options(`${method} ${k}`);
  return props.get('exact')?.k === 'lit' && (props.get('exact') as { v: unknown }).v === true ? { exact: true } : {};
}

/**
 * Locator segments from `from` as one candidate: each further locator in the chain is searched inside the one before
 * (`within`), and a first `frameLocator(css)` or `locator(css).contentFrame()` becomes the locator's frame. Narrowing
 * (`.nth`, `.first`, `.filter` …) and anything the steps cannot say is a failure with its reason.
 */
function buildChain(segs: Seg[], from: number, base?: Built): ChainResult {
  const b: Built = base ? { ...base, hints: [...base.hints] } : { label: '', shown: '', hints: [] };
  let first = !base;
  let scopes = 0;
  for (let w = b.loc?.within; w; w = w.within) scopes++;
  let i = from;
  for (; i < segs.length && LOCATOR_METHODS.has(segs[i].name); i++) {
    const { name, args = [] } = segs[i];
    if (!segs[i].args) return { fail: R.unknown, built: b };
    if (NARROWING.has(name)) return { fail: R.unique(name), built: b };
    if (args.some((a) => a.k === 'regex')) return { fail: R.pattern, built: b };
    if (name === 'contentFrame') {
      if (!b.loc || !('css' in b.loc) || b.loc.within || b.frame || args.length || !b.loc.css) return { fail: R.frames, built: b };
      b.frame = b.loc.css;
      b.loc = undefined;
      b.label = b.shown = '';
      continue;
    }
    const text = strOf(args[0]);
    if (text === undefined || !text) return { fail: R.unknown, built: b };
    b.hints.push(text);
    let next: Candidate;
    let label = '';
    switch (name) {
      case 'frameLocator': {
        if (!first || b.frame || args.length > 1) return { fail: R.frames, built: b };
        const c = selectorCandidate(text);
        if (typeof c === 'string' || !('css' in c)) return { fail: R.frames, built: b };
        b.frame = c.css;
        first = false;
        continue;
      }
      case 'getByRole': {
        if (args.length > 2) return { fail: R.unknown, built: b };
        const opts = args[1] === undefined ? new Map<string, Node>() : objOf(args[1]);
        if (!opts) return { fail: R.options(name), built: b };
        let roleName: string | undefined;
        let exact = false;
        for (const [k, v] of opts) {
          if (k === 'name' && v.k === 'str') roleName = v.v;
          else if (k === 'name' && v.k === 'regex') return { fail: R.pattern, built: b };
          else if (k === 'exact' && v.k === 'lit') exact = v.v === true;
          else return { fail: R.options(`getByRole ${k}`), built: b };
        }
        if (roleName !== undefined) b.hints.push(roleName);
        next = { role: text, ...(roleName ? { name: roleName } : {}), ...(roleName && exact ? { exact: true } : {}) };
        label = roleName ?? '';
        break;
      }
      case 'getByLabel':
      case 'getByText': {
        if (args.length > 2) return { fail: R.unknown, built: b };
        const exact = exactOption(args[1], name);
        if (typeof exact === 'string') return { fail: exact, built: b };
        next = name === 'getByLabel' ? { label: text, ...exact } : { text, ...exact };
        label = text;
        break;
      }
      case 'getByTestId':
        if (args.length > 1) return { fail: R.unknown, built: b };
        next = { testId: text };
        label = text;
        break;
      case 'getByPlaceholder':
      case 'getByAltText':
      case 'getByTitle': {
        if (args.length > 2) return { fail: R.unknown, built: b };
        const exact = exactOption(args[1], name);
        if (typeof exact === 'string') return { fail: exact, built: b };
        next = { css: attrCss(name === 'getByPlaceholder' ? 'placeholder' : name === 'getByAltText' ? 'alt' : 'title', text) };
        label = text;
        break;
      }
      default: { // locator(selector)
        if (args.length > 1) return { fail: R.options('locator'), built: b };
        const c = selectorCandidate(text);
        if (typeof c === 'string') return { fail: c, built: b };
        next = c;
        label = 'css' in c ? '' : 'text' in c ? c.text : 'testId' in c ? c.testId : '';
      }
    }
    if (b.loc) {
      if (++scopes > MAX_SCOPES) return { fail: R.scoped, built: b };
      next.within = b.loc;
    }
    b.loc = next;
    b.label = label;
    b.shown = label || ('css' in next ? next.css : '');
    first = false;
  }
  return { built: b, next: i };
}

/** The locator as an event target: its frame on the outermost candidate, as the steps' locator builder applies it. */
function targetOf(b: Built): Candidate[] {
  if (!b.loc) return [];
  return [b.frame ? { ...b.loc, frame: b.frame } : b.loc];
}

const VERBS: Record<string, string> = {
  click: 'Click', dblclick: 'Click', tap: 'Click', fill: 'Type into', type: 'Type into', pressSequentially: 'Type into', clear: 'Clear',
  selectOption: 'Choose an option in', check: 'Check', setChecked: 'Check', uncheck: 'Uncheck', hover: 'Hover', waitFor: 'Wait for',
  waitForSelector: 'Wait for', setInputFiles: 'Upload a file to', focus: 'Focus', toBeVisible: 'Wait for',
};
const describe = (action: string, b: Built | undefined): string => `${VERBS[action] ?? 'Use'} ${cleanLabel(b?.shown ?? '') || 'the element'}`;

// ---------------------------------------------------------------------------------------------------------------------
// The parser

interface Promised { kind: 'download' | 'popup'; clicked: boolean }
type Binding = { kind: 'reassigned' } | { kind: 'scaffold' } | { kind: 'download' } | { kind: 'locator'; built: Built } | { kind: 'promise'; promise: Promised };

/** Origin and path of an address in the code, for a report item. Never its query or fragment. */
function urlPath(url: string): string | undefined {
  if (url.includes('*')) return undefined;
  if (URL.canParse(url)) {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.pathname : undefined;
  }
  return url.startsWith('/') ? (url.split(/[?#]/)[0] ?? undefined) : undefined;
}

/**
 * True when the code is Playwright for Python, Java or C#: an import line (`from playwright.…`, `from playwright import`,
 * `import com.microsoft.playwright`, `using Microsoft.Playwright`) at a line start, or Python's `.get_by_…` methods.
 * Markers inside comments, strings and templates do not count. One pass.
 */
function otherTarget(code: string): boolean {
  const n = code.length;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let lineStart = true;
  for (let i = 0; i < n; i++) {
    const c = code[i];
    if (c === '\n') {
      if (state !== 'block' && state !== 'template') state = 'code';
      lineStart = true;
      continue;
    }
    switch (state) {
      case 'line': continue;
      case 'block': if (c === '*' && code[i + 1] === '/') { state = 'code'; i++; } continue;
      case 'single': case 'double':
        if (c === '\\') i++;
        else if (c === (state === 'single' ? '\'' : '"')) state = 'code';
        continue;
      case 'template':
        if (c === '\\') i++;
        else if (c === '`') state = 'code';
        continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\ufeff') continue;
    if (lineStart) {
      lineStart = false;
      if ((c === 'f' || c === 'i' || c === 'u') && OTHER_TARGETS.some((t) => code.startsWith(t, i))) return true;
    }
    if (c === '/' && code[i + 1] === '/') { state = 'line'; i++; }
    else if (c === '/' && code[i + 1] === '*') { state = 'block'; i++; }
    else if (c === '\'') state = 'single';
    else if (c === '"') state = 'double';
    else if (c === '`') state = 'template';
    else if (c === '.' && code.startsWith('.get_by_', i)) return true;
  }
  return false;
}

/** Reads code's bytes or text, refusing more than MAX_PLAYWRIGHT_BYTES before anything is decoded. */
export function readPlaywrightCode(data: unknown, report: ImportReport): string | undefined {
  const error = (reason: string) => { report.items.push({ at: '', kind: 'error', what: WHAT, reason }); return undefined; };
  let text: string;
  if (typeof data === 'string') {
    // A string has no more UTF-16 units than UTF-8 bytes, so a long one is refused without measuring it.
    if (data.length > MAX_PLAYWRIGHT_BYTES || Buffer.byteLength(data, 'utf8') > MAX_PLAYWRIGHT_BYTES) return error(TOO_LARGE);
    text = data;
  } else if (data instanceof Uint8Array) {
    if (data.byteLength > MAX_PLAYWRIGHT_BYTES) return error(TOO_LARGE);
    text = new TextDecoder('utf-8').decode(data);
  } else return error(NOT_TEXT);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Playwright code (codegen's JavaScript or TypeScript) as import events, with what has no step equivalent added to
 * `report`:
 * - `page.goto(url)` gives goto; `<page><locator chain>.<action>(…)` gives click (dblclick converted), fill, select,
 *   check, enter (`press('Enter')`) or waitFor; the older `page.click(selector)` shapes too.
 * - `const p = page.waitForEvent('download' | 'popup')` marks the next click as a download or popup; `const p1 = await
 *   p` binds a popup's page, whose statements are followed from then on (the first page's are reported). The older
 *   `Promise.all([page.waitForEvent(…), …click()])` shape works the same way.
 * - `expect(locator).toBeVisible()` gives waitFor, `expect(page).toHaveURL(url)` and `page.waitForURL(url)` expectUrl.
 * - `import`, `require`, `test(…)` and the browser/context/page setup are ignored; a click right before typing into
 *   the same locator only focuses the field, and is dropped.
 * - Anything else is an `untranslated` item with its line. Python, Java and C#, an unterminated literal or comment, and
 *   code over the line or statement caps give an `error` item and no events.
 */
export function playwrightEvents(code: string, report: ImportReport): ImportEvent[] {
  const error = (reason: string, at = '') => { report.items.push({ at, kind: 'error', what: WHAT, reason }); return []; };
  if (code.length > MAX_PLAYWRIGHT_BYTES) return error(TOO_LARGE);
  if (otherTarget(code)) return error(IMPORT_UNSUPPORTED_TARGET);
  const lexed = lex(code);
  if ('error' in lexed) return error(lexed.error, `line ${lexed.line}`);
  const split = splitStatements(lexed.toks);
  if ('error' in split) return error(split.error);

  const events: ImportEvent[] = [];
  let reported = 0;
  let overflow = '';
  let overflowCount = 0;
  const item = (at: string, kind: ImportItem['kind'], what: string, reason: string) => {
    if (reported >= MAX_ITEMS) { if (!overflowCount) overflow = at; overflowCount++; return; }
    reported++;
    report.items.push({ at, kind, what, reason });
  };
  if (split.tests > 1) item(`line ${split.testLine}`, 'converted', 'Tests', `the code has ${split.tests} tests: their steps were imported one after another`);

  let active = 'page';
  const left = new Set<string>();
  const bindings = new Map<string, Binding>();
  /** The promise whose event the next click starts. */
  let marking: Promised | undefined;
  let lastField = '';

  const click = (at: string, b: Built) => {
    const e: Extract<ImportEvent, { kind: 'click' }> = { at, kind: 'click', target: targetOf(b), label: b.label };
    if (marking) { if (marking.kind === 'download') e.download = true; else e.popup = true; marking.clicked = true; marking = undefined; }
    events.push(e);
  };

  /** One action on a built locator. */
  const act = (at: string, b: Built, seg: Seg) => {
    const { name, args = [] } = seg;
    const what = describe(name, b);
    if (!seg.args) return item(at, 'untranslated', what, R.unknown);
    if (args.some((a) => a.k === 'regex')) return item(at, 'untranslated', what, R.pattern);
    if (!b.loc) return item(at, 'untranslated', what, R.frames);
    const value = (): string | undefined => strOf(args[0]);
    switch (name) {
      case 'click':
      case 'dblclick':
      case 'tap':
        if (args.length) return item(at, 'untranslated', what, R.options(name));
        if (name !== 'click') item(at, 'converted', what, `a ${name === 'tap' ? 'tap' : 'double click'} became a single click: check that one click does the same`);
        return click(at, b);
      case 'fill':
      case 'type':
      case 'pressSequentially': {
        const v = value();
        if (v === undefined || args.length > 2 || (args[1] !== undefined && !objOf(args[1]))) return item(at, 'untranslated', what, R.value);
        if (name !== 'fill') item(at, 'converted', what, 'typing key by key became one fill: check that the page accepts it');
        // The value goes to stripSecrets in this event and nowhere else: a credential's is dropped there.
        events.push({ at, kind: 'fill', target: targetOf(b), label: b.label, value: v, hints: b.hints });
        lastField = b.label;
        return;
      }
      case 'selectOption': {
        let v: Node | undefined = args[0];
        if (v?.k === 'arr' && v.items.length === 1) v = v.items[0];
        const props = objOf(v);
        const chosen = v?.k === 'str' ? v.v : props && props.size === 1 ? strOf(props.get('label') ?? props.get('value')) : undefined;
        if (chosen === undefined || args.length > 2) return item(at, 'untranslated', what, 'only one option, by its value or label, is imported');
        events.push({ at, kind: 'select', target: targetOf(b), label: b.label, value: chosen, hints: b.hints });
        lastField = b.label;
        return;
      }
      case 'check':
      case 'uncheck':
        if (args.length) return item(at, 'untranslated', what, R.options(name));
        events.push({ at, kind: 'check', target: targetOf(b), label: b.label, checked: name === 'check' });
        return;
      case 'setChecked': {
        const v = args[0];
        if (v?.k !== 'lit' || v.v === null || args.length > 1) return item(at, 'untranslated', what, R.value);
        events.push({ at, kind: 'check', target: targetOf(b), label: b.label, checked: v.v });
        return;
      }
      case 'press': {
        const key = value();
        if (key !== undefined && ENTER.has(key) && args.length === 1) { events.push({ at, kind: 'enter', label: b.label || lastField }); return; }
        return item(at, 'untranslated', key !== undefined && NAMED_KEYS.has(key) ? `Press ${key}` : 'Press a key', R.key);
      }
      case 'waitFor': {
        const props = objOf(args[0]);
        const extra = args.length > 1 || (args[0] !== undefined && !props);
        const state = props?.get('state');
        if (extra || (props && [...props.keys()].some((k) => k !== 'state' && k !== 'timeout')) || (state && strOf(state) !== 'visible')) {
          return item(at, 'untranslated', what, 'only a wait for a visible element is imported');
        }
        events.push({ at, kind: 'waitFor', target: targetOf(b), label: b.label });
        return;
      }
      case 'hover': return item(at, 'untranslated', what, R.hover);
      case 'setInputFiles': return item(at, 'untranslated', what, R.upload);
      default: return item(at, 'untranslated', what, R.method(name));
    }
  };

  /** A statement whose chain starts at a locator: on the page (`page.getBy…`) or a locator variable (`base`). */
  const locatorStatement = (at: string, segs: Seg[], base?: Built) => {
    const action = segs[segs.length - 1]?.name ?? '';
    const r = buildChain(segs, 0, base);
    if ('fail' in r) return item(at, 'untranslated', describe(action, r.built), r.fail);
    const rest = segs.slice(r.next);
    if (rest.length === 0) return item(at, 'untranslated', describe('', r.built), R.noAction);
    if (rest.length > 1) return item(at, 'untranslated', describe(action, r.built), R.method(rest[1].name));
    act(at, r.built, rest[0]);
  };

  /** A statement on the active page. */
  const pageStatement = (at: string, segs: Seg[], shape: string) => {
    const [first, second] = segs;
    if (!first) return item(at, 'untranslated', shape, R.unknown);
    const args = first.args ?? [];
    if (LOCATOR_METHODS.has(first.name)) return locatorStatement(at, segs);
    if (segs.length === 1 && first.args && LEGACY_ACTIONS.has(first.name)) {
      const sel = strOf(args[0]);
      const c = sel === undefined ? R.unknown : selectorCandidate(sel);
      const b: Built = { label: '', shown: sel ?? '', hints: sel ? [sel] : [] };
      if (typeof c === 'string') return item(at, 'untranslated', describe(first.name, b), args[0]?.k === 'regex' ? R.pattern : c);
      b.loc = c;
      b.label = 'text' in c ? c.text : 'testId' in c ? c.testId : '';
      b.shown = b.label || sel || '';
      return act(at, b, { name: first.name === 'waitForSelector' ? 'waitFor' : first.name, args: args.slice(1) });
    }
    switch (first.name) {
      case 'goto': {
        const url = strOf(args[0]);
        if (segs.length !== 1 || url === undefined || !url || args.length > 2) return item(at, 'untranslated', shape, args[0]?.k === 'regex' ? R.pattern : R.unknown);
        events.push({ at, kind: 'goto', url });
        return;
      }
      case 'waitForURL': {
        const url = strOf(args[0]);
        const path = url === undefined ? undefined : urlPath(url);
        if (segs.length !== 1 || !path) return item(at, 'untranslated', 'Wait for an address', args[0]?.k === 'regex' || url?.includes('*') ? R.pattern : R.unknown);
        events.push({ at, kind: 'expectUrl', path });
        return;
      }
      case 'keyboard': {
        const key = strOf(second?.args?.[0]);
        if (segs.length === 2 && second.name === 'press' && key !== undefined && ENTER.has(key)) { events.push({ at, kind: 'enter', label: lastField }); return; }
        return item(at, 'untranslated', second?.name === 'press' && key !== undefined && NAMED_KEYS.has(key) ? `Press ${key}` : 'Use the keyboard', R.key);
      }
      case 'close': return item(at, 'untranslated', 'Close the page', R.close);
      case 'setViewportSize': return item(at, 'dropped', 'Viewport change', R.viewport);
    }
    if (WAITS.has(first.name)) return item(at, 'dropped', shape, first.name === 'waitForFunction' ? R.javascript : R.wait);
    if (PAGE_JAVASCRIPT.has(first.name)) return item(at, 'untranslated', shape, R.javascript);
    if (HANDLERS.has(first.name)) return item(at, 'untranslated', shape, R.handler);
    if (first.name === 'waitForEvent') {
      const kind = strOf(args[0]);
      return item(at, 'untranslated', shape, kind === 'download' || kind === 'popup' ? R.bareEvent : R.event);
    }
    item(at, 'untranslated', shape, R.method(first.name));
  };

  /** `expect(target).<matcher>(…)`. */
  const expectation = (at: string, target: Node[], segs: Seg[], shape: string) => {
    if (target.length !== 1) return item(at, 'untranslated', shape, R.unknown);
    if (segs[0]?.name === 'not') return item(at, 'untranslated', shape, R.negative);
    const m = segs[0];
    if (segs.length !== 1 || !m.args) return item(at, 'untranslated', shape, R.unknown);
    const t = target[0];
    const tRoot = flatten(t).root;
    if (tRoot.k === 'id' && left.has(tRoot.v)) return item(at, 'untranslated', shape, R.firstTab);
    if (tRoot.k === 'id' && bindings.get(tRoot.v)?.kind === 'reassigned') return item(at, 'untranslated', shape, R.reassigned);
    if (t.k === 'id' && t.v === active) {
      if (m.name !== 'toHaveURL') return item(at, 'untranslated', 'Check the page', R.check);
      const url = strOf(m.args[0]);
      const path = url === undefined ? undefined : urlPath(url);
      if (!path) return item(at, 'untranslated', 'Check the address', m.args[0]?.k === 'regex' || url?.includes('*') ? R.pattern : R.unknown);
      events.push({ at, kind: 'expectUrl', path });
      return;
    }
    const { root, segs: tsegs } = flatten(t);
    const binding = root.k === 'id' ? bindings.get(root.v) : undefined;
    const onPage = root.k === 'id' && root.v === active && tsegs.length > 0;
    if (!onPage && binding?.kind !== 'locator') return item(at, 'untranslated', shape, R.unknown);
    const r = buildChain(tsegs, 0, binding?.kind === 'locator' ? binding.built : undefined);
    if ('fail' in r) return item(at, 'untranslated', describe(m.name, r.built), r.fail);
    if (r.next !== tsegs.length) return item(at, 'untranslated', describe(m.name, r.built), R.method(tsegs[r.next].name));
    const opts = objOf(m.args[0]);
    if (m.name !== 'toBeVisible' || m.args.length > 1 || (m.args.length === 1 && (!opts || [...opts.keys()].some((k) => k !== 'timeout')))) {
      return item(at, 'untranslated', `Check ${cleanLabel(r.built.shown) || 'the element'}`, R.check);
    }
    if (!r.built.loc) return item(at, 'untranslated', describe(m.name, r.built), R.frames);
    events.push({ at, kind: 'waitFor', target: targetOf(r.built), label: r.built.label });
  };

  /** `<page>.waitForEvent(kind)` as a promise, or the reason it is not imported. */
  const eventPromise = (node: Node): Promised | string | undefined => {
    const { root, segs } = flatten(node);
    if (root.k !== 'id' || segs.length !== 1 || segs[0].name !== 'waitForEvent') return undefined;
    const isPage = root.v === active;
    const isContext = bindings.get(root.v)?.kind === 'scaffold';
    if (!isPage && !isContext) return undefined;
    const kind = strOf(segs[0].args?.[0]);
    if (isPage && (kind === 'download' || kind === 'popup')) return { kind, clicked: false };
    if (isContext && kind === 'page') return { kind: 'popup', clicked: false };
    return R.event;
  };

  /** An awaited promise resolved into `name`: a popup's page becomes the page later statements follow. */
  const resolved = (at: string, promise: Promised, name: string | undefined) => {
    if (marking === promise) marking = undefined;
    if (!promise.clicked) return item(at, 'untranslated', promise.kind === 'download' ? 'Wait for a download' : 'Wait for a new tab', R.noClick);
    if (promise.kind === 'download') { if (name) bindings.set(name, { kind: 'download' }); return; }
    if (!name) return item(at, 'untranslated', 'Wait for a new tab', R.unknown);
    left.add(active);
    active = name;
    item(at, 'converted', 'Open a new tab', `the click opens a new tab and the steps continue in it: statements on ${cleanLabel(name)} follow it, statements on the first tab after this are not imported`);
  };

  /** Each statement, in order. */
  const statement = (st: Stmt) => {
    const at = `line ${st.line}`;
    const shape = shapeOf(st.toks);
    const head = st.toks[0];
    if (isId(head, 'import') && !isP(st.toks[1], '(')) return;
    if (st.toks.some((t) => t.interp)) return item(at, 'untranslated', shape, R.template);
    if (head.k === 'id' && CONTROL.has(head.v)) return item(at, 'untranslated', shape, R.control);
    if (st.toks.length === 1 && head.k === 'str') return; // 'use strict'
    if (head.k === 'id' && isP(st.toks[1], '=') && !isP(st.toks[2], '=') && !isP(st.toks[2], '>')) {
      // `name = …`: whatever the name held before, later uses cannot tell which value they get.
      if (head.v === active || left.has(head.v)) return item(at, 'untranslated', shape, R.reassigned);
      bindings.set(head.v, { kind: 'reassigned' });
      return item(at, 'untranslated', shape, R.reassigned);
    }
    const parsed = parseStatement(st.toks);
    if (!parsed) return item(at, 'untranslated', shape, unparsed(st.toks));
    const awaited = parsed.expr.k === 'await';
    const inner = parsed.expr.k === 'await' ? parsed.expr.e : parsed.expr;
    const { root, segs } = flatten(inner);
    const rootName = root.k === 'id' ? root.v : root.k === 'call' && root.callee.k === 'id' ? `${root.callee.v}()` : '';
    const binding = root.k === 'id' ? bindings.get(root.v) : undefined;

    if (parsed.names) {
      const name = parsed.names[0];
      if (rootName === 'require()' || rootName === 'import()') return;
      if (root.k === 'id' && segs.length > 0 && SCAFFOLD.has(segs[segs.length - 1].name)) { if (name) bindings.set(name, { kind: 'scaffold' }); return; }
      if (root.k === 'id' && segs.length === 1 && segs[0].name === 'newPage' && name) {
        if (events.length === 0 && left.size === 0) { active = name; return; }
        left.add(name);
        return item(at, 'untranslated', 'Open a new tab', R.newTab);
      }
      const promise = eventPromise(inner);
      if (typeof promise === 'string') return item(at, 'untranslated', shape, promise);
      if (promise) {
        if (awaited) return item(at, 'untranslated', shape, R.noClick);
        if (name) bindings.set(name, { kind: 'promise', promise });
        marking = promise;
        return;
      }
      if (awaited && binding?.kind === 'promise' && segs.length === 0 && !parsed.destructured) return resolved(at, binding.promise, name);
      if (awaited && rootName === 'Promise' && segs.length === 1 && segs[0].name === 'all' && segs[0].args?.length === 1 && segs[0].args[0].k === 'arr') {
        const items = segs[0].args[0].items;
        const promises: { promise: Promised; index: number }[] = [];
        items.forEach((node, index) => {
          const p = eventPromise(node);
          if (p && typeof p !== 'string') promises.push({ promise: p, index });
        });
        if (promises.length !== 1) return item(at, 'untranslated', shape, promises.length ? 'only one event per Promise.all is imported' : R.unknown);
        marking = promises[0].promise;
        for (const node of items) {
          if (eventPromise(node)) continue;
          const e = node.k === 'await' ? node.e : node;
          const line = flatten(e).root.line;
          expression(line ? `line ${line}` : at, e, shape);
        }
        const { promise, index } = promises[0];
        return resolved(at, promise, parsed.destructured === 'arr' ? parsed.names[index] || undefined : undefined);
      }
      if (!awaited && name && !parsed.destructured && ((root.k === 'id' && root.v === active && segs.length > 0) || binding?.kind === 'locator')) {
        const r = buildChain(segs, 0, binding?.kind === 'locator' ? binding.built : undefined);
        if ('fail' in r) return item(at, 'untranslated', describe('', r.built), r.fail);
        if (r.next !== segs.length) return item(at, 'untranslated', shape, R.unknown);
        bindings.set(name, { kind: 'locator', built: r.built });
        return;
      }
      return item(at, 'untranslated', shape, R.unknown);
    }
    expression(at, inner, shape);
  };

  /** An expression statement (after any `await`). */
  const expression = (at: string, inner: Node, shape: string) => {
    const { root, segs } = flatten(inner);
    const binding = root.k === 'id' ? bindings.get(root.v) : undefined;
    if (root.k === 'call' && root.callee.k === 'id' && root.callee.v === 'expect') return expectation(at, root.args, segs, shape);
    if (root.k === 'id' && root.v === 'test') return item(at, 'untranslated', shape, R.test);
    if (root.k === 'id' && root.v === active) return pageStatement(at, segs, shape);
    if (root.k === 'id' && left.has(root.v)) {
      const action = segs[segs.length - 1]?.name ?? '';
      const r = LOCATOR_METHODS.has(segs[0]?.name ?? '') ? buildChain(segs, 0) : undefined;
      return item(at, 'untranslated', r ? describe(action, r.built) : shape, R.firstTab);
    }
    if (binding?.kind === 'locator') return locatorStatement(at, segs, binding.built);
    if (binding?.kind === 'reassigned') return item(at, 'untranslated', shape, R.reassigned);
    if (binding?.kind === 'download') return item(at, 'dropped', 'Save the download', R.saved);
    if (binding?.kind === 'scaffold') {
      if (segs.length === 1 && segs[0].name === 'close') return;
      return item(at, 'untranslated', shape, R.unknown);
    }
    item(at, 'untranslated', shape, R.unknown);
  };

  for (const st of split.stmts) statement(st);
  if (overflowCount) report.items.push({ at: overflow, kind: 'untranslated', what: `${overflowCount} more statements`, reason: 'they were not imported either; only the first 200 are listed' });

  // A click right before typing into or choosing in the same locator only focuses the field (codegen records one).
  const out: ImportEvent[] = [];
  let focus = 0;
  let focusAt = '';
  events.forEach((e, i) => {
    const next = events[i + 1];
    if (e.kind === 'click' && !e.download && !e.popup && next && (next.kind === 'fill' || next.kind === 'select')
      && JSON.stringify(next.target) === JSON.stringify(e.target)) {
      if (!focus) focusAt = e.at;
      focus++;
      return;
    }
    out.push(e);
  });
  if (focus) report.items.push({ at: focusAt, kind: 'dropped', what: `Clicks into a field before typing (${focus})`, reason: 'typing into a field focuses it, so the click before it is not needed' });
  return out;
}
