import { writeFile } from 'node:fs/promises';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { anthropicChatModel, DEFAULT_MODEL } from './anthropic-model.js';
import { runEval } from './run.js';

export interface CliArgs {
  seeds: number;
  model: string;
  out?: string;
}
export interface CliIo {
  /** The JSON report (stdout). */
  out(text: string): void;
  /** Progress and errors (stderr). */
  progress(text: string): void;
  writeFile(path: string, text: string): Promise<void>;
}
const defaultIo: CliIo = {
  out: (t) => { process.stdout.write(`${t}\n`); },
  progress: (t) => { process.stderr.write(`${t}\n`); },
  writeFile: (p, t) => writeFile(p, t),
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { seeds: 25, model: DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--') continue;
    if (a === '--seeds') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('--seeds must be a positive integer');
      args.seeds = n;
      i++;
    } else if (a === '--model') {
      if (!v || v.startsWith('--')) throw new Error('--model needs a model id');
      args.model = v;
      i++;
    } else if (a === '--out') {
      if (!v || v.startsWith('--')) throw new Error('--out needs a file path');
      args.out = v;
      i++;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

/** Runs the eval; returns the process exit code (0 pass or skipped, 1 below the bar, 2 bad arguments or a crash). */
export async function main(argv: string[], env: Record<string, string | undefined>, io: CliIo = defaultIo, run: typeof runEval = runEval): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.progress((err as Error).message);
    return 2;
  }
  if (!env.ANTHROPIC_API_KEY) {
    io.out('ANTHROPIC_API_KEY is not set: skipping the eval.');
    return 0;
  }
  let portal: Awaited<ReturnType<typeof startPortal>> | undefined;
  try {
    portal = await startPortal();
    const report = await run({
      portal, seeds: Array.from({ length: args.seeds }, (_, i) => i + 1),
      model: anthropicChatModel({ apiKey: env.ANTHROPIC_API_KEY, model: args.model }), modelName: args.model, log: (l) => io.progress(l),
    });
    const json = JSON.stringify(report, null, 2);
    io.out(json);
    await io.writeFile(args.out ?? `eval-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, json);
    return report.pass ? 0 : 1;
  } catch (err) {
    io.progress(`eval crashed: ${(err as Error).message}`);
    return 2;
  } finally {
    await portal?.close().catch(() => undefined);
  }
}
