import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { describeLocator, firstPresent, isVisibleNow, resolveUnique } from '../src/steps/locator.js';
import { describeForUser, locatorNotFound } from '../src/messages.js';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(`
    <nav><a href="#s">Service</a><a href="#p">Parts</a></nav>
    <main><a href="#s2">Service</a><a id="only" href="#o">Only once</a>
      <button style="display:none">Hidden</button>
      <ul><li>One</li><li>Two</li><li>Three</li></ul></main>
    <iframe srcdoc="<button>In frame</button>"></iframe>`);
});
afterAll(async () => { await browser.close(); });

describe('locator resolution', () => {
  it('resolves a unique role/name match', async () => {
    const r = await resolveUnique(page, { role: 'link', name: 'Only once' }, 1000);
    expect(r.candidate).toBe(0);
    expect(await r.locator.getAttribute('id')).toBe('only');
  });
  it('scopes with within', async () => {
    const r = await resolveUnique(page, { role: 'link', name: 'Service', within: { role: 'navigation' } }, 1000);
    expect(await r.locator.getAttribute('href')).toBe('#s');
  });
  it('falls back when the primary is ambiguous', async () => {
    const r = await resolveUnique(page, { role: 'link', name: 'Service', fallbacks: [{ css: 'main a[href="#s2"]' }] }, 1000);
    expect(r.candidate).toBe(1);
  });
  it('never matches hidden elements and explains failures', async () => {
    await expect(resolveUnique(page, { role: 'button', name: 'Hidden' }, 300)).rejects.toThrow(
      'No element found for Role and Name button "Hidden" on about:blank after 1 s. Check the spelling or try Find by: Visible Text.',
    );
    expect(await isVisibleNow(page, { css: 'button' })).toBe(false);
  });
  it('searches inside frames', async () => {
    const r = await resolveUnique(page, { role: 'button', name: 'In frame', frame: 'iframe' }, 2000);
    expect(r.candidate).toBe(0);
  });
  it('firstPresent returns multi-matches and null when absent', async () => {
    const r = await firstPresent(page, { role: 'listitem' }, 500);
    expect(await r!.locator.count()).toBe(3);
    expect(await firstPresent(page, { css: '.nope' }, 200)).toBeNull();
  });
  it('describes nested locators', () => {
    expect(describeLocator({ role: 'link', name: 'Service', within: { role: 'navigation' } })).toBe('role=link[name="Service"] within role=navigation');
  });
  it('tolerates race: resolves element that appears after delay', async () => {
    // Dynamically add a button after 300ms
    await page.evaluate(() => {
      setTimeout(() => {
        const btn = document.createElement('button');
        btn.textContent = 'Late';
        btn.id = 'late-btn';
        document.body.appendChild(btn);
      }, 300);
    });
    // resolveUnique should poll and find it within 2000ms timeout
    const r = await resolveUnique(page, { role: 'button', name: 'Late' }, 2000);
    expect(r.candidate).toBe(0);
    expect(await r.locator.getAttribute('id')).toBe('late-btn');
  });
  it('fallback does not inherit within/frame from primary', async () => {
    // Primary has within:navigation but name 'Nope' (no match in nav)
    // Fallback has no within, searches page-wide for #only
    const r = await resolveUnique(page, {
      role: 'link',
      name: 'Nope',
      within: { role: 'navigation' },
      fallbacks: [{ css: '#only' }],
    }, 1000);
    expect(r.candidate).toBe(1);
    expect(await r.locator.getAttribute('id')).toBe('only');
  });
});

describe('golden locator messages', () => {
  let p: Page;
  beforeAll(async () => {
    p = await browser.newPage();
    await p.route('http://example.test/**', (r) => r.fulfill({
      contentType: 'text/html',
      body: '<main><button>Submit</button><button>Submit</button><button>Submit</button><a href="#a">Account</a></main>',
    }));
    await p.goto('http://example.test/account?token=abc#x');
  });
  afterAll(async () => { await p.close(); });
  it('not found names the locator, the page without its query string and the wait in seconds', async () => {
    await expect(resolveUnique(p, { text: 'Sign In' }, 1000)).rejects.toThrow(
      'No element found for Visible Text "Sign In" on http://example.test/account after 1 s. Check the spelling or try Find by: Role and Name.',
    );
    await expect(resolveUnique(p, { css: '#nope' }, 300)).rejects.toThrow(
      'No element found for CSS Selector "#nope" on http://example.test/account after 1 s. Check the spelling or try Find by: Visible Text.',
    );
  });
  it('not unique names the count', async () => {
    await expect(resolveUnique(p, { text: 'Submit' }, 300)).rejects.toThrow(
      'Visible Text "Submit" matches 3 elements. Use a more specific locator; it must match exactly one.',
    );
  });
  it('a working fallback still wins over a not-unique primary', async () => {
    const r = await resolveUnique(p, { text: 'Submit', fallbacks: [{ role: 'link', name: 'Account' }] }, 1000);
    expect(r.candidate).toBe(1);
  });
  it('describes each Find by type the way the node UI names it', () => {
    expect(describeForUser({ text: 'x' })).toBe('Visible Text "x"');
    expect(describeForUser({ label: 'x' })).toBe('Form Label "x"');
    expect(describeForUser({ role: 'button', name: 'x' })).toBe('Role and Name button "x"');
    expect(describeForUser({ role: 'navigation' })).toBe('Role and Name navigation');
    expect(describeForUser({ testId: 'x' })).toBe('Test ID "x"');
    expect(describeForUser({ css: 'x' })).toBe('CSS Selector "x"');
    expect(locatorNotFound('Visible Text "Sign In"', 'https://example.com/account', 30)).toBe(
      'No element found for Visible Text "Sign In" on https://example.com/account after 30 s. Check the spelling or try Find by: Role and Name.',
    );
  });
});
