// desktop-testbed.sh against fake terraform, aws, curl and pbcopy on PATH: the state stays outside the repository, up
// opens the test bed only to the given (or detected) CIDRs, stop/start/status/fingerprint/install call the right AWS
// APIs, no URL query string reaches the output, and the Administrator password never does unless asked for. One test
// runs the module's install-package.ps1 itself, where PowerShell (pwsh) is installed, up to its refusal of a URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../desktop-testbed.sh', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const INSTANCE = 'i-0123456789abcdef0';
const SECRET = 'AdminPw-ZYXWVUTSRQPONMLKJIHGFEDCBA-0123';
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).toUpperCase().padStart(2, '0')).join(':');
const BROWSER_FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i * 5 + 32).toString(16).toUpperCase().padStart(2, '0')).join(':');
const INSTALL_PACKAGE = fileURLToPath(new URL('../../terraform/modules/aws-ec2-desktop-runner/scripts/install-package.ps1', import.meta.url));
// PowerShell 7, where there is one: RPA_PWSH, pwsh on PATH (GitHub's runners have it), or this project's tool cache.
const PWSH = [process.env.RPA_PWSH, 'pwsh', join(homedir(), '.cache', 'rpa-tools', 'pwsh', 'pwsh')]
  .filter(Boolean).find((p) => spawnSync(p, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0);
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
    browser_url) printf 'wss://203.0.113.50:3000' ;;
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

test('up takes TESTBED_ALLOWED_CIDRS and the package, and refuses the whole internet and a package URL without its hash', () => {
  const t = setup();
  try {
    let r = t.run(['up'], {
      AWS_REGION: 'eu-west-1', TESTBED_ALLOWED_CIDRS: '203.0.113.7/32, 2001:db8::/48',
      TESTBED_PACKAGE_URL: 'https://example.com/rpa-windows-x64.zip', TESTBED_PACKAGE_SHA256: 'ab'.repeat(32),
    });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(readFileSync(join(t.state, 'testbed.tfvars.json'), 'utf8')), {
      aws_region: 'eu-west-1', allowed_cidrs: ['203.0.113.7/32', '2001:db8::/48'],
      package_url: 'https://example.com/rpa-windows-x64.zip', package_sha256: 'ab'.repeat(32),
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
    const url = 'https://bucket.s3.amazonaws.com/rpa-windows-x64.zip?X-Amz-Signature=deadbeef';
    for (const env of [{ TESTBED_PACKAGE_URL: url }, { TESTBED_PACKAGE_SHA256: 'ab'.repeat(32) }, { TESTBED_PACKAGE_URL: url, TESTBED_PACKAGE_SHA256: 'abc' }, { TESTBED_PACKAGE_URL: 'http://example.com/p.zip', TESTBED_PACKAGE_SHA256: 'ab'.repeat(32) }]) {
      const u = setup();
      try {
        r = u.run(['up'], { AWS_REGION: 'us-west-2', TESTBED_ALLOWED_CIDRS: '203.0.113.7/32', ...env });
        assert.equal(r.code, 1, JSON.stringify(env));
        assert.ok(!r.out.includes('X-Amz-Signature'), 'the query string is not echoed');
        assert.ok(!u.calls().some((c) => c[0] === 'terraform'), 'terraform never runs');
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
    assert.match(r.stdout, /runner URL wss:\/\/203\.0\.113\.50:8765\/rpa\/v1/);
    assert.match(r.stdout, /browser URL wss:\/\/203\.0\.113\.50:3000$/m);
    assert.match(r.stdout, /SSM: Online/);
    assert.match(r.stdout, /first boot: unknown/, 'no answer from the VM');
    const send = t.calls().find((c) => c.includes('send-command'));
    const params = JSON.parse(send[send.indexOf('--parameters') + 1]);
    assert.match(params.commands[0], /^\$d = 'C:\\Program Files\\RPA Test Bed'; if \(Test-Path -LiteralPath \(\$d \+ '\\setup\.done'\)\) \{ 'done' \} elseif \(Test-Path -LiteralPath \(\$d \+ '\\setup\.failed'\)\) \{ 'failed' \}/);
    // The setup appends to setup.log while it runs: status only asks whether the markers are there.
    assert.ok(!params.commands[0].includes('Select-String') && !params.commands[0].includes('Get-Content'), 'status does not open setup.log');
    for (const [answer, shown] of [['done', /first boot: finished$/m], ['failed', /first boot: FAILED \(see C:\\Program Files\\RPA Test Bed\\setup\.log on the VM\)$/m], ['running\r', /first boot: still running$/m], ['not started', /first boot: not started yet$/m], ['done\x1b[2J', /first boot: unknown/]]) {
      r = t.run(['status'], { FAKE_SSM_OUTPUT: answer });
      assert.equal(r.code, 0, r.out);
      assert.match(r.stdout, shown, answer);
      assert.ok(!r.stdout.includes('\x1b'), 'nothing but the fixed words reaches the terminal');
    }
    r = t.run(['status'], { FAKE_SSM_STATUS: 'Failed', FAKE_SSM_OUTPUT: 'done' });
    assert.equal(r.code, 0, 'a failed question does not fail status');
    assert.match(r.stdout, /first boot: unknown/);
  } finally { t.done(); }
});

test('fingerprint runs Show-RpaConnection.ps1', () => {
  const t = setup();
  try {
    t.brought();
    // What Show-RpaConnection.ps1 prints, with Windows line ends; only its two fingerprint lines are passed on.
    const shown = ['Runner URL: wss://10.90.0.10:8765/rpa/v1', `Runner fingerprint: ${FINGERPRINT}`, 'Browser URL: wss://10.90.0.10:3000', `Browser fingerprint: ${BROWSER_FINGERPRINT}`, 'Browser fingerprint: \x1b[2Jnot a fingerprint'].join('\r\n');
    let r = t.run(['fingerprint'], { FAKE_SSM_OUTPUT: shown });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.stdout, `Runner fingerprint: ${FINGERPRINT}\nBrowser fingerprint: ${BROWSER_FINGERPRINT}\n`);
    const send = t.calls().find((c) => c.includes('send-command'));
    assert.ok(send.includes('AWS-RunPowerShellScript') && send.includes(INSTANCE));
    const params = JSON.parse(send[send.indexOf('--parameters') + 1]);
    assert.deepEqual(params.commands, ["& 'C:\\Program Files\\RPA Runner\\scripts\\Show-RpaConnection.ps1'"], 'never with -ShowTokens');
    r = t.run(['fingerprint'], { FAKE_SSM_OUTPUT: `Runner fingerprint: ${FINGERPRINT}\r\nBrowser fingerprint: not known yet\r\nBrowser: not listening: see C:\\ProgramData\\RPA Runner\\logs\\browser.err.log` });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, `Runner fingerprint: ${FINGERPRINT}\nBrowser fingerprint: not known yet\n`);
    assert.match(r.stderr, /a fingerprint is not known yet/);
    r = t.run(['fingerprint'], { FAKE_SSM_OUTPUT: 'RPA is not installed here: C:\\Program Files\\RPA Runner\\install.json is missing. Run Install-Rpa.ps1 from the unpacked package.' });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Show-RpaConnection\.ps1 printed no fingerprint/);
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

test('install sends the package URL and hash over SSM and refuses a bad URL or a missing hash', () => {
  const t = setup();
  try {
    t.brought();
    const url = 'https://bucket.s3.amazonaws.com/rpa-windows-x64.zip?X-Amz-Expires=3600&X-Amz-Signature=deadbeef';
    let r = t.run(['install', url, 'CD'.repeat(32)], { FAKE_SSM_OUTPUT: 'installed' });
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes('X-Amz-'), 'the query string is not echoed');
    assert.match(r.stdout, /installing the package from https:\/\/bucket\.s3\.amazonaws\.com\/rpa-windows-x64\.zip \(/);
    const send = t.calls().find((c) => c.includes('send-command'));
    const params = JSON.parse(send[send.indexOf('--parameters') + 1]);
    assert.deepEqual(params.commands, [`& 'C:\\Program Files\\RPA Test Bed\\install-package.ps1' -Url '${url}' -Sha256 '${'CD'.repeat(32)}'`]);
    const sent = t.calls().length;
    const sha = 'ab'.repeat(32);
    for (const args of [
      ['install'], ['install', url], ['install', url, 'abc'], ['install', url, `${sha}'; calc; '`],
      ['install', 'http://example.com/p.zip', sha], ["install", "https://example.com/a'b.zip", sha], ['install', 'https://example.com/a b.zip', sha],
      ['install', 'https://example.com/a`b.zip', sha], ['install', 'https://example.com/a"b.zip', sha], ['install', 'https://example.com/a\u2019;calc;\u2019.zip', sha],
      ['install', 'https://example.com/p.zip?sig=secret-part\nrm', sha],
    ]) {
      r = t.run(args);
      assert.equal(r.code, 1, args.join(' '));
      assert.ok(!r.out.includes('secret-part'), 'a refused URL is not echoed with its query string');
    }
    assert.ok(!t.calls().slice(sent).some((c) => c.includes('send-command')), 'nothing is sent for a refused URL or hash');
    // What the messages show of a URL: nothing after ? or #, and no user name or password in front of the host.
    r = t.run(['install', 'https://user:pw-part@example.com:8443/a/rpa-windows-x64.zip#frag-part?sig=secret-part', sha], { FAKE_SSM_OUTPUT: 'done' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /installing the package from https:\/\/example\.com:8443\/a\/rpa-windows-x64\.zip \(/);
    for (const part of ['pw-part', 'frag-part', 'secret-part']) assert.ok(!r.out.includes(part), part);
    r = t.run(['install-runner', url, sha]);
    assert.equal(r.code, 2, 'install-runner is gone');
  } finally { t.done(); }
});

test('install-package.ps1 shows no query string and no password of a URL it cannot open', { skip: PWSH ? false : 'PowerShell (pwsh) is not installed' }, () => {
  // The script as the VM runs it over SSM (an upgrade), from a folder of its own, where it also keeps its log. These
  // URLs pass the character test and are no URLs: the script stops before it looks at the machine or downloads anything.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'install-package-test-')));
  try {
    const script = join(dir, 'install-package.ps1');
    copyFileSync(INSTALL_PACKAGE, script);
    for (const [url, shown] of [
      ['https://example.com:99999/a/rpa-windows-x64.zip?X-Amz-Signature=secret-part&x=1', 'https://example.com:99999/a/rpa-windows-x64.zip'],
      ['https://[::1/rpa-windows-x64.zip?X-Amz-Signature=secret-part', 'https://[::1/rpa-windows-x64.zip'],
      ['https://user:pw-part@example.com:99999/rpa-windows-x64.zip#frag-part?sig=secret-part', 'https://example.com:99999/rpa-windows-x64.zip'],
    ]) {
      rmSync(join(dir, 'install-package.log'), { force: true });
      const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', script, '-Url', url, '-Sha256', 'ab'.repeat(32)], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, NO_COLOR: '1' } });
      const log = readFileSync(join(dir, 'install-package.log'), 'utf8');
      assert.notEqual(r.status, 0, url);
      assert.ok(r.stdout.includes(`FAILED: The package URL is not a URL that can be opened: ${shown}\n`), r.stdout + r.stderr);
      assert.ok(log.includes(`FAILED: The package URL is not a URL that can be opened: ${shown}`), log);
      for (const part of ['secret-part', 'pw-part', 'frag-part', 'X-Amz-Signature']) {
        assert.ok(!(r.stdout + r.stderr).includes(part), `${part} is not in the output: ${r.stdout}${r.stderr}`);
        assert.ok(!log.includes(part), `${part} is not in the log: ${log}`);
      }
    }
    // A URL outside the character test is refused with words only.
    const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', script, '-Url', "https://example.com/a'b.zip?sig=secret-part", '-Sha256', 'ab'.repeat(32)], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, NO_COLOR: '1' } });
    assert.notEqual(r.status, 0);
    assert.ok(r.stdout.includes('FAILED: The package URL must be an https:// URL of plain URL characters, without spaces or quotes.\n'), r.stdout + r.stderr);
    assert.ok(!(r.stdout + r.stderr + readFileSync(join(dir, 'install-package.log'), 'utf8')).includes('secret-part'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
