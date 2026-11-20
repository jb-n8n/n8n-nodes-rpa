// The Windows machine: the test of the RPA Desktop Runner (n8n's, or on n8n's command line way the installed node's own,
// run here), a new or corrected Connection Line (tested before it replaces one), a second machine, and the closing lines
// about the machine.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseConnectionLine } from '../nodes/Playwright/config.js';
import { clean, type Client } from './n8n-api.mjs';
import { ask, askHidden, detail, interactive, redactor, say, warn } from './io.mjs';
import { type Inputs, RUNNER } from './options.mjs';
import { byNameThenId, record, type Ref, replaceData } from './ownership.mjs';

/** A message from n8n fit for one printed line: control characters removed, spaces collapsed, cut at 300 characters. */
const oneLine = (text: unknown, most = 300) => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, most);

/**
 * The installed RPA node's own test of an RPA Desktop Runner (credential-tests desktopRunnerTestResult with the engine's
 * probeRunner), loaded from n8n's folder: the very code n8n runs when it tests the credential, on the same machine and
 * network path, as this command runs where n8n runs on n8n's command line way. It checks the certificate's fingerprint
 * before it sends the token, and its messages never repeat the token. Not bundled into this command: the node n8n has
 * installed is what n8n would test with. Throws when that node has no such test (an older one).
 */
async function nodeRunnerTest(folder: string, line: string): Promise<{ status: string; message: string }> {
  const dir = join(folder, 'nodes', 'node_modules', 'n8n-nodes-rpa', 'dist', 'nodes', 'Playwright');
  // The node is CommonJS: import() gives its exports by name, and as default.
  const load = async (file: string) => {
    const m: any = await import(/* @vite-ignore */ pathToFileURL(join(dir, file)).href);
    return { ...(m.default && typeof m.default === 'object' ? m.default : {}), ...m };
  };
  const tests = await load('credential-tests.js');
  const { loadEngine } = await load('engine.js');
  if (typeof tests.desktopRunnerTestResult !== 'function' || typeof loadEngine !== 'function') throw new Error('the RPA node installed in n8n has no test of a Windows machine');
  return tests.desktopRunnerTestResult({ connectionLine: line }, await loadEngine());
}

/**
 * Tests the RPA Desktop Runner. On the API key way n8n tests the credential (POST /credentials/{id}/test): n8n runs the
 * node's own test, and the credential's values never leave n8n. On n8n's command line way the installed node's own test
 * runs here (nodeRunnerTest), with the line this run was given: a credential's values are never read back from n8n, so
 * one this run has no line for is not tested. The test waits up to 60 s for a machine that does not answer, so the call
 * may take 90 s. Every line here is a detail: the closing lines say the result (closingRunner).
 */
export async function testRunner(inputs: Inputs, ref: Ref, what = `credential "${clean(ref.name, ref.id)}" (id ${clean(ref.id)})`, line?: string): Promise<RunnerTest> {
  const { client } = inputs;
  const advice = ref.name === TRIAL ? '' : ' To test it, open it in n8n, which tests it as it opens.';
  if (inputs.cli) {
    if (line === undefined) {
      const message = "this run was not given its Connection Line, and n8n's command line cannot test a credential.";
      detail(`not tested ${what}: ${message}${advice}`);
      return { result: 'untested', message };
    }
    detail(`testing  ${what}: this computer connects to the Windows machine with the RPA node's own test (up to a minute)`);
    let r: { status: string; message: string };
    try {
      r = await nodeRunnerTest(inputs.cli.folder, line);
    } catch (err) {
      const message = `the RPA node's own test could not run here (${oneLine(clean((err as Error)?.message), 200)}).`;
      detail(`not tested ${what}: ${message}${advice}`);
      return { result: 'untested', message };
    }
    const message = oneLine(r?.message, 1200);
    if (r?.status === 'OK') {
      detail(`tested   ${what}: ${message || 'OK'}`);
      return { result: 'connected', message: message || 'OK' };
    }
    detail(`tested   ${what}, and it failed: ${message || 'the test gave no reason'}`);
    return { result: 'failed', message: message || 'the test gave no reason' };
  }
  detail(`testing  ${what}: n8n connects to the Windows machine (up to a minute)`);
  const r = await client.api('POST', `/credentials/${encodeURIComponent(ref.id)}/test`, undefined, { timeoutMs: 90_000 }).catch(() => undefined);
  const status = r?.status === 200 ? r.json?.status : undefined;
  // The node's own message, whole: the longest ends in the command to run on the Windows machine.
  const message = oneLine(r?.json?.message, 1200);
  if (status === 'OK') {
    detail(`tested   ${what}: ${message || 'OK'}`);
    return { result: 'connected', message: message || 'OK' };
  }
  if (status === 'Error') {
    detail(`tested   ${what}, and it failed: ${message || 'n8n gave no reason'}`);
    return { result: 'failed', message: message || 'n8n gave no reason' };
  }
  const why = r ? client.reason(r) : 'no answer from n8n';
  const scope = r?.status === 403 ? ' For this command to test it, the API key needs the scope credential:read.' : '';
  detail(`not tested ${what} (${why}).${advice}${scope}`);
  return { result: 'untested', message: `${why}.${scope}` };
}

/** A failed test's reason: its first sentence (an address has no space after its dots). */
export const reasonOf = (message: string) => /^(.*?[.?])\s+/.exec(message)?.[1] ?? message;

/**
 * After a failed test, at a terminal: the reason, then once a corrected Connection Line (not shown), or Enter to finish.
 * A line replaces the credential's line as offerLine does, said by its address and port only; it is then tested again.
 * A line that does not parse, or that n8n does not take, changes nothing. Returns the line when it replaced the old one.
 */
export async function correctLine(client: Client, ref: Ref, test: RunnerTest): Promise<string | undefined> {
  const what = `credential "${clean(ref.name, ref.id)}" (id ${clean(ref.id)})`;
  say(`The Windows machine is not connected: ${reasonOf(test.message)}`);
  say('If the line is wrong, print it again on the Windows machine (with -Address when n8n reaches it by another name) and paste it now.');
  const line = await askHidden(`Corrected Connection Line for "${clean(ref.name, ref.id)}" (not shown), or Enter to finish: `);
  redactor.add(line);
  if (!line) return undefined;
  let to: string | undefined;
  let problem: string | undefined;
  try {
    // The node's own parser: its messages never repeat any part of the line.
    const parsed = parseConnectionLine('runner', line);
    redactor.add(parsed.token);
    to = new URL(parsed.url).host;
  } catch (err) {
    problem = (err as Error).message;
  }
  if (to === undefined) {
    say(`         not used: ${problem ?? 'the line does not parse.'} The Connection Line of ${what} stays as it is.`);
    return undefined;
  }
  const r = await client.api('PATCH', `/credentials/${encodeURIComponent(ref.id)}`, { name: ref.name, type: RUNNER.type, data: { connectionLine: line } });
  if (r.status !== 200) {
    say(`         not used: n8n did not take it (${client.reason(r)}). The Connection Line of ${what} stays as it is.`);
    return undefined;
  }
  record.changed.push(`the Connection Line of "${clean(ref.name, ref.id)}"`);
  say(`Replaced the Connection Line of ${what}: it now names ${to}.`);
  return line;
}

/** What n8n's test of the RPA Desktop Runner gave, for the closing lines. */
export interface RunnerTest { result: 'connected' | 'failed' | 'untested'; message: string }

/**
 * The closing lines about the Windows machine: the form is ready either way (exit 0), and whether the machine is
 * connected. A failed test's message is split into its reason (the first sentence) and what to do (the rest), when the
 * rest says what to do; else what to do is to correct the line and run this again.
 */
export function closingRunner(test: RunnerTest, ref: Ref, named = false): string[] {
  const name = `"${clean(ref.name, ref.id)}"`;
  // Named when the workflow the form hands over uses another RPA Desktop Runner than the one tested (W6-2).
  const machine = named ? `The Windows machine of ${name} (id ${clean(ref.id)})` : 'The Windows machine';
  if (test.result === 'connected') return [`${machine} is connected. The test said: ${test.message}${/[.!?]$/.test(test.message) ? '' : '.'}`];
  if (test.result === 'untested') {
    return [
      `Whether ${machine.replace(/^The/, 'the')} is connected is not known: it was not tested.`,
      `  Reason:     ${test.message}`,
      `  What to do: open the credential ${name} in n8n, which tests it as it opens.`,
    ];
  }
  const cut = /^(.*?[.?])\s+(.*)$/.exec(test.message);
  const reason = cut ? cut[1] : test.message;
  const rest = cut ? cut[2].replace(/^Nothing was sent\.\s*/, '').trim() : '';
  return [
    `${machine} is not connected yet.`,
    `  Reason:     ${reason}`,
    `  What to do: ${rest || `Correct the Connection Line of ${name}.`}`,
    '              Then run this command again, with the new line if you printed one.',
  ];
}

/** The address and port a Connection Line names (the node's own parser, which already took this line). */
export const lineHost = (line: string) => new URL(parseConnectionLine('runner', line).url).host;
/**
 * The credential a new Windows machine gets: named for the machine as its line names it, with the port when it is not
 * the runner's own 8765 (two machines behind one NAT address differ by port only). n8n's names are at most 128.
 */
export function machineName(line: string): string {
  const url = new URL(parseConnectionLine('runner', line).url);
  const port = url.port && url.port !== '8765' ? `:${url.port}` : '';
  return `${RUNNER.name} (${clean(url.hostname).slice(0, 100)}${port})`;
}

/**
 * A Connection Line comes, and the project has RPA Desktop Runners that are not named for the line's machine: is it
 * another Windows machine, or a new line for one of these (the same machine at a new address, or after its tokens
 * changed)? Asked at a terminal only, default nothing. Another machine gets a credential of its own, so the bots of the
 * first one stay on it; a new line goes through offerLine, which tests it before it replaces the old one.
 */
export async function askMachine(found: Ref[], line: string): Promise<'new' | Ref | undefined> {
  // Numbered by name, then id: the same number picks the same credential on both ways in.
  const candidates = [...found].sort(byNameThenId);
  const to = lineHost(line);
  const named = (r: Ref) => `"${clean(r.name, r.id)}" (id ${clean(r.id)})`;
  if (candidates.length === 1) {
    say(`Your project has the RPA Desktop Runner ${named(candidates[0])}.`);
    const answer = await ask(`Is the line for ${to} another Windows machine (a), or a new line for "${clean(candidates[0].name, candidates[0].id)}" (s)? Enter changes nothing: `);
    return /^a$/i.test(answer) ? 'new' : /^s$/i.test(answer) ? candidates[0] : undefined;
  }
  say(`Your project has ${candidates.length} RPA Desktop Runners:`);
  candidates.forEach((c, i) => say(`  ${i + 1}. ${named(c)}`));
  const answer = await ask(`Is the line for ${to} another Windows machine (a), or a new line for one of these (its number)? Enter changes nothing: `);
  if (/^a$/i.test(answer)) return 'new';
  const n = /^\d+$/.test(answer) ? Number(answer) : 0;
  return n >= 1 && n <= candidates.length ? candidates[n - 1] : undefined;
}

/**
 * A Connection Line for an RPA Desktop Runner this run's project has: its line is replaced only when the person says yes
 * at a terminal, to a question that names the new line's address and port (never its token or fingerprint); `answered`
 * when they already said so (askMachine). Without a terminal the old line stays, and it says how to replace it.
 * A credential that works is never left broken by a replacement: the new line is tested first (tryLine), and the old line
 * is replaced only when that test passes. Where it cannot be tested (an API key without credential:read; an installed
 * node without the test), the person is asked again, told that the old line will be gone, default no.
 * `replaced` is the line the credential holds when this run replaced it.
 */
export async function offerLine(inputs: Inputs, ref: Ref, line: string, projectId: string | undefined, answered = false): Promise<{ ref: Ref; replaced?: string }> {
  const { client } = inputs;
  const what = `credential "${clean(ref.name, ref.id)}" (id ${clean(ref.id)})`;
  const name = clean(ref.name, ref.id);
  const to = lineHost(line);
  const yes = (answer: string) => /^y(es)?$/i.test(answer);
  detail(`reused   ${what}`);
  if (!interactive()) {
    say(`The Connection Line of ${what} stays as it is: this run replaces one only when you say so at a terminal. To use the line for ${to}, run this again in a terminal, or paste the line into the credential's Connection Line in n8n.`);
    return { ref };
  }
  const keep = () => {
    say(`The Connection Line of ${what} stays as it is.`);
    return { ref };
  };
  const replace = async (how: string) => {
    await replaceData(client, ref, RUNNER.type, { connectionLine: line });
    say(`Replaced the Connection Line of ${what}: it now names ${to}${how}.`);
    return { ref, replaced: line };
  };
  if (!answered && !yes(await ask(`Replace the Connection Line of "${name}" with the line for ${to}? (y/N) `))) return keep();
  const tried = await tryLine(inputs, line, to, projectId);
  if (tried.result === 'connected') return replace(', after the new line passed the test');
  if (tried.result === 'failed') {
    say(`Not replaced: the line for ${to} did not pass the test: ${tried.message}`);
    say(`  The Connection Line of ${what} stays as it is. Check the new line (print it again on the Windows machine, with -Address when n8n reaches it by another name), then run this again.`);
    return { ref };
  }
  say(`The new line could not be tested first (${tried.message})`);
  if (!yes(await ask(`Replace the line of "${name}" untested? The old line will be gone. (y/N) `))) return keep();
  return replace(', untested');
}

/** The name of the short-lived credential a new Connection Line is tested in (the API key way). */
const TRIAL = 'RPA Desktop Runner (testing a new line)';
/** A credential this run made only to test a line: removed in every case, also when the run is stopped. */
let trial: { client: Client; id: string } | undefined;

/**
 * The test of a Connection Line before it replaces one: on n8n's command line way the node's own test runs here on the
 * line itself; on the API key way n8n tests it in a credential of its own that is removed right after. The line's
 * credential is not touched.
 */
async function tryLine(inputs: Inputs, line: string, to: string, projectId: string | undefined): Promise<RunnerTest> {
  const { client } = inputs;
  if (inputs.cli) return testRunner(inputs, { id: '', name: TRIAL }, `the new line for ${to}`, line);
  const r = await client.api('POST', '/credentials', { name: TRIAL, type: RUNNER.type, data: { connectionLine: line }, ...(projectId ? { projectId } : {}) });
  if ((r.status !== 200 && r.status !== 201) || !r.json?.id) return { result: 'untested', message: `n8n did not make a credential to test it in: ${client.reason(r)}` };
  trial = { client, id: String(r.json.id) };
  try {
    return await testRunner(inputs, { id: String(r.json.id), name: TRIAL }, `the new line for ${to}`);
  } finally {
    await removeTrial();
  }
}

/** Deletes the credential tryLine made. When n8n does not let it, its line is overwritten with one that holds no token, and the run says to delete it. */
export async function removeTrial() {
  if (!trial) return;
  const { client, id } = trial;
  trial = undefined;
  const removed = await client.api('DELETE', `/credentials/${encodeURIComponent(id)}`).catch(() => undefined);
  if (removed && (removed.status === 200 || removed.status === 204)) return;
  // A line that names no machine and holds no token: nothing secret stays behind.
  const blank = await client.api('PATCH', `/credentials/${encodeURIComponent(id)}`, { name: TRIAL, type: RUNNER.type, data: { connectionLine: `rpa-runner://removed.invalid:1/rpa/v1#token=removed&fingerprint=${'0'.repeat(64)}` } }).catch(() => undefined);
  warn(`The credential "${TRIAL}" (id ${clean(id)}) that tested the new line is still in n8n${blank?.status === 200 ? ', without the line' : ', with the new line in it'}: delete it there${removed ? ` (n8n did not let this run delete it: ${client.reason(removed)})` : ''}.`);
}
