# aws-ec2-desktop-runner

A Terraform module for a Windows Server 2022 test VM on EC2 that runs the RPA desktop runner and the RPA browser. With `package_url` and `package_sha256` set, the first boot downloads the RPA Windows package and runs the package's own installer, `Install-Rpa.ps1`, the same one you would run by hand on any Windows machine. The installer creates a dedicated standard Windows user, `rpa-runner`, which signs in on the console automatically. Both programs start in that user's interactive session at logon, because UI Automation and a visible browser need a real, unlocked desktop. n8n's RPA Desktop Runner credential connects to `wss://<ip>:8765/rpa/v1`, and its RPA Browser credential to `wss://<ip>:3000`.

Without `package_url` the VM comes up with the test-bed setup only and nothing of the product installed (see [Without a package](#without-a-package)).

This is a test bed, not the production layout: one VM, one auto-signed-in user, a direct connection from the CIDRs you list. The production model (a supervisor service that opens a fresh session per run, no stored sign-in password) comes later.

## What it creates

- **Network**, one of three:
  - by default, a VPC of its own (`10.90.0.0/24`) with one public subnet, an internet gateway and a default route. The VPC's default security group is emptied.
  - `use_default_vpc = true`: a default subnet of the region's default VPC
  - `subnet_id`: an existing subnet

  The zone is the first one, by name, that offers `instance_type`, unless you set `availability_zone`.
- **Security group:** the runner port (8765), the browser port (3000) and RDP (3389, unless `enable_rdp = false`) from `allowed_cidrs` only. This is what limits who reaches the two programs: Windows Firewall on the VM lets the two ports in from any address (see [Who can reach the ports](#who-can-reach-the-ports)). A changed `allowed_cidrs` updates the rules in place; it does not replace the VM. Egress is TCP 80 and 443, which SSM, Secrets Manager, the package download and Windows Update need.
- **The VM:** the latest Windows Server 2022 English Full AMI, found through the public SSM parameter. `t3.large` by default. IMDSv2 only, with one hop. An encrypted gp3 root volume. A role with `AmazonSSMManagedInstanceCore` and an inline policy that may only write the four secrets.
- **Four Secrets Manager secrets,** created empty. The VM fills them on first boot (see [Secrets](#secrets)).
- Optional: an Elastic IP (`elastic_ip = true`), so the URLs survive stop and start.

Every resource carries the tag `Project = n8n-rpa-desktop-testbed`.

## What the first boot does

The user data is a small bootstrap that unpacks [`setup.ps1.tftpl`](setup.ps1.tftpl) and runs it once, as LocalSystem under EC2Launch v2. The setup script is gzipped and stripped of comments so it fits EC2's 16 KB limit. It does what is specific to the test bed and leaves the product to the installer. Its files are in `C:\Program Files\RPA Test Bed\`, a folder it creates for SYSTEM and Administrators only: `setup.log` (progress), `setup.done` or `setup.failed`, `install-package.ps1` and its log, and the policy change file. In order:

1. Turns Windows Firewall on for every profile and adds an outbound rule, `RPA-TestBed-No-IMDS`, that blocks the instance metadata address (169.254.169.254) for every member of the Windows group Users (see [The instance metadata blocks](#the-instance-metadata-blocks)). This comes first, before any secret is written and before anything of the product.
2. Sets the access of the Windows PowerShell event log (`Microsoft-Windows-PowerShell/Operational`) to SYSTEM and Administrators. Windows PowerShell can record the text of scripts it runs in that log, and the setup script's text holds `package_url`.
3. Gives the built-in Administrator a new random password and stores it in Secrets Manager. You need it for RDP.
4. Writes [`install-package.ps1`](scripts/install-package.ps1) to the test bed's folder.

With `package_url` set, it goes on:

5. Makes a random password for `rpa-runner`, stores it in Secrets Manager, and runs `install-package.ps1` (see [The package](#the-package)), which ends in:

   ```
   Install-Rpa.ps1 -User rpa-runner -UserPassword <the password, as a SecureString> -RunnerPort <runner_port>
                   -BrowserPort <browser_port> -AllowFromAnyAddress -IncludePublicNetwork -AutoSignIn -Force
   ```

   The installer does the rest of what this module used to do itself, and what it does is described in the header of [`Install-Rpa.ps1`](../../../../desktop/installer/Install-Rpa.ps1): the user (a member of Users only), automatic sign-in and the no-lock settings, the programs under `C:\Program Files\RPA Runner`, the data directory `%ProgramData%\RPA Runner` with its access rules, a starter policy that allows no app, the two tokens, the scheduled tasks `\RPA\RPA Runner` and `\RPA\RPA Browser`, and the Windows Firewall rules `RPA-Runner-In` and `RPA-Browser-In`. Straight after the installer returns, `install-package.ps1` adds the second metadata rule, `RPA-Runner-No-IMDS`, for `rpa-runner` by its SID.
6. Reads the two tokens the installer made and stores them in Secrets Manager.
7. Applies `runner_policy` with the package's policy tool (see [The policy](#the-policy)).
8. Writes `setup.done` and restarts the VM. `rpa-runner` signs in on the console and the two tasks start the runner and the browser.

A step that fails ends the setup there: it writes the marker `setup.failed`, `setup.log` gets a line `setup FAILED at line <n>: <reason>`, with the lines of `install-package.ps1`, the installer and the policy tool above it, and the VM does not restart. Nothing runs the setup again; fix the input and replace the VM. `desktop-testbed.sh status` says whether the first boot finished, failed or is still running, from whether `setup.done`, `setup.failed` and `setup.log` are there; it does not open the log, which the setup appends to while it runs.

### Who can reach the ports

The installer is run with `-AllowFromAnyAddress -IncludePublicNetwork`: its two Windows Firewall rules let the runner port and the browser port in from any address, on every kind of network. In this test bed the security group in front of the VM is what limits them to `allowed_cidrs`, as it was before the installer existed. The CIDRs are deliberately not passed to the VM. They would be part of the user data, and a change of the user data replaces the VM, with new passwords, tokens and certificates; `desktop-testbed.sh up` takes your current public address by default, so a second `up` from another network would do that.

This is a choice for this module only. On a machine without such a filter in front of it, name the n8n host instead: `Install-Rpa.ps1 -AllowFrom <n8n address>`.

### The instance metadata blocks

Two outbound Windows Firewall rules block TCP to 169.254.169.254, where the instance role's credentials are handed out:

- **`RPA-TestBed-No-IMDS`**, for every member of the Windows group Users (`-LocalUser 'D:(A;;CC;;;BU)'`). The first boot adds it before anything else, with or without a package. It names no user of the product, so it is there for a bot user of any name: one a hand install creates later, and one left behind by an install that failed half way. SYSTEM is not a member of Users, and the SSM agent and the first boot's secret writes run as SYSTEM. An administrator who signs in (over RDP, for example) usually is a member of Users, so expect the address to be blocked in that session as well; an administrator can remove the rule.
- **`RPA-Runner-No-IMDS`**, for the bot user by its SID. `install-package.ps1` adds it, or changes an existing rule of that name in place, straight after the installer returns, at first boot and at every `desktop-testbed.sh install`.

The rules stop a connection to that address from a process of those users. They do nothing about credentials an administrator or SYSTEM hands on.

**Not run on a machine yet:** the Users-wide rule is new and has only been written, not tried. What a first boot has to show is that the SSM agent stays online (also after the role's credentials have been renewed, some hours later), that the secret writes that follow the rule work, and that a request to the metadata address fails as `rpa-runner`.

## The package

[`install-package.ps1`](scripts/install-package.ps1) runs as SYSTEM: at first boot, or later through `desktop-testbed.sh install <url> <sha256>` over SSM, without a new VM. It:

1. Downloads the zip from the `https://` URL into a new folder under `C:\Program Files\RPA Test Bed\pkg\`, created for SYSTEM and Administrators only. Nothing is downloaded or unpacked under a temp folder.
2. Compares the zip's SHA-256 with the one given and stops when they differ. Nothing is unpacked or run before that. The hash is required everywhere: by the module (`package_sha256`), by `desktop-testbed.sh` and by the script. The hash is what ties the download to the package you chose; the URL only says where the file is.
3. Unpacks the zip after checking that every entry lands inside its one top folder, `rpa-windows-x64`.
4. Runs `Install-Rpa.ps1` from there, inside the same PowerShell: the password is handed over as a `SecureString` and is not put on a command line. The installer itself reads who could change the unpacked package and refuses to run when that is anyone but administrators.
5. Adds or updates the metadata rule for the bot user, `RPA-Runner-No-IMDS` (see [The instance metadata blocks](#the-instance-metadata-blocks)), whatever the installer reported, as long as its user is there.
6. Removes the unpacked package, and says so in its log when it could not.

Over SSM the script takes only the URL and the hash and runs the installer as an upgrade, with `-Force` and the user and ports the install was made with. The installer then replaces the programs and keeps the user, the data, the policy, the tokens and the firewall choice of the install; a run in progress fails. It does not make a first install: on a VM without the product it stops with a message.

The script writes its own lines and the installer's to `install-package.log` beside it and to its output. It writes the URL there without its query string (where a pre-signed URL carries its signature) and without a user name or password in front of the host, also when it fails on a URL it cannot open.

The zip must be somewhere the VM can fetch it over HTTPS without a login: a release asset, or a private S3 bucket and a pre-signed URL valid for an hour. `package_url` is stored in the user data and the state, so never use a URL with a long-lived credential in it.

### Without a package

With `package_url` and `package_sha256` empty (the default), the first boot stops after step 4 and does not restart. That leaves you:

- a Windows Server 2022 VM with the Administrator password in Secrets Manager (`desktop-testbed.sh rdp-password`), Windows Firewall on, the metadata block for members of Users, SSM, and `C:\Program Files\RPA Test Bed\` with `install-package.ps1`, `setup.log` and `setup.done`
- no `rpa-runner` user, no programs, no data directory, no scheduled tasks, no firewall rules of the product; the token and `rpa-runner` password secrets stay empty
- the runner and browser ports open in the security group to `allowed_cidrs`, with nothing listening and no Windows Firewall rule behind them

This is the clean machine for trying the installer by hand: RDP in as Administrator, unpack the package in a folder only administrators can change, and run `Install-Rpa.ps1` as its header describes. What the first boot would have done besides, and does not do for a hand install:

- The bot user you create is a member of Users, so `RPA-TestBed-No-IMDS` covers it. The rule by SID, `RPA-Runner-No-IMDS`, is added the first time you run `desktop-testbed.sh install`.
- The tokens are not in Secrets Manager. `Show-RpaConnection.ps1 -ShowTokens` shows them on the VM.
- `runner_policy` is not applied. Use `RpaPolicy.exe` on the VM.

After a first install made by hand, `desktop-testbed.sh install` upgrades it like any other.

## Secrets

No secret is in a Terraform plan, the state, an output, the user data or a log the setup writes. The VM writes each one to Secrets Manager (`secretsmanager:PutSecretValue`). The instance role can write these four secrets but not read them back, and Terraform never reads them either.

| Secret (output) | Value | Made by | Also on the VM |
|---|---|---|---|
| `admin_password_secret_arn` | the built-in Administrator's password | the first boot, with the OS's cryptographic RNG; stored before it is set | the SAM, as for any account |
| `runner_user_password_secret_arn` | `rpa-runner`'s password | the first boot, the same way; stored before the installer gets it | the LSA secret `DefaultPassword` (automatic sign-in) |
| `runner_token_secret_arn` | the runner's bearer token, for n8n's RPA Desktop Runner credential | the installer; copied after the install | `%ProgramData%\RPA Runner\token` (SYSTEM, Administrators, rpa-runner) |
| `browser_token_secret_arn` | the browser's bearer token, for n8n's RPA Browser credential | the installer; copied after the install | `%ProgramData%\RPA Runner\browser-token` (the same three) |

The last three are written only when `package_url` is set.

For a credential, export the token in your shell straight from Secrets Manager; never paste it into a file:

```sh
export RPA_RUNNER_TOKEN="$(aws secretsmanager get-secret-value --region <region> \
  --secret-id "$(terraform output -raw runner_token_secret_arn)" --query SecretString --output text)"
```

The secrets' ARNs, the two ports, `runner_policy`, `package_url` and `package_sha256` are in the user data and the state (`allowed_cidrs` is in the state only). None of them is a secret, as long as `package_url` is a public release asset or a short-lived pre-signed URL.

## Automatic sign-in

The installer's `-AutoSignIn` sets it up, and its header lists what that changes for the whole machine. In short: Winlogon signs `rpa-runner` in at every start and again after a sign-out, the lock screen and the idle lock are off, and the password is stored as the LSA secret `DefaultPassword`, not in the registry.

The LSA secret is protected by the system, not encrypted against an administrator: anyone with administrator rights on the VM can read it. That is the cost of attended-style automatic sign-in. It is why `rpa-runner` is a standard user with no other purpose, and why its password is random and kept nowhere else but Secrets Manager.

## The policy

The installer writes a starter policy that allows no app. `runner_policy` is what the test bed adds to it. The first boot writes it as a change file, `C:\Program Files\RPA Test Bed\policy-change.json`, and applies it with the package's policy tool:

```
"C:\Program Files\RPA Runner\runner\RpaPolicy.exe" apply "C:\Program Files\RPA Test Bed\policy-change.json" --yes
```

The tool honours `--yes` only when every other process attached to its console is elevated; otherwise it prints the change and asks `Apply these changes? [y/N]`. Nobody is there to answer at a first boot, so the setup also puts `y` on the tool's standard input. What the tool prints, including the lines that describe the change, goes to `setup.log`; a line `RpaPolicy: --yes is ignored: ...` there means the piped answer was read, and its absence that `--yes` was honoured. Which of the two a first boot takes has not been observed yet. The call works this way only while the tool's output and input stay piped: with its output on a console the tool first checks the size of that console's buffer and can refuse to ask, and with its input on a console it waits for Enter before it exits. When the tool refuses the change or fails, the setup fails with `RpaPolicy.exe did not apply the policy change (exit code <n>)` and the starter policy stays.

The default change:

```json
{
  "allowedApps": [
    { "exe": "ErpDemo.exe", "path": "C:\\Program Files\\RPA Runner\\erp-demo\\v1\\ErpDemo.exe", "allowedArgs": [["--ui", "v1"], ["--ui", "v2"]] }
  ],
  "writeControls": [
    { "exe": "ErpDemo.exe", "automationId": "btnPost" },
    { "exe": "ErpDemo.exe", "automationId": "1" }
  ],
  "gatedKeys": ["Ctrl+S", "F11"]
}
```

- `allowedApps`: the only executables `app.launch` starts.
  - `exe` is the file name a step set names.
  - `path` (required) is the absolute local path that runs. It must end in `exe`; UNC and device paths and short (8.3) names are refused.
  - `sha256` (optional) pins the file's hash.
  - `allowedArgs` (optional) lists the exact argument lists a launch may pass; without it, none.
  - `allowUserWritable` (optional, default false) permits a path the bot user could change or replace.
- `writeControls`: controls (process and automation id) that act only with `write: true`. The default lists the demo app's Post button and automation id `1`, which Windows gives the OK or Save button of a common dialog: that gates the Save of the demo's Export dialog, so the export step must be signed as a write. It gates every OK and Save button of a common dialog owned by `ErpDemo.exe` (Open, Save As, Print), and while such a dialog is open, keys without `write: true` are limited to navigation keys (Tab, arrows, Home, End, PageUp, PageDown, Escape).
- `gatedKeys`: key chords that need `write: true`.

What `runner_policy` does not carry:

- **`maxFileBytes`.** The policy tool does not change the file size limit, so it stays at the installer's default (20 MiB). A `maxFileBytes` in `runner_policy` is ignored. To change the limit, edit `policy.json` on the VM as an administrator.
- **`helperProcesses` and `clipboardRead`.** The tool accepts them in a change, but this module has no input for them. Apply such a change on the VM with `RpaPolicy.exe`.
- **Removals.** A change only adds. `desktop/README.md` ("Changing the policy") describes the tool.

Some of the tool's limits for one change are also checked at plan time, so that a plan fails and not a first boot: at most 40 entries (apps, their argument lists, write controls and gated keys together), at most 20 arguments in a list, at most 260 characters in an app's or write control's name, path, id or argument, and no short (8.3) name in a path. Only the tool checks the rest, at first boot: the 8,000 characters its summary of the change may have, the 260 characters of a gated key, the form of a key chord, and whatever the runner itself would refuse in the resulting policy. A change that fails there fails the setup.

## Example

[`deploy/terraform/examples/aws-ec2-desktop-runner`](../../examples/aws-ec2-desktop-runner) wires the module with `allowed_cidrs` as its one required input. [`deploy/scripts/desktop-testbed.sh`](../../../scripts/desktop-testbed.sh) drives it. It keeps the Terraform state in `TESTBED_STATE_DIR`, a directory it refuses inside the repository.

```sh
export TESTBED_STATE_DIR=~/rpa-testbed-state        # anywhere outside the repository
export AWS_REGION=us-west-2
export TESTBED_PACKAGE_URL=https://.../rpa-windows-x64.zip   # with TESTBED_PACKAGE_SHA256; leave both out for a clean VM
export TESTBED_PACKAGE_SHA256=<sha256>
deploy/scripts/desktop-testbed.sh up                # allowed_cidrs = this machine's public IPv4 /32
deploy/scripts/desktop-testbed.sh status            # state, URLs, SSM, and whether the first boot finished
deploy/scripts/desktop-testbed.sh fingerprint       # both fingerprints, for the credentials' fingerprint fields
deploy/scripts/desktop-testbed.sh install https://.../rpa-windows-x64.zip <sha256>   # upgrade, no new VM
deploy/scripts/desktop-testbed.sh rdp-password      # copies the Administrator password to the clipboard
deploy/scripts/desktop-testbed.sh stop              # stop paying for the instance
deploy/scripts/desktop-testbed.sh start             # the public IP changes unless elastic_ip
deploy/scripts/desktop-testbed.sh down
```

`up` passes extra arguments to `terraform apply`, for example `-auto-approve`. Without a package the first boot takes about 10 minutes; with one, add the download, the install and the restart.

## Inputs

| Name | Default | Notes |
|---|---|---|
| `allowed_cidrs` | required | Who may reach the runner port, the browser port and RDP: the security group's rules. Not passed to the VM, so a change updates the rules in place ([Who can reach the ports](#who-can-reach-the-ports)). 0.0.0.0/0, ::/0, and ranges wider than /16 (IPv4) or /48 (IPv6) are refused: a /8 can hold other AWS customers. Host bits must be zero. |
| `name` | `rpa-desktop-testbed` | Name and prefix of every resource |
| `instance_type` | `t3.large` | x86_64 only; Graviton types are refused |
| `cpu_credits` | `unlimited` | t2/t3/t3a only. `standard` throttles, which makes the first boot slow. |
| `ami_ssm_parameter` | Windows Server 2022 English Full | Later AMI changes are ignored; replace the VM to move to a newer one |
| `root_volume_size_gb` | 50 | 30 to 1024 GiB |
| `kms_key_arn` | null | A customer managed key for the volume and the secrets |
| `subnet_id`, `use_default_vpc`, `vpc_cidr`, `availability_zone` | own VPC | See [What it creates](#what-it-creates) |
| `associate_public_ip` | true | Must stay true in the module's own VPC |
| `elastic_ip` | false | A fixed address; billed while the VM is stopped too |
| `enable_rdp` | true | SSM works without RDP |
| `runner_port` | 8765 | The installer's `-RunnerPort`. With a package, a change replaces the VM. |
| `browser_port` | 3000 | The installer's `-BrowserPort`. Must differ from `runner_port`. With a package, a change replaces the VM. |
| `package_url`, `package_sha256` | empty | The RPA Windows package and its SHA-256, both or neither ([The package](#the-package)). A URL without a hash is refused. A changed URL replaces the VM; `desktop-testbed.sh install` doesn't. |
| `runner_policy` | allows ERP Demo v1 | Applied with `RpaPolicy.exe` when `package_url` is set. See [The policy](#the-policy) |
| `secret_recovery_window_days` | 7 | 0 deletes the secrets at once on destroy |
| `tags` | `{}` | |

`runner_artifact_url`, `runner_artifact_sha256`, `runner_executable` and `runner_arguments` are gone: `package_url` and `package_sha256` take the place of the first two, and the installer decides what the other two set.

## Outputs

`instance_id`, `region`, `public_ip`, `private_ip`, `runner_url`, `browser_url`, `runner_token_secret_arn`, `browser_token_secret_arn`, `runner_user_password_secret_arn`, `admin_password_secret_arn`, `fingerprint_command`, `security_group_id`, `vpc_id`, `subnet_id`.

- `public_ip`, `runner_url` and `browser_url` are the address at apply time. Without `elastic_ip` it changes on every stop and start; `desktop-testbed.sh status` shows the current one.
- `fingerprint_command` is an AWS CLI command line. It runs the package's `Show-RpaConnection.ps1` on the VM through SSM Run Command, never with `-ShowTokens`, and prints its two fingerprint lines: `Runner fingerprint: <SHA-256>` and `Browser fingerprint: <SHA-256>` (colon-separated uppercase hex), or `not known yet` for a program that has not started. `desktop-testbed.sh fingerprint` does the same and passes on only lines of exactly that form. The runner's fingerprint is read from a log the bot user can write and the browser's from a certificate file it can write, so both are what the VM's bot user reports.

## Cost

While running, you pay for the instance, including the Windows licence, and its public IPv4 address. With `cpu_credits = "unlimited"` (the default), CPU use above the t3 baseline, averaged over 24 hours, is billed too; the first boot and Windows' own maintenance cost a little of that. `standard` avoids it at the price of a slower boot. While stopped, you pay for the gp3 volume and the four secrets, plus the Elastic IP if you set one. `desktop-testbed.sh stop` stops the instance; `down` destroys everything. Nothing else runs: no NAT gateway, no load balancer, no CloudWatch alarms or logs.

## Security notes

- **Exposure:** only `allowed_cidrs`, only the runner port, the browser port and RDP, by the security group. Windows Firewall on the VM does not repeat that list: it lets the two ports in from any address, so whoever can change the security group decides who reaches them. The runner and the browser serve TLS only and check their bearer tokens. With the fingerprints in n8n's credentials, n8n checks each certificate before it sends a token.
- **What runs as SYSTEM at first boot, and what it trusts.** The setup script comes from the user data. It downloads one file, the package, over HTTPS, and trusts it only after its SHA-256 matches `package_sha256`. Whoever can change the module's inputs or the instance's user data chooses both the URL and the hash, and so chooses what runs as SYSTEM; that is the same trust as applying the Terraform configuration. After the hash check the package is unpacked and run from a folder only SYSTEM and Administrators can change.
- **The user data** holds the setup script, the secrets' ARNs, the two ports, `runner_policy`, `package_url` and `package_sha256`. Anyone who may call `ec2:DescribeInstanceAttribute` on the instance can read it, and so can any process on the VM that can reach the instance metadata service (SYSTEM; the two firewall rules block members of Users and the bot user). So `package_url` is not a place for a long-lived credential.
- **The Windows PowerShell event log.** Windows PowerShell can record the text of scripts it runs in `Microsoft-Windows-PowerShell/Operational`, and the setup script's text includes `package_url`. The first boot sets that log's access to SYSTEM and Administrators (`wevtutil sl ... /ca:O:BAG:SYD:(A;;0xf0007;;;SY)(A;;0x7;;;BA)`), so any other reader the log had (the Event Log Readers group, for one) loses it. Who could read the log before that on this Windows was not checked on a machine, and neither was the command.
- **The passwords and tokens on their way to Secrets Manager.** Each value is text inside the setup's PowerShell process while it is handed to the AWS Tools cmdlet that writes it, over HTTPS, with the instance role. If PowerShell module logging is turned on for the VM (Windows has it off unless someone turns it on), Windows records that cmdlet's parameters, the value among them, in the VM's event log. The setup writes no secret to its own log or output.
- **`desktop-testbed.sh install`** sends one PowerShell command line over SSM Run Command: the path of `install-package.ps1`, the URL and the hash. SSM keeps that command, with the URL and its query string, in its command history; use a short-lived URL. The URL travels inside single quotes; `desktop-testbed.sh` and the script on the VM refuse a URL that holds a quote, a space, a backtick or a character outside ASCII.
- **RDP as Administrator** opens a session of its own and leaves `rpa-runner`'s console session alone. Don't RDP in as `rpa-runner`: disconnecting that session locks its desktop, and the runner then reports `desktop_unavailable` until the VM restarts.
- **The instance role** can use SSM and write, never read, its four secrets. Two outbound firewall rules block the metadata address, where the role's credentials come from, for members of Users and for the bot user ([The instance metadata blocks](#the-instance-metadata-blocks)). SYSTEM reaches it, and an administrator can remove the rules, with two consequences:
  - `AmazonSSMManagedInstanceCore` also allows `ssm:GetParameter(s)` on every parameter, so an administrator on the VM could read the account's SecureString parameters in the region. Keep the test bed in an account without production parameters, or replace the managed policy with an inline one limited to `ssm:UpdateInstanceInformation`, `ssmmessages:*Channel` and `ec2messages:*`.
  - The role keeps `PutSecretValue` after the first boot, so an administrator on the VM could replace a secret's value.
- **The two programs and the apps the runner drives run as the same user.** A driven app could read the token files, stop the runner or take its port. The access rules on `policy.json` only keep the runner itself from changing its policy; they are no boundary against the apps. Only allow apps you trust in `runner_policy`; the production model runs them under separate users.
- **Egress** on 80 and 443 to anywhere is open to the driven apps and the browser as well.

## Tests

`make -C deploy check` runs `terraform fmt`, `validate`, `terraform test` and tflint here. `terraform test` runs plan-only against a mocked AWS provider. It asserts:
- the security group rules (runner, browser and RDP ports, each from the allowed CIDRs only), with a structural check that no other rule resources, inline rules or all-protocol rules exist
- IMDSv2, the encrypted root volume, the tags and the placement in each network mode
- the role: SSM, plus `PutSecretValue` on exactly the four secrets, and with a key, `kms:GenerateDataKey` through Secrets Manager only
- the user data:
  - under 10 KB without a package, under 12 KB with one
  - the setup gzipped inside it
  - the package URL and hash, the allowed CIDRs, the policy change and the ARNs base64-encoded
  - no step the installer does (no user, no sign-in setup, no access rules on the data directory, no inbound rule, no scheduled task)
  - the installer called with `-User`, `-UserPassword`, `-AllowFromAnyAddress -IncludePublicNetwork`, `-AutoSignIn` and `-Force`, and the hash compared before the zip is opened
  - the metadata block for members of Users before any secret write and any product step, with and without a package; the block for the bot user after the installer returns
  - no allowed CIDR in it: a change of `allowed_cidrs` leaves the user data as it is
  - the token files read only after the install, and no password or token written to a log, a file or the output
  - without `package_url`: no download, no install, no token read, no restart
- the outputs
- the input validations (0.0.0.0/0, ::/0, /1, /8, IPv6 /32, host bits, Arm types, a package URL without its hash and a hash without its URL, http:// URLs, quotes, short hashes, equal ports, a policy change over the policy tool's limits)

One run also reads `desktop/installer/Install-Rpa.ps1`: `install-package.ps1` takes the installer's line `RPA is installed.` as its sign of success, and the test fails when the installer no longer prints exactly that line.

These tests read the rendered script; they do not run it. The first-boot script and `install-package.ps1` run only on a real VM, and no first boot has been run with this version yet.

`deploy/scripts/test/desktop-testbed.test.mjs` runs `desktop-testbed.sh` against fake `terraform`, `aws`, `curl` and `pbcopy` commands. Where PowerShell 7 (`pwsh`) is installed, it also runs `install-package.ps1` itself with URLs it cannot open and checks that neither its output nor its log holds their query string.
