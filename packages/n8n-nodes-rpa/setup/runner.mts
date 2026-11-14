// The Windows machine: n8n's test of the RPA Desktop Runner, a new or corrected Connection Line (tested first in a
// short-lived credential, removed in every case), and the closing lines about the machine.
import { parseConnectionLine } from '../nodes/Playwright/config.js';
import { clean, type Client } from './n8n-api.mjs';
import { ask, askHidden, interactive, redactor, say, warn } from './io.mjs';
import { type Inputs, RUNNER } from './options.mjs';
import { type Ref, replaceData } from './ownership.mjs';

/** A message from n8n fit for one printed line: control characters removed, spaces collapsed, cut at 300 characters. */
const oneLine = (text: unknown, most = 300) => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, most);

/**
 * Asks n8n to test the RPA Desktop Runner credential (POST /credentials/{id}/test): n8n runs the node's own test, which
 * connects to the Windows machine. One line with the node's message; the credential's values never leave n8n. The test
 * waits up to 60 s for a machine that does not answer, so the call may take 90 s.
 */
export async function testRunner(inputs: Inputs, ref: Ref, what = `credential "${clean(ref.name, ref.id)}" (id ${clean(ref.id)})`): Promise<RunnerTest> {
  const { client } = inputs;
  const advice = ref.name === TRIAL ? '' : ' To test it, open it in n8n, which tests it as it opens.';
  if (inputs.cli) {
    const message = "n8n's command line cannot test a credential.";
    say(`not tested ${what}: ${message}${advice}`);
    return { result: 'untested', message };
  }
  say(`testing  ${what}: n8n connects to the Windows machine (up to a minute)`);
  const r = await client.api('POST', `/credentials/${encodeURIComponent(ref.id)}/test`, undefined, { timeoutMs: 90_000 }).catch(() => undefined);
  const status = r?.status === 200 ? r.json?.status : undefined;
  // The node's own message, whole: the longest ends in the command to run on the Windows machine.
  const message = oneLine(r?.json?.message, 1200);
  if (status === 'OK') {
    say(`tested   ${what}: ${message || 'OK'}`);
    return { result: 'connected', message: message || 'OK' };
  }
  if (status === 'Error') {
    say(`tested   ${what}, and it failed: ${message || 'n8n gave no reason'}`);
    return { result: 'failed', message: message || 'n8n gave no reason' };
  }
  const why = r ? client.reason(r) : 'no answer from n8n';
  const scope = r?.status === 403 ? ' For this command to test it, the API key needs the scope credential:read.' : '';
  say(`not tested ${what} (${why}).${advice}${scope}`);
  return { result: 'untested', message: `${why}.${scope}` };
}

/** "no answer within N s": nothing on n8n's way reached the Windows machine (the engine's runnerNoTcpAnswer, runnerUnreachable). */
export const NO_ANSWER = /\(no answer within \d+ s\)/;

/**
 * After a test that got no answer, at a terminal: once, a corrected Connection Line (not shown), or Enter to finish. A
 * line replaces the credential's line as offerLine does, said by its address and port only; n8n then tests it again.
 * A line that does not parse, or that n8n does not take, changes nothing. Returns whether the line was replaced.
 */
export async function correctLine(client: Client, ref: Ref): Promise<boolean> {
  const what = `credential "${clean(ref.name, ref.id)}" (id ${clean(ref.id)})`;
  say('n8n got no answer from the Windows machine. If you printed its line again, for example with -Address, paste it now.');
  const line = await askHidden(`Corrected Connection Line for "${clean(ref.name, ref.id)}" (not shown), or Enter to finish: `);
  redactor.add(line);
  if (!line) return false;
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
    return false;
  }
  const r = await client.api('PATCH', `/credentials/${encodeURIComponent(ref.id)}`, { name: ref.name, type: RUNNER.type, data: { connectionLine: line } });
  if (r.status !== 200) {
    say(`         not used: n8n did not take it (${client.reason(r)}). The Connection Line of ${what} stays as it is.`);
    return false;
  }
  say(`replaced Connection Line of ${what}: it now names ${to}`);
  return true;
}

/** What n8n's test of the RPA Desktop Runner gave, for the closing lines. */
interface RunnerTest { result: 'connected' | 'failed' | 'untested'; message: string }

/**
 * The closing lines about the Windows machine: the form is ready either way (exit 0), and whether the machine is
 * connected. A failed test's message is split into its reason (the first sentence) and what to do (the rest), when the
 * rest says what to do; else what to do is to correct the line and run this again.
 */
export function closingRunner(test: RunnerTest, ref: Ref, formSays = 'The import form is ready', named = false): string[] {
  const name = `"${clean(ref.name, ref.id)}"`;
  // Named when the workflow the form hands over uses another RPA Desktop Runner than the one tested (W6-2).
  const machine = named ? `the Windows machine of ${name} (id ${clean(ref.id)})` : 'the Windows machine';
  if (test.result === 'connected') return [`${formSays}, and ${machine} is connected. n8n's test said: ${test.message}${/[.!?]$/.test(test.message) ? '' : '.'}`];
  if (test.result === 'untested') {
    return [
      `${formSays}. Whether ${machine} is connected is not known: n8n did not test it.`,
      `  Reason:     ${test.message}`,
      `  What to do: open the credential ${name} in n8n, which tests it as it opens.`,
    ];
  }
  // The first sentence ends at a full stop or question mark followed by a space (an address has no space after its dots).
  const cut = /^(.*?[.?])\s+(.*)$/.exec(test.message);
  const reason = cut ? cut[1] : test.message;
  const rest = cut ? cut[2].replace(/^Nothing was sent\.\s*/, '').trim() : '';
  return [
    `${formSays}, but ${machine} is not connected yet.`,
    `  Reason:     ${reason}`,
    `  What to do: ${rest || `Correct the Connection Line of ${name}.`}`,
    '              Then run this command again, with the new line if you printed one.',
  ];
}

/**
 * A Connection Line for an RPA Desktop Runner this run's project has: its line is replaced only when the person says yes
 * at a terminal, to a question that names the new line's address and port (never its token or fingerprint). Without a
 * terminal the old line stays, and it says how to replace it.
 * A credential that works is never left broken by a replacement: n8n first tests the new line in a credential of its own
 * (tryLine), and the old line is replaced only when that test passes. Where n8n cannot test it (n8n's command line; an
 * API key without credential:read), the person is asked again, told that the old line will be gone, default no.
 */
export async function offerLine(inputs: Inputs, ref: Ref, line: string, projectId: string | undefined): Promise<Ref> {
  const { client } = inputs;
  const what = `credential "${clean(ref.name, ref.id)}" (id ${clean(ref.id)})`;
  const name = clean(ref.name, ref.id);
  // The address and port only: parsed by the node's own parser, which already took this line.
  const to = new URL(parseConnectionLine('runner', line).url).host;
  const yes = (answer: string) => /^y(es)?$/i.test(answer);
  say(`reused   ${what}`);
  if (!interactive()) {
    say(`         its Connection Line stays as it is: this run replaces one only when you say so at a terminal. To use the line for ${to}, run this again in a terminal, or paste the line into the credential's Connection Line in n8n.`);
    return ref;
  }
  const keep = () => {
    say('         its Connection Line stays as it is.');
    return ref;
  };
  const replace = async (how: string) => {
    await replaceData(client, ref, RUNNER.type, { connectionLine: line });
    say(`replaced Connection Line of ${what}: it now names ${to}${how}`);
    return ref;
  };
  if (inputs.cli) {
    if (!yes(await ask(`Replace the Connection Line of "${name}" with the line for ${to}? n8n's command line cannot test the new line first, and the old line will be gone. (y/N) `))) return keep();
    return replace(', untested');
  }
  if (!yes(await ask(`Replace the Connection Line of "${name}" with the line for ${to}? (y/N) `))) return keep();
  const tried = await tryLine(inputs, line, to, projectId);
  if (tried.result === 'connected') return replace(", which n8n's test reached first");
  if (tried.result === 'failed') {
    say(`not replaced: the line for ${to} did not pass n8n's test (above).`);
    say(`         The Connection Line of ${what} stays as it is. Check the new line (print it again on the Windows machine, with -Address when n8n reaches it by another name), then run this again.`);
    return ref;
  }
  say(`         n8n could not test the new line first (${tried.message}).`);
  if (!yes(await ask(`Replace the line of "${name}" untested? The old line will be gone. (y/N) `))) return keep();
  return replace(', untested');
}

/** The name of the short-lived credential a new Connection Line is tested in. */
const TRIAL = 'RPA Desktop Runner (testing a new line)';
/** A credential this run made only to test a line: removed in every case, also when the run is stopped. */
let trial: { client: Client; id: string } | undefined;

/** n8n's test of a Connection Line, in a credential of its own that is removed right after: the line's credential is not touched. */
async function tryLine(inputs: Inputs, line: string, to: string, projectId: string | undefined): Promise<RunnerTest> {
  const { client } = inputs;
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
