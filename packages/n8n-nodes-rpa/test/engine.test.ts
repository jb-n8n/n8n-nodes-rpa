import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('n8n-rpa-engine');
});

describe('loadEngine', () => {
  it('does not keep a failed import: the next call retries', async () => {
    vi.doMock('n8n-rpa-engine', () => {
      throw new Error('load failed');
    });
    const { loadEngine } = await import('../nodes/Playwright/engine.js');
    const first = loadEngine();
    await expect(first).rejects.toThrow();
    vi.doMock('n8n-rpa-engine', () => ({ runTask: () => 'ok' }));
    const second = loadEngine();
    expect(second).not.toBe(first);
    await expect(second).resolves.toMatchObject({ runTask: expect.any(Function) });
  });
});
