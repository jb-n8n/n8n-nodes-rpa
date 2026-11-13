// The sample bots the browser guide tells a person to upload (docs/samples). The review page builds a sentence from
// each step and puts the step's own description beside it, in brackets, only when the description says something else.
// The samples' descriptions are those sentences, so an ordinary sample shows no brackets and a misleading description
// stands out. These tests fail when a sample's step would show brackets on the review page.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shownUrl } from 'n8n-rpa-engine';
import { reviewSteps } from '../nodes/Playwright/format.js';

const DIR = new URL('../../../docs/samples/', import.meta.url);
const SAMPLES = readdirSync(DIR).filter((f) => f.endsWith('.steps.json')).sort();

type Step = { intent?: string; paginate?: { each?: Step[] } };
type Shown = { text: string; describedAs?: string; each?: Shown[] };

const stepsOf = (file: string) => (JSON.parse(readFileSync(new URL(file, DIR), 'utf8')) as { steps: Step[] }).steps;
const shown = (steps: Step[]) => reviewSteps(steps, { desktop: false, shownUrl }) as Shown[];

/** Each step's description beside the sentence the review page shows for it, paginate bodies included. */
function pairs(steps: Step[], seen: Shown[], at = ''): { at: string; intent: string | undefined; text: string; describedAs: string | undefined }[] {
  return steps.flatMap((s, i) => [
    { at: `${at}step ${i + 1}`, intent: s.intent, text: seen[i].text, describedAs: seen[i].describedAs },
    ...pairs(s.paginate?.each ?? [], seen[i].each ?? [], `${at}step ${i + 1}, each `),
  ]);
}

describe('the sample bots read as their steps on the review page', () => {
  it('finds both samples', () => {
    expect(SAMPLES).toEqual(['sandbox-line-items.steps.json', 'sandbox-rows.steps.json']);
  });

  it.each(SAMPLES)('%s: every step has a description, equal to the sentence the review page builds, and shows no brackets', (file) => {
    const steps = stepsOf(file);
    for (const p of pairs(steps, shown(steps))) {
      expect(p.intent, `${file} ${p.at}`).toBeTruthy();
      // The page shows the author's description (in red) only when an entry has describedAs.
      expect(p.describedAs, `${file} ${p.at}`).toBeUndefined();
      expect(p.text, `${file} ${p.at}`).toBe(p.intent);
    }
  });

  it('a sample step whose description says something else would show it in brackets', () => {
    const steps = stepsOf('sandbox-line-items.steps.json');
    const misleading = steps.map((s, i) => (i === 4 ? { ...s, intent: 'Read the total' } : s));
    expect(shown(misleading)[4]).toMatchObject({ text: 'Type into From: "2026-09-01"', describedAs: 'Read the total' });
  });
});
