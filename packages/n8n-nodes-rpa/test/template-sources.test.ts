// The templates' long expressions are written in template-src/ and folded into templates/*.json by
// scripts/build-templates.mjs. These tests hold the two together: the JSON n8n loads is what the source files fold to.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, fold, LONG, longParameters, parameterAt, readSnippets, readSources, SOURCES, TEMPLATES, type Workflow } from '../scripts/build-templates.mjs';

const FIX = 'edit the source file in template-src/ (not the template JSON), then run `pnpm --filter n8n-nodes-rpa templates`';
const sources = readSources();
const shown = (file: string) => relative(join(SOURCES, '..'), file);
// Template 5 so far; the others follow.
const templates = readdirSync(TEMPLATES).filter((f) => f === '5-import-a-bot.json');
const workflow = (template: string) => JSON.parse(readFileSync(join(TEMPLATES, template), 'utf8')) as Workflow;

describe('the fold rule', () => {
  it('folds only inside {{ … }}: comment lines dropped, line breaks one space, none after ( or [ or before ) or ]', () => {
    const text = 'Text\n  outside {{\n  f(\n    // a comment\n    a,\n\n    [b]\n  )\n}} stays.';
    expect(fold(text)).toBe('Text\n  outside {{ f(a, [b]) }} stays.');
  });

  it('puts a piece of snippets.js in place of its name, inside {{ … }} only', () => {
    const pieces = new Map([['ESCAPE', '(s) => s'], ['TWICE', '[ESCAPE, ESCAPE]']]);
    expect(fold('ESCAPE {{ (ESCAPE)(x) + TWICE }}', pieces)).toBe('ESCAPE {{ ((s) => s)(x) + [(s) => s, (s) => s] }}');
  });
});

describe('template-src: the long expressions of the templates', () => {
  it.each(sources.map((s) => [shown(s.file), s] as const))('%s folds to its parameter in the template', (_, s) => {
    const actual = parameterAt(workflow(s.template), s.node, s.parameter);
    expect(actual, `templates/${s.template}, node "${s.node}", parameter ${s.parameter} differs from ${shown(s.file)}: ${FIX}`).toBe(s.text);
  });

  it.each(templates)('every parameter of %s over 300 characters that holds {{ … }} has a source file', (template) => {
    expect(LONG).toBe(300);
    const missing = longParameters(workflow(template))
      .filter((p) => !sources.some((s) => s.template === template && s.node === p.node && s.parameter === p.parameter))
      .map((p) => `"${p.node}" ${p.parameter}`);
    expect(missing, `give each a source file in template-src/${template.replace(/\.json$/, '')}/, then run \`pnpm --filter n8n-nodes-rpa templates\``).toEqual([]);
  });

  it('the build changes no byte of a template', () => {
    for (const { template, before, after } of build(sources)) expect(after === before, `templates/${template}: ${FIX}`).toBe(true);
  });

  it('a changed source replaces only its own JSON string', () => {
    const s = sources.find((x) => x.template === '5-import-a-bot.json' && x.node === 'Review and approve' && x.parameter === 'jsonOutput');
    if (!s) throw new Error('no source file for Review and approve');
    const [{ before, after }] = build([{ ...s, text: `${s.text} ` }]);
    expect(after).toBe(before.replace(JSON.stringify(s.text), () => JSON.stringify(`${s.text} `)));
    expect(parameterAt(JSON.parse(after) as Workflow, s.node, s.parameter)).toBe(`${s.text} `);
  });

  it('every piece of snippets.js is used', () => {
    const pieces = readSnippets();
    const code = (file: string) => readFileSync(file, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    const texts = [...sources.map((s) => code(s.file)), ...pieces.values()];
    expect([...pieces.keys()].filter((name) => !texts.some((t) => new RegExp(`\\b${name}\\b`).test(t)))).toEqual([]);
  });
});
