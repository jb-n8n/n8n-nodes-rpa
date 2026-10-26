import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { checkExpect } from '../src/steps/expect.js';

const pageAt = (url: string, closed = false) => ({ url: () => url, isClosed: () => closed }) as unknown as Page;

describe('checkExpect messages', () => {
  it('name the page by origin and path only: no query or fragment (they can carry tokens or personal data)', async () => {
    const at = 'https://portal.example.com/acme/home?session=tok-123456&vin=1G1#row-7';
    await expect(checkExpect(pageAt(at), { url: '/acme/service' }, 50)).rejects.toThrow(/^expectation failed: url contains "\/acme\/service" \(at https:\/\/portal\.example\.com\/acme\/home\)$/);
    await expect(checkExpect(pageAt(at, true), { url: '/acme/service' }, 50)).rejects.toThrow(/^expectation abandoned: the page was closed \(at https:\/\/portal\.example\.com\/acme\/home\)$/);
    const err = (await checkExpect(pageAt(at), { url: '/acme/service' }, 50).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toMatch(/tok-123456|vin=|row-7/);
    await expect(checkExpect(pageAt('about:blank'), { url: '/acme/service' }, 50)).rejects.toThrow(/\(at about:blank\)$/);
  });
});
