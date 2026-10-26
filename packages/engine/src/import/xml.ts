/**
 * A small bounded XML reader for imported files (UiPath XAML, Object Repository content). It scans forward once with
 * indexOf and character loops, never backtracks, never expands entities beyond the five predefined ones and character
 * references, and refuses any DOCTYPE. Depth and element count are capped.
 */

/** An element: its qualified name (any namespace prefix kept), its attributes, child elements and own character data. */
export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };

export interface XmlCaps { maxDepth?: number; maxElements?: number }

const DEFAULT_DEPTH = 200;
const DEFAULT_ELEMENTS = 200_000;

class XmlError extends Error {}
function fail(message: string): never { throw new XmlError(message); }

/** A name for a message, cut to 100 characters. */
const short = (name: string): string => (name.length > 100 ? `${name.slice(0, 100)}…` : name);

const NAMED: readonly (readonly [string, string])[] = [['lt;', '<'], ['gt;', '>'], ['amp;', '&'], ['quot;', '"'], ['apos;', "'"]];

const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
/** XML 1.0 Char: a code point a character reference may name. */
const isXmlChar = (c: number) =>
  c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);

/**
 * The reference starting after the "&" at `j` and ending before `to`: `#x` hex digits, `#` decimal digits, or one of the
 * five entity names, then ";". `code` is set for character references; undefined when nothing matches.
 */
function reference(s: string, j: number, to: number): { end: number; text?: string; code?: number } | undefined {
  if (s.charCodeAt(j) === 35) {
    let k = j + 1;
    const hex = s.charCodeAt(k) === 120;
    if (hex) k++;
    const digits = k;
    while (k < to && (hex ? isHex(s.charCodeAt(k)) : isDigit(s.charCodeAt(k)))) k++;
    if (k === digits || k >= to || s.charCodeAt(k) !== 59) return undefined;
    return { end: k + 1, code: parseInt(s.slice(digits, k), hex ? 16 : 10) };
  }
  for (const [name, text] of NAMED) if (j + name.length <= to && s.startsWith(name, j)) return { end: j + name.length, text };
  return undefined;
}

const LENIENT = 0;
const TEXT = 1;
const ATTR = 2;

/**
 * Decodes s[from, to). LENIENT (unescapeXml) leaves anything that is not a reference as it is and turns a reference to
 * a code point outside Unicode into "". TEXT and ATTR (parseXml) fail on a bare "&", an unknown entity or a reference to
 * a character XML does not allow, and normalise line ends: "\r\n" and "\r" become "\n" in text; in attribute values
 * literal tabs, line feeds and carriage returns become spaces ("\r\n" one space), as an XML processor does.
 */
function decode(s: string, from: number, to: number, mode: number): string {
  let out = '';
  let last = from;
  for (let k = from; k < to; k++) {
    const c = s.charCodeAt(k);
    if (c === 38) {
      const r = reference(s, k + 1, to);
      if (r === undefined) {
        if (mode === LENIENT) continue;
        fail(s.charCodeAt(k + 1) === 35 ? 'a malformed character reference' : 'an unknown entity or a bare "&" (write it as &amp;)');
      }
      let value = r.text ?? '';
      if (r.code !== undefined) {
        if (mode === LENIENT) {
          try { value = String.fromCodePoint(r.code); } catch { value = ''; }
        } else {
          if (!isXmlChar(r.code)) fail('a character reference to a character XML does not allow');
          value = String.fromCodePoint(r.code);
        }
      }
      out += s.slice(last, k) + value;
      last = r.end;
      k = r.end - 1;
    } else if (mode !== LENIENT && (c === 13 || (mode === ATTR && (c === 9 || c === 10)))) {
      out += s.slice(last, k) + (mode === ATTR ? ' ' : '\n');
      if (c === 13 && k + 1 < to && s.charCodeAt(k + 1) === 10) k++;
      last = k + 1;
    }
  }
  return out + s.slice(last, to);
}

/**
 * Decodes the five XML entities and character references (`&#65;`, `&#x41;`). Anything else is left as it is; a reference
 * to a code point outside Unicode becomes "". Linear.
 */
export function unescapeXml(s: string): string {
  return decode(s, 0, s.length, LENIENT);
}

/** Ends a name: whitespace, "/", ">", "=", quotes or "<". */
const endsName = (c: number) => isSpace(c) || c === 47 || c === 62 || c === 61 || c === 34 || c === 39 || c === 60;

/**
 * Parses one XML document into its root element. Elements, attributes (single or double quoted, references decoded) and
 * self-closing tags are read; namespace prefixes stay in names; comments, the declaration and processing instructions are
 * skipped; CDATA is character data taken verbatim. A DOCTYPE or other markup declaration, a mismatched or missing closing
 * tag, a duplicate attribute, "<" in an attribute value, text outside the root, an invalid reference, more than
 * `maxDepth` (200) levels or more than `maxElements` (200,000) elements is an error. Never throws.
 */
export function parseXml(text: string, caps: XmlCaps = {}): XmlNode | { error: string } {
  try {
    return parse(text, caps.maxDepth ?? DEFAULT_DEPTH, caps.maxElements ?? DEFAULT_ELEMENTS);
  } catch (e) {
    return { error: e instanceof XmlError ? e.message : 'the XML cannot be read' };
  }
}

function parse(s: string, maxDepth: number, maxElements: number): XmlNode {
  const n = s.length;
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let elements = 0;

  const addText = (value: string | null, from: number, to: number) => {
    const top = stack[stack.length - 1];
    if (top) { top.text += value ?? decode(s, from, to, TEXT); return; }
    if (value !== null) fail('text outside the root element');
    for (let k = from; k < to; k++) if (!isSpace(s.charCodeAt(k))) fail('text outside the root element');
  };
  const skipSpace = (k: number) => { while (k < n && isSpace(s.charCodeAt(k))) k++; return k; };
  const scanName = (k: number) => { while (k < n && !endsName(s.charCodeAt(k))) k++; return k; };

  let pos = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (pos < n) {
    const lt = s.indexOf('<', pos);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > pos) addText(null, pos, textEnd);
    if (lt < 0) break;
    const next = s.charCodeAt(lt + 1);

    if (next === 63) { // <?
      const close = s.indexOf('?>', lt + 2);
      if (close < 0) fail('unterminated processing instruction');
      pos = close + 2;
      continue;
    }
    if (next === 33) { // <!
      if (s.startsWith('<!--', lt)) {
        const close = s.indexOf('-->', lt + 4);
        if (close < 0) fail('unterminated comment');
        pos = close + 3;
      } else if (s.startsWith('<![CDATA[', lt)) {
        const close = s.indexOf(']]>', lt + 9);
        if (close < 0) fail('unterminated CDATA section');
        addText(s.slice(lt + 9, close), 0, 0);
        pos = close + 3;
      } else if (s.startsWith('<!DOCTYPE', lt)) {
        fail('a DOCTYPE is not allowed');
      } else {
        fail('markup declarations are not allowed');
      }
      continue;
    }

    if (next === 47) { // </name>
      const nameEnd = scanName(lt + 2);
      const name = s.slice(lt + 2, nameEnd);
      const gt = skipSpace(nameEnd);
      if (gt >= n) fail('unterminated tag');
      if (name === '' || s.charCodeAt(gt) !== 62) fail('malformed closing tag');
      const top = stack.pop();
      if (top === undefined) fail(`</${short(name)}> has no open element`);
      if (top.name !== name) fail(`</${short(name)}> does not close <${short(top.name)}>`);
      pos = gt + 1;
      continue;
    }

    // <name attr="value" ...> or <name ... />
    const nameEnd = scanName(lt + 1);
    if (nameEnd >= n) fail('unterminated tag');
    const name = s.slice(lt + 1, nameEnd);
    if (name === '') fail('malformed tag');
    if (root !== undefined && stack.length === 0) fail('more than one root element');
    if (++elements > maxElements) fail(`the XML has more than ${maxElements} elements`);
    if (stack.length + 1 > maxDepth) fail(`the XML is nested deeper than ${maxDepth} elements`);
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    let i = nameEnd;
    let selfClosing = false;
    for (;;) {
      const spaced = i;
      i = skipSpace(i);
      if (i >= n) fail('unterminated tag');
      const c = s.charCodeAt(i);
      if (c === 62) { i++; break; }
      if (c === 47) {
        if (i + 1 >= n) fail('unterminated tag');
        if (s.charCodeAt(i + 1) !== 62) fail('malformed tag');
        selfClosing = true;
        i += 2;
        break;
      }
      if (i === spaced) fail('malformed tag');
      const keyEnd = scanName(i);
      if (keyEnd === i) fail('malformed tag');
      const key = s.slice(i, keyEnd);
      i = skipSpace(keyEnd);
      if (i >= n) fail('unterminated tag');
      if (s.charCodeAt(i) !== 61) fail(`attribute ${short(key)} has no quoted value`);
      i = skipSpace(i + 1);
      if (i >= n) fail('unterminated tag');
      const quote = s[i];
      if (quote !== '"' && quote !== "'") fail(`attribute ${short(key)} has no quoted value`);
      const close = s.indexOf(quote, i + 1);
      if (close < 0) fail('unterminated tag');
      for (let k = i + 1; k < close; k++) if (s.charCodeAt(k) === 60) fail(`"<" in the value of attribute ${short(key)}`);
      if (key in attrs) fail(`attribute ${short(key)} appears twice`);
      attrs[key] = decode(s, i + 1, close, ATTR);
      i = close + 1;
    }
    const element: XmlNode = { name, attrs, children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else root = element;
    if (!selfClosing) stack.push(element);
    pos = i;
  }
  if (stack.length > 0) fail(`<${short(stack[stack.length - 1].name)}> is not closed`);
  if (root === undefined) fail('no root element');
  return root;
}
