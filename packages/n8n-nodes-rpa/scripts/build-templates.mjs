// Writes the templates' long expressions from their readable source files: `pnpm --filter n8n-nodes-rpa templates`.
//
// templates/*.json stay the files n8n loads and the source of everything else (nodes, positions, notes, stickies). Each
// parameter over 300 characters that holds {{ … }} has a source file in template-src/<template>/. This script folds
// each source file and puts the result in place of that one JSON string in the template's text, so no other byte of
// the file changes. On a clean checkout it changes nothing. test/template-sources.test.ts checks that every source file
// folds to its parameter and that every long parameter has a source file.
//
// A source file starts with a header of // lines, two of which name the parameter (`// Node: <node name>` and
// `// Parameter: <path in the node's parameters>`, such as options.formTitle or conditions.conditions[0].leftValue),
// then one empty line. The rest, less the file's last line break, is the parameter's text. Outside {{ … }} it is the
// text as written, line breaks included: nothing is folded or dropped there.
//
// The fold rule, applied only inside {{ … }} (a block runs from {{ to the first }} after it, as in n8n):
//   1. a line whose text starts with // is a comment: it is dropped, with the line break before it;
//   2. every line break, with the spaces and tabs around it (and any empty lines), becomes one space, or nothing when
//      the line before ends in ( or [ or the line after starts with ) or ].
// So a comment sits on a line of its own, inside a block, and holds no {{ or }}.
//
// Shared pieces: template-src/snippets.js holds each piece once, as a line `const NAME =` followed by the piece on
// indented lines, the last of which ends in a `;` that is not part of the piece. A piece folds by the same rule (its
// lines are joined as inside a block, without the spaces at either end). Inside a block of a source file, or inside
// another piece, NAME as a whole word stands for the piece's folded text.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATES = join(ROOT, 'templates');
export const SOURCES = join(ROOT, 'template-src');
/** The length over which a parameter that holds {{ … }} has a source file. */
export const LONG = 300;

const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/** Folds the inside of one {{ … }} block (see the rule above). */
function foldBlock(inner) {
  return inner
    .replace(/\n[ \t]*\/\/[^\n]*(?=\n)/g, '')
    .replace(/[ \t]*\n\s*/g, (gap, at, all) => ('(['.includes(all[at - 1]) || ')]'.includes(all[at + gap.length]) ? '' : ' '));
}

/** The shared pieces of template-src/snippets.js, by name, each folded but not yet expanded. */
export function readSnippets(file = join(SOURCES, 'snippets.js')) {
  const lines = read(file).split('\n');
  const pieces = new Map();
  for (let i = 0; i < lines.length; i++) {
    const head = /^const ([A-Z][A-Z0-9_]*) =$/.exec(lines[i]);
    if (!head) {
      if (lines[i] !== '' && !lines[i].startsWith('//')) throw new Error(`${file}:${i + 1}: expected a // comment, an empty line or "const NAME ="`);
      continue;
    }
    const body = [];
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) body.push(lines[++i]);
    if (!body.length || !body[body.length - 1].endsWith(';')) throw new Error(`${file}: ${head[1]} must end in ";" on its last indented line`);
    if (pieces.has(head[1])) throw new Error(`${file}: ${head[1]} is defined twice`);
    body[body.length - 1] = body[body.length - 1].slice(0, -1);
    pieces.set(head[1], foldBlock(`\n${body.join('\n')}\n`).trim());
  }
  return pieces;
}

/** Replaces each piece's name (a whole word) with its text, the names inside a piece too. */
function expander(pieces) {
  if (!pieces.size) return (text) => text;
  const names = new RegExp(`\\b(?:${[...pieces.keys()].sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');
  const expand = (text, within = []) => text.replace(names, (name) => {
    if (within.includes(name)) throw new Error(`snippet ${name} holds itself (${[...within, name].join(' → ')})`);
    return expand(pieces.get(name), [...within, name]);
  });
  return expand;
}

/** Folds a source file's text (the part after its header): every {{ … }} block folded and its names expanded. */
export function fold(text, pieces = new Map()) {
  const expand = expander(pieces);
  return text.replace(/\{\{([\s\S]*?)\}\}/g, (_, inner) => `{{${expand(foldBlock(inner))}}}`);
}

/** One source file: which parameter it is, and the parameter's text it folds to. */
export function readSource(file, pieces = readSnippets()) {
  const all = read(file);
  const end = all.indexOf('\n\n');
  const header = end < 0 ? [] : all.slice(0, end).split('\n');
  if (!header.length || !header.every((l) => l.startsWith('//'))) throw new Error(`${file}: expected a header of // lines, then one empty line`);
  const field = (name) => header.map((l) => new RegExp(`^// ${name}: (.+)$`).exec(l)?.[1]).find((v) => v !== undefined);
  const node = field('Node');
  const parameter = field('Parameter');
  if (!node || !parameter) throw new Error(`${file}: the header names no Node or no Parameter`);
  if (!all.endsWith('\n')) throw new Error(`${file}: expected a line break at the end`);
  return { file, node, parameter, text: fold(all.slice(end + 2, -1), pieces) };
}

/** Every source file, with the template it belongs to (template-src/<name>/ for templates/<name>.json). */
export function readSources() {
  const pieces = readSnippets();
  return readdirSync(SOURCES, { withFileTypes: true }).filter((d) => d.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((d) =>
    readdirSync(join(SOURCES, d.name)).filter((f) => f.endsWith('.js')).sort().map((f) => ({ template: `${d.name}.json`, ...readSource(join(SOURCES, d.name, f), pieces) })));
}

const pathOf = (parameter) => parameter.split(/\.|(?=\[)/).map((k) => (/^\[\d+\]$/.test(k) ? Number(k.slice(1, -1)) : k));

/** A node's parameter by its path (options.formTitle, conditions.conditions[0].leftValue). */
export function parameterAt(workflow, node, parameter) {
  const n = workflow.nodes.find((x) => x.name === node);
  if (!n) return undefined;
  return pathOf(parameter).reduce((v, k) => (v === null || typeof v !== 'object' ? undefined : v[k]), n.parameters);
}

/** Every parameter of a workflow over LONG characters that holds {{ … }}, by node and path. */
export function longParameters(workflow) {
  const found = [];
  const walk = (v, path, node) => {
    if (typeof v === 'string') {
      if (v.length > LONG && v.includes('{{')) found.push({ node, parameter: path });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, node));
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, node);
  };
  for (const n of workflow.nodes) walk(n.parameters, '', n.name);
  return found;
}

/** Each template that has source files: its text now, and its text with every folded source written in. */
export function build(sources = readSources()) {
  const seen = new Set();
  return [...new Set(sources.map((s) => s.template))].map((template) => {
    const file = join(TEMPLATES, template);
    const before = readFileSync(file, 'utf8');
    const workflow = JSON.parse(before);
    let after = before;
    for (const s of sources.filter((x) => x.template === template)) {
      const key = `${template}\u0000${s.node}\u0000${s.parameter}`;
      if (seen.has(key)) throw new Error(`${s.file}: a second source file for "${s.node}" ${s.parameter}`);
      seen.add(key);
      const old = parameterAt(workflow, s.node, s.parameter);
      if (typeof old !== 'string') throw new Error(`${s.file}: templates/${template} has no text parameter ${s.parameter} on a node "${s.node}"`);
      if (old === s.text) continue;
      const needle = JSON.stringify(old);
      const count = after.split(needle).length - 1;
      if (count !== 1) throw new Error(`${s.file}: the parameter's JSON string appears ${count} times in templates/${template}, not once`);
      after = after.replace(needle, () => JSON.stringify(s.text));
    }
    return { template, file, before, after };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const { template, file, before, after } of build()) {
    if (after === before) {
      console.log(`templates/${template}: unchanged`);
    } else {
      writeFileSync(file, after);
      console.log(`templates/${template}: written`);
    }
  }
}
