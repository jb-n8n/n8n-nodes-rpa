import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectImportSource } from '../src/index.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/import/${name}`, import.meta.url));

describe('detectImportSource: the import source from the file name, else from what the file holds', () => {
  it('names: a recording, a UiPath project or workflow, Playwright code', () => {
    expect(detectImportSource('erp.rpa-recording.json', fixture('recording-erp/erp.rpa-recording.json'))).toBe('recording');
    expect(detectImportSource('ERP.RPA-RECORDING.JSON', '{}')).toBe('recording');
    expect(detectImportSource('project.zip', Buffer.from('PK\u0003\u0004'))).toBe('uipath');
    expect(detectImportSource('Main.xaml', '<Activity/>')).toBe('uipath');
    expect(detectImportSource('export.spec.ts', fixture('playwright-sap-export.ts.txt'))).toBe('playwright');
    for (const name of ['a.js', 'a.mjs', 'a.cjs', 'a.ts']) expect(detectImportSource(name, ''), name).toBe('playwright');
  });

  it('JSON by its shape: an RPA recording, a Chrome Recorder export, a step document (browser or desktop)', () => {
    const rec = fixture('recording-erp/erp.rpa-recording.json');
    expect(detectImportSource('upload.json', rec)).toBe('recording');
    expect(detectImportSource('', rec.toString('utf8'))).toBe('recording');
    expect(detectImportSource('chrome.json', fixture('chrome-sap-export.json'))).toBe('chrome');
    expect(detectImportSource('steps.json', JSON.stringify({ startUrl: 'https://example.com/', steps: [{ intent: 'Open', goto: '/' }] }))).toBe('steps');
    expect(detectImportSource('steps.json', JSON.stringify([{ intent: 'Open', goto: 'https://example.com/' }]))).toBe('steps');
    expect(detectImportSource('desk.json', JSON.stringify({ surface: 'desktop', app: { exe: 'App.exe' }, steps: [] }))).toBe('steps');
    // A byte order mark is ignored, as the importers do.
    expect(detectImportSource('chrome.json', `﻿${fixture('chrome-sap-export.json').toString('utf8')}`)).toBe('chrome');
  });

  it('a ZIP without its extension, by its first bytes', () => {
    expect(detectImportSource('upload', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe('uipath');
  });

  it('cannot tell: undefined, and nothing is evaluated or thrown', () => {
    expect(detectImportSource('notes.txt', 'hello')).toBeUndefined();
    expect(detectImportSource('x.json', '{ not json')).toBeUndefined();
    expect(detectImportSource('x.json', '{"a":1}')).toBeUndefined();
    expect(detectImportSource('x.json', '[1,2]')).toBeUndefined();
    expect(detectImportSource('x.json', JSON.stringify({ steps: [{ type: 'click' }, { intent: 'Open' }] }))).toBeUndefined();
    expect(detectImportSource('x.json', 'null')).toBeUndefined();
    expect(detectImportSource(undefined, Buffer.alloc(0))).toBeUndefined();
  });
});
