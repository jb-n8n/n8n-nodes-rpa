// desktop-testbed.sh against fake terraform, aws, curl and pbcopy on PATH: the state stays outside the repository, up
// opens the test bed only to the given (or detected) CIDRs, stop/start/status/fingerprint/install-runner call the right
// AWS APIs, and the Administrator password never reaches the output unless asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../desktop-testbed.sh', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const INSTANCE = 'i-0123456789abcdef0';
const SECRET = 'AdminPw-ZYXWVUTSRQPONMLKJIHGFEDCBA-0123';
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).toUpperCase().padStart(2, '0')).join(':');
const SECRET_ARN = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:rpa-desktop-testbed-admin-password-MnOpQr';

// Each fake appends one line per call to calls.log: the tool, then its arguments, separated by \x1f.
const FAKE_TERRAFORM = `#!/usr/bin/env bash
printf 'terraform\\x1fTF_DATA_DIR=%s' "$TF_DATA_DIR" >>"$FAKE_LOG"; printf '\\x1f%s' "$@" >>"$FAKE_LOG"; printf '\\n' >>"$FAKE_LOG"
shift # -chdir=...
if [ "$1" = output ]; then
  case "$3" in
    instance_id) printf '%s' "${INSTANCE}" ;;
    region) printf 'us-west-2' ;;
    runner_url) printf 'wss://203.0.113.50:8765/rpa/v1' ;;
    admin_password_secret_arn) printf '%s' "${SECRET_ARN}" ;;
    *) exit 1 ;;
  esac
fi
exit 0
`;
const FAKE_AWS = `#!/usr/bin/env bash
printf 'aws' >>"$FAKE_LOG"; printf '\\x1f%s' "$@" >>"$FAKE_LOG"; printf '\\n' >>"$FAKE_LOG"
all="$*"
case "$all" in
  *"configure get region"*) echo us-west-2 ;;
  *"describe-instances"*"PublicIpAddress"*) echo 203.0.113.50 ;;
  *"describe-instances"*"State.Name"*) echo "\${FAKE_STATE:-running}" ;;
  *"describe-instance-information"*) echo Online ;;
  *"send-command"*) echo cmd-0123 ;;
  *"get-command-invocation"*"--query Status"*) echo "\${FAKE_SSM_STATUS:-Success}" ;;
  *"get-command-invocation"*"StandardOutputContent"*) printf '%s\\n' "\${FAKE_SSM_OUTPUT:-}" ;;
  *"get-secret-value"*) echo "${SECRET}" ;;
  *"stop-instances"*) echo stopping ;;
  *"start-instances"*) echo pending ;;
  *"ec2 wait"*) ;;
  *) echo "fake aws: unexpected $all" >&2; exit 1 ;;
esac
`;
const FAKE_CURL = `#!/usr/bin/env bash
printf 'curl' >>"$FAKE_LOG"; printf '\\x1f%s' "$@" >>"$FAKE_LOG"; printf '\\n' >>"$FAKE_LOG"
printf '%s\\n' "\${FAKE_IP:-198.51.100.23}"
`;
const FAKE_PBCOPY = `#!/usr/bin/env bash
cat >"$FAKE_CLIPBOARD"
`;

function setup() {
  // The real path: the script resolves symlinks (macOS's /var is /private/var).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-testbed-test-')));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['terraform', FAKE_TERRAFORM], ['aws', FAKE_AWS], ['curl', FAKE_CURL], ['pbcopy', FAKE_PBCOPY]]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const state = join(dir, 'state');
  const log = join(dir, 'calls.log');
  const clipboard = join(dir, 'clipboard');
  const run = (args, env = {}) => {
    const r = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dir, FAKE_LOG: log, FAKE_CLIPBOARD: clipboard,
        TESTBED_STATE_DIR: state, TESTBED_POLL_SECONDS: '0', ...env,
      },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\x1f')) : []);
  const brought = () => { mkdirSync(state, { recursive: true }); writeFileSync(join(state, 'terraform.tfstate'), '{}'); mkdirSync(join(state, '.terraform'), { recursive: true }); };
  return { dir, state, run, calls, brought, clipboard, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('refuses to run without TESTBED_STATE_DIR, or with one inside the repository', () => {
  const t = setup();
  try {
    let r = t.run(['status'], { TESTBED_STATE_DIR: '' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /set TESTBED_STATE_DIR/);
    const inside = join(ROOT, 'deploy', '.testbed-state-should-not-exist');
    r = t.run(['up'], { TESTBED_STATE_DIR: inside });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /inside the repository/);
    assert.equal(existsSync(inside), false, 'the directory is refused before it is created');
    r = t.run(['status'], { TESTBED_STATE_DIR: inside.toUpperCase() });
    assert.equal(r.code, 1, 'a different case is the same directory on macOS');
    assert.match(r.stderr, /inside the repository/);
    assert.deepEqual(t.calls(), []);
  } finally { t.done(); }
});

test('up opens the test bed to this machine\'s IP /32 and keeps state, working data and variables in the state dir', () => {
  const t = setup();
  try {
    const r = t.run(['up', '-auto-approve'], { AWS_REGION: 'us-west-2' });
    assert.equal(r.code, 0, r.out);
    const vars = JSON.parse(readFileSync(join(t.state, 'testbed.tfvars.json'), 'utf8'));
    assert.deepEqual(vars, { aws_region: 'us-west-2', allowed_cidrs: ['198.51.100.23/32'] });
    assert.equal(statSync(join(t.state, 'testbed.tfvars.json')).mode & 0o777, 0o600);
    const tf = t.calls().filter((c) => c[0] === 'terraform');
    assert.equal(tf.length, 2);
    for (const c of tf) {
      assert.equal(c[1], `TF_DATA_DIR=${t.state}/.terraform`);
      assert.match(c[2], /^-chdir=.*\/deploy\/terraform\/examples\/aws-ec2-desktop-runner$/);
    }
    assert.ok(tf[0].includes('init') && tf[0].includes(`-backend-config=path=${t.state}/terraform.tfstate`));
    assert.deepEqual(tf[1].slice(3), ['apply', '-input=false', `-var-file=${t.state}/testbed.tfvars.json`, '-auto-approve']);
    assert.ok(t.calls().some((c) => c[0] === 'curl' && c.includes('https://checkip.amazonaws.com')));
  } finally { t.done(); }
});

test('up takes TESTBED_ALLOWED_CIDRS and the runner artifact, and refuses the whole internet', () => {
  const t = setup();
  try {
    let r = t.run(['up'], {
      AWS_REGION: 'eu-west-1', TESTBED_ALLOWED_CIDRS: '203.0.113.7/32, 2001:db8::/48',
      TESTBED_RUNNER_ARTIFACT_URL: 'https://example.com/r.zip', TESTBED_RUNNER_ARTIFACT_SHA256: 'ab'.repeat(32),
    });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(readFileSync(join(t.state, 'testbed.tfvars.json'), 'utf8')), {
      aws_region: 'eu-west-1', allowed_cidrs: ['203.0.113.7/32', '2001:db8::/48'],
      runner_artifact_url: 'https://example.com/r.zip', runner_artifact_sha256: 'ab'.repeat(32),
    });
    assert.ok(!t.calls().some((c) => c[0] === 'curl'), 'no IP lookup when CIDRs are given');
    for (const bad of ['0.0.0.0/0', '203.0.113.7/32,::/0', '0.0.0.0/1', '3.0.0.0/8', '2001:db8::/32', '203.0.113.7']) {
      const u = setup();
      try {
        r = u.run(['up'], { AWS_REGION: 'us-west-2', TESTBED_ALLOWED_CIDRS: bad });
        assert.equal(r.code, 1, bad);
        assert.ok(!u.calls().some((c) => c[0] === 'terraform'), `${bad}: terraform never runs`);
      } finally { u.done(); }
    }
  } finally { t.done(); }
});

test('stop and start use the instance and region from the outputs, wait, and start prints the new runner URL', () => {
  const t = setup();
  try {
    t.brought();
    let r = t.run(['stop']);
    assert.equal(r.code, 0, r.out);
    const aws = () => t.calls().filter((c) => c[0] === 'aws').map((c) => c.slice(1).join(' '));
    assert.ok(aws().some((c) => c === `--region us-west-2 ec2 stop-instances --instance-ids ${INSTANCE} --query StoppingInstances[0].CurrentState.Name --output text`), aws().join('\n'));
    assert.ok(aws().includes(`--region us-west-2 ec2 wait instance-stopped --instance-ids ${INSTANCE}`));
    assert.match(r.stdout, /stopped\. Start it again with: TESTBED_STATE_DIR=.* start/);
    r = t.run(['start']);
    assert.equal(r.code, 0, r.out);
    assert.ok(aws().some((c) => c.startsWith(`--region us-west-2 ec2 start-instances --instance-ids ${INSTANCE}`)));
    assert.ok(aws().includes(`--region us-west-2 ec2 wait instance-running --instance-ids ${INSTANCE}`));
    assert.match(r.stdout, /SSM: Online/);
    assert.match(r.stdout, /runner URL wss:\/\/203\.0\.113\.50:8765\/rpa\/v1/);
  } finally { t.done(); }
});

test('status shows state, URL and SSM, and needs a brought-up test bed', () => {
  const t = setup();
  try {
    let r = t.run(['status']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /run up first/);
    t.brought();
    r = t.run(['status']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, new RegExp(`instance ${INSTANCE} \\(us-west-2\\): running`));
    assert.match(r.stdout, /wss:\/\/203\.0\.113\.50:8765\/rpa\/v1/);
    assert.match(r.stdout, /SSM: Online/);
  } finally { t.done(); }
});

test('fingerprint reads the runner log through SSM Run Command', () => {
  const t = setup();
  try {
    t.brought();
    let r = t.run(['fingerprint'], { FAKE_SSM_OUTPUT: FINGERPRINT });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.stdout.trim(), FINGERPRINT);
    const send = t.calls().find((c) => c.includes('send-command'));
    assert.ok(send.includes('AWS-RunPowerShellScript') && send.includes(INSTANCE));
    const params = JSON.parse(send[send.indexOf('--parameters') + 1]);
    assert.equal(params.commands[0].split(' | ')[0], 'Get-ChildItem -Path "$env:ProgramData\\RPA Runner\\*.log", "$env:ProgramData\\RPA Runner\\logs\\*.log" -File');
    assert.ok(params.commands[0].includes("-Pattern '([0-9A-F]{2}:){31}[0-9A-F]{2}'"));
    r = t.run(['fingerprint'], { FAKE_SSM_OUTPUT: '' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no fingerprint in the runner's log yet/);
    r = t.run(['fingerprint'], { FAKE_SSM_STATUS: 'Failed' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ended Failed/);
  } finally { t.done(); }
});

test('rdp-password copies the Administrator password to the clipboard and prints it only with --print', () => {
  const t = setup();
  try {
    t.brought();
    let r = t.run(['rdp-password']);
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes(SECRET), 'the password is not in the output');
    assert.equal(readFileSync(t.clipboard, 'utf8'), SECRET);
    assert.match(r.stdout, /copied to the clipboard\. RDP to 203\.0\.113\.50 as Administrator/);
    assert.ok(t.calls().some((c) => c.includes('get-secret-value') && c.includes(SECRET_ARN)));
    r = t.run(['rdp-password', '--print']);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.stdout, `${SECRET}\n`);
  } finally { t.done(); }
});

test('install-runner sends install-runner.ps1 over SSM and refuses a bad URL or hash', () => {
  const t = setup();
  try {
    t.brought();
    const url = 'https://bucket.s3.amazonaws.com/rpa-desktop-runner.zip?X-Amz-Signature=deadbeef';
    let r = t.run(['install-runner', url, 'CD'.repeat(32)], { FAKE_SSM_OUTPUT: 'installed rpa-desktop-runner.exe' });
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes('X-Amz-Signature'), 'the query string is not echoed');
    const send = t.calls().find((c) => c.includes('send-command'));
    const params = JSON.parse(send[send.indexOf('--parameters') + 1]);
    assert.equal(params.commands[0], `& 'C:\\Program Files\\RPA Runner\\install-runner.ps1' -Url '${url}' -Sha256 '${'CD'.repeat(32)}'`);
    for (const args of [['install-runner'], ['install-runner', 'http://example.com/r.zip'], ['install-runner', "https://example.com/a'b.zip"], ['install-runner', 'https://example.com/r.zip', 'abc']]) {
      r = t.run(args);
      assert.equal(r.code, 1, args.join(' '));
    }
  } finally { t.done(); }
});

test('an unknown command prints the usage and exits 2', () => {
  const t = setup();
  try {
    const r = t.run(['launch']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command: launch/);
    assert.match(r.stderr, /up \[apply args\]/);
  } finally { t.done(); }
});
