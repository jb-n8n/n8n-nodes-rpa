// The first-day templates: hello world and the connection check.
import { describe, expect, it } from 'vitest';
import { USE_CASE_WORDS } from 'n8n-rpa-engine';
import { toLocator } from '../nodes/Playwright/operations/quick.js';
import { COLOUR, NODE_TYPE, STICKY, byName, load, loadInN8n, sticky, targets } from './template-harness.js';

describe('hello-world.json', () => {
  const t = load('hello-world.json');
  it('is named, has exactly four nodes (three working nodes and one sticky) and the right names', () => {
    expect(t.name).toBe('RPA: Hello world');
    expect(t.nodes.map((n) => n.name).sort()).toEqual(
      ['Before you click Execute', 'Click Execute', 'Extract the sandbox table', 'Screenshot example.com'],
    );
    expect(t.nodes.filter((n) => n.type !== STICKY)).toHaveLength(3);
  });
  it('runs Manual Trigger -> Screenshot -> Extract Data in a line', () => {
    expect(byName(t, 'Click Execute').type).toBe('n8n-nodes-base.manualTrigger');
    expect(targets(t, 'Click Execute')).toEqual([['Screenshot example.com']]);
    expect(targets(t, 'Screenshot example.com')).toEqual([['Extract the sandbox table']]);
    expect(targets(t, 'Extract the sandbox table')).toEqual([]);
  });
  it('screenshots a public site with private networks off', () => {
    const n = byName(t, 'Screenshot example.com');
    expect(n.type).toBe(NODE_TYPE);
    expect(n.parameters).toEqual({ operation: 'screenshot', url: 'https://example.com' });
  });
  it('extracts the sandbox table by CSS with Allow Private Network on, and only there', () => {
    const n = byName(t, 'Extract the sandbox table');
    expect(n.type).toBe(NODE_TYPE);
    expect(n.parameters).toMatchObject({
      operation: 'extract', url: 'http://sandbox:8080/public/table', shape: 'table', options: { allowPrivateNetwork: true },
    });
    const tableParam = n.parameters.table as { locator: Parameters<typeof toLocator>[0] };
    expect(toLocator(tableParam.locator, 'Table')).toEqual({ css: 'table.results' });
    expect(Object.keys(n.parameters.options as object)).toEqual(['allowPrivateNetwork']);
    expect(Object.keys(n.parameters).sort()).toEqual(['operation', 'options', 'shape', 'table', 'url']);
  });
  it('has a green sticky that starts with the credential instruction and explains the private-network switch', () => {
    const s = byName(t, 'Before you click Execute');
    expect(s.type).toBe(STICKY);
    const content = String(s.parameters.content);
    expect(content.replace(/^#+ .*\n/, '').startsWith('Set the RPA Browser credential, then click Execute.')).toBe(true);
    expect(content).toContain('Allow Private Network');
    expect(content).toContain('docker compose up -d browser');
    expect(s.parameters.color).toBe(COLOUR.green);
  });
  it('carries no credentials, no secrets and no use-case words', () => {
    const text = JSON.stringify(t);
    expect(text).not.toMatch(/"credentials"|"password"|"secretKey"|"token"/);
    expect(text).not.toMatch(USE_CASE_WORDS);
  });
});

describe('0-connection-check.json (the first-day connection check)', () => {
  const t = load('0-connection-check.json');
  it('has three working nodes and one sticky with the right names', () => {
    expect(t.nodes.map((n) => n.name).sort()).toEqual(['Check the connection', 'Click Execute', 'Screenshot the site', 'Site to check']);
    expect(t.nodes.filter((n) => n.type !== STICKY)).toHaveLength(3);
  });
  it('runs Manual Trigger -> Set "Site to check" -> Screenshot in a line', () => {
    expect(byName(t, 'Click Execute').type).toBe('n8n-nodes-base.manualTrigger');
    expect(targets(t, 'Click Execute')).toEqual([['Site to check']]);
    expect(targets(t, 'Site to check')).toEqual([['Screenshot the site']]);
    expect(targets(t, 'Screenshot the site')).toEqual([]);
  });
  it('sets one url field, a public placeholder the user replaces', () => {
    const n = byName(t, 'Site to check');
    expect(n.type).toBe('n8n-nodes-base.set');
    expect(n.typeVersion).toBe(3.4);
    const p = n.parameters as { assignments: { assignments: { name: string; value: string; type: string }[] }; options: object };
    expect(p.assignments.assignments.map(({ name, value, type }) => ({ name, value, type }))).toEqual([{ name: 'url', value: 'https://example.com', type: 'string' }]);
  });
  it('screenshots the url from Site to check with the quick operation, private networks off, no credential picked', () => {
    const n = byName(t, 'Screenshot the site');
    expect(n.type).toBe(NODE_TYPE);
    expect(n.typeVersion).toBe(2);
    expect(n.parameters).toEqual({ operation: 'screenshot', url: "={{ $('Site to check').item.json.url }}" });
    expect(loadInN8n(n).parameters).toMatchObject({ operation: 'screenshot' });
  });
  it('has a green sticky: pick the credential, replace the URL with your login page, run it, see the screenshot', () => {
    const s = sticky(t, 'Check the connection');
    expect(s.color).toBe(COLOUR.green);
    for (const text of ['**RPA Browser**', '**Site to check**', 'login page', 'Execute', 'screenshot', '**Options → Allow Private Network**', 'browser_unavailable']) {
      expect(s.content, text).toContain(text);
    }
  });
});
