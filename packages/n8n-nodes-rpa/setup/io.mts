// The setup command's terminal: every printed line through the one redactor, the questions it asks, and Stop. It
// imports from none of the other setup modules, so that each of them can import it.
import { createInterface } from 'node:readline/promises';
import { createRedactor } from './n8n-api.mjs';

export const redactor = createRedactor();
export const { redact } = redactor;
export const say = (line = '') => process.stdout.write(`${redact(line)}\n`);
export const warn = (line: string) => process.stderr.write(`${redact(line)}\n`);
/** The one line that shows a secret: the words around it are redacted, the secret itself is not. */
export const reveal = (before: string, secret: string, after = '') => process.stdout.write(`${redact(before)}${secret}${redact(after)}\n`);

/** A problem the user fixes: printed, exit 2 (wrong input) or 1 (n8n's answer), nothing more is done. */
export class Stop extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

export const interactive = () => process.stdin.isTTY === true && process.stdout.isTTY === true;

/** Asks for a line, echoed (an email address, yes or no). */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return (await rl.question(redact(question))).trim();
  } finally {
    rl.close();
  }
}

/** Asks for a secret without echo: the terminal shows nothing while it is typed or pasted. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    let value = '';
    const finish = (err?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Stop('Stopped: nothing was changed.', 130));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    // Echo off before the question shows, so that a line pasted the moment it shows is never echoed.
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdout.write(redact(question));
    stdin.resume();
    stdin.on('data', onData);
  });
}
