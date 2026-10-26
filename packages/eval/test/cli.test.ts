import { describe, expect, it } from 'vitest';
import { main, parseArgs, type CliIo } from '../src/cli.js';

const io = () => {
  const out: string[] = [];
  const progress: string[] = [];
  const files: Record<string, string> = {};
  const value: CliIo = { out: (t) => out.push(t), progress: (t) => progress.push(t), writeFile: async (p, t) => { files[p] = t; } };
  return { value, out, progress, files };
};

describe('eval CLI', () => {
  it('skips cleanly without ANTHROPIC_API_KEY', async () => {
    const x = io();
    expect(await main([], {}, x.value)).toBe(0);
    expect(x.out).toEqual(['ANTHROPIC_API_KEY is not set: skipping the eval.']);
    expect(x.files).toEqual({});
  });
  it('parses arguments and rejects bad ones', async () => {
    expect(parseArgs([])).toEqual({ seeds: 25, model: 'claude-sonnet-5-5' });
    expect(parseArgs(['--', '--seeds', '3', '--model', 'claude-opus-5-5', '--out', 'r.json'])).toEqual({ seeds: 3, model: 'claude-opus-5-5', out: 'r.json' });
    expect(() => parseArgs(['--seeds', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--fast'])).toThrow(/unknown argument --fast/);
    const x = io();
    expect(await main(['--seeds', 'x'], { ANTHROPIC_API_KEY: 'k' }, x.value)).toBe(2);
    expect(x.progress[0]).toMatch(/positive integer/);
  });
  it('treats a missing or flag-like value for --model and --out as an argument error', async () => {
    for (const argv of [['--model'], ['--model', '--seeds', '2'], ['--out'], ['--out', '--model', 'x']]) {
      expect(() => parseArgs(argv)).toThrow(/needs a/);
      const x = io();
      expect(await main(argv, { ANTHROPIC_API_KEY: 'k' }, x.value)).toBe(2);
    }
  });
  it('reports a crash as "eval crashed: <message>" and exits 2', async () => {
    const x = io();
    const crash = async () => { throw new Error('boom'); };
    expect(await main(['--seeds', '1'], { ANTHROPIC_API_KEY: 'k' }, x.value, crash)).toBe(2);
    expect(x.progress.some((l) => l === 'eval crashed: boom')).toBe(true);
  });
});
