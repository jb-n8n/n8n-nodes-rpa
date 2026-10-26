// Regression: two of the three credential pickers were labelled just "Credential" in the n8n editor
import { describe, expect, it } from 'vitest';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';

// n8n's NodeCredentials.vue (getCredentialsFieldLabel) uses the description's displayName when set; otherwise a node
// with several credential types shows the bare "Credential" label for some of them, so users cannot tell the slots apart.
describe('RPA node credential labels', () => {
  it('names every credential slot with its credential type name (the "RPA" prefix)', () => {
    expect(new Playwright().description.credentials?.map((c) => c.displayName)).toEqual(['RPA Browser', 'RPA Site Login', 'RPA Step Signing', 'RPA Redis']);
  });
});
