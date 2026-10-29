# aws-ec2-desktop-runner

A Terraform module for a Windows Server 2022 test VM on EC2 that runs the RPA desktop runner. A dedicated low-privilege Windows user, `rpa-runner`, signs in on the console automatically. The runner starts in that user's interactive session at logon, because UI Automation needs a real, unlocked desktop. n8n's RPA Desktop Runner credential connects to it directly at `wss://<ip>:8765/rpa/v1`.

This is a test bed, not the production layout: one VM, one auto-signed-in user, a direct connection from the CIDRs you list. The production model (a supervisor service that opens a fresh session per run, no stored auto-logon password) comes later.

## What it creates

- **Network**, one of three:
  - by default, a VPC of its own (`10.90.0.0/24`) with one public subnet, an internet gateway and a default route. The VPC's default security group is emptied.
  - `use_default_vpc = true`: a default subnet of the region's default VPC
  - `subnet_id`: an existing subnet

  The zone is the first one, by name, that offers `instance_type`, unless you set `availability_zone`.
- **Security group:** the runner port (8765) and RDP (3389, unless `enable_rdp = false`) from `allowed_cidrs` only. Egress is TCP 80 and 443, which SSM, Secrets Manager, the runner download and Windows Update need.
- **The VM:** the latest Windows Server 2022 English Full AMI, found through the public SSM parameter. `t3.large` by default. IMDSv2 only, with one hop. An encrypted gp3 root volume. A role with `AmazonSSMManagedInstanceCore` and an inline policy that may only write the three secrets.
- **Three Secrets Manager secrets,** created empty. The VM fills them on first boot (see [Secrets](#secrets)).
- Optional: an Elastic IP (`elastic_ip = true`), so the runner URL survives stop and start.

Every resource carries the tag `Project = n8n-rpa-desktop-testbed`.

## What the first boot does

The user data is a small bootstrap that unpacks [`setup.ps1.tftpl`](setup.ps1.tftpl) and runs it once, as LocalSystem under EC2Launch v2. The setup script is gzipped and stripped of comments so it fits EC2's 16 KB limit. Progress goes to `%ProgramData%\RPA Runner\setup\setup.log`. The setup:

1. Gives the built-in Administrator a new random password and stores it in Secrets Manager. You need it for RDP.
2. Creates `rpa-runner`, a member of Users only, with a random password that never expires. Turns on auto-logon for it. See [Auto-logon](#auto-logon).
3. Turns off everything that locks or covers the desktop:
   - the lock screen (`NoLockScreen`) and the inactivity lock (`InactivityTimeoutSecs = 0`)
   - the screen saver and the Lock command (`DisableLockWorkstation`), in the default user profile, which rpa-runner's profile is copied from
   - Server Manager and the network-discovery prompt at logon, and display sleep
4. Locks down `%ProgramData%\RPA Runner`:
   - Administrators and SYSTEM own it.
   - rpa-runner may read it, create files (the runner's certificate) and write `logs\`.
   - rpa-runner can't change or delete `policy.json` or `token`, and can't write `setup\`, where SYSTEM logs the setup and runner installs.
5. Writes `policy.json` from `runner_policy` and the bearer token to `token`. The token file is readable by SYSTEM, Administrators and rpa-runner only.
6. Turns Windows Firewall on for every profile and adds two rules:
   - inbound on the runner port
   - an outbound block to the instance metadata service for rpa-runner, so neither the runner nor an app it drives can use the instance role
7. Writes `runner.json`, [`start-runner.ps1`](scripts/start-runner.ps1) and [`install-runner.ps1`](scripts/install-runner.ps1) to `C:\Program Files\RPA Runner\`. Downloads the runner there when `runner_artifact_url` is set. Registers the scheduled task `\RPA\RPA Runner`, which starts `start-runner.ps1` at rpa-runner's logon, interactive and limited.
8. Restarts the VM. rpa-runner signs in on the console and the task starts the runner.

`start-runner.ps1` restarts the runner whenever it exits. It writes the runner's output to `logs\runner.out.log` and `runner.err.log`; that is where `desktop-testbed.sh fingerprint` finds the certificate fingerprint. It passes the runner its settings in the environment:
- `RPA_RUNNER_TOKEN_FILE`, the path of the token file
- `RPA_RUNNER_POLICY_FILE`
- `RPA_RUNNER_PORT`

The token itself is never put in the environment, because apps the runner launches would inherit it.

Until a runner is installed, `start-runner.ps1` checks for one every 30 seconds.

## Secrets

The VM generates every secret itself, with the OS's cryptographic RNG. It writes each one to Secrets Manager (`secretsmanager:PutSecretValue`) before using it. No value ever appears in a Terraform plan, the state, an output, the user data or a log. The instance role can write these three secrets but not read them back. Terraform never reads them either.

| Secret (output) | Value | Also on the VM |
|---|---|---|
| `runner_token_secret_arn` | the runner's bearer token, 48 characters, for n8n's credential | `%ProgramData%\RPA Runner\token` (SYSTEM, Administrators, rpa-runner) |
| `runner_user_password_secret_arn` | rpa-runner's password | the LSA secret `DefaultPassword` |
| `admin_password_secret_arn` | the built-in Administrator's password | the SAM, as for any account |

For the credential, export the token in your shell straight from Secrets Manager; never paste it into a file:

```sh
export RPA_RUNNER_TOKEN="$(aws secretsmanager get-secret-value --region <region> \
  --secret-id "$(terraform output -raw runner_token_secret_arn)" --query SecretString --output text)"
```

The secrets' ARNs, the runner URL and `runner_policy` are in the user data and the state. None of them is a secret. `runner_artifact_url` is too, so use a public release asset or a short-lived pre-signed URL.

## Auto-logon

Winlogon signs rpa-runner in with these values:
- `AutoAdminLogon = 1`, `DefaultUserName`, `DefaultDomainName` (the computer name)
- `ForceAutoLogon = 1`, which signs rpa-runner in again if it signs out

The password is **not** in the registry. The setup stores it as the LSA secret `DefaultPassword` through `LsaStorePrivateData`, the way Sysinternals Autologon does. It removes any `DefaultPassword` registry value. Winlogon reads the LSA secret.

The LSA secret is protected by the system, not encrypted against an administrator: anyone with administrator rights on the VM can read it. That is the cost of attended-style auto-logon. It is why rpa-runner is a standard user with no other purpose, and why its password is random and kept nowhere else but Secrets Manager.

## Example

[`deploy/terraform/examples/aws-ec2-desktop-runner`](../../examples/aws-ec2-desktop-runner) wires the module with `allowed_cidrs` as its one required input. [`deploy/scripts/desktop-testbed.sh`](../../../scripts/desktop-testbed.sh) drives it. It keeps the Terraform state in `TESTBED_STATE_DIR`, a directory it refuses inside the repository.

```sh
export TESTBED_STATE_DIR=~/rpa-testbed-state        # anywhere outside the repository
export AWS_REGION=us-west-2
deploy/scripts/desktop-testbed.sh up                # allowed_cidrs = this machine's public IPv4 /32
deploy/scripts/desktop-testbed.sh status            # state, runner URL, SSM
deploy/scripts/desktop-testbed.sh install-runner https://.../rpa-desktop-runner-win-x64.zip <sha256>
deploy/scripts/desktop-testbed.sh fingerprint       # for the credential's fingerprint field
deploy/scripts/desktop-testbed.sh rdp-password      # copies the Administrator password to the clipboard
deploy/scripts/desktop-testbed.sh stop              # stop paying for the instance
deploy/scripts/desktop-testbed.sh start             # the public IP changes unless elastic_ip
deploy/scripts/desktop-testbed.sh down
```

`up` passes extra arguments to `terraform apply`, for example `-auto-approve`. The first boot takes about 10 minutes, including the restart.

## Inputs

| Name | Default | Notes |
|---|---|---|
| `allowed_cidrs` | required | Who may reach the runner port and RDP. 0.0.0.0/0, ::/0, and ranges wider than /16 (IPv4) or /48 (IPv6) are refused: a /8 can hold other AWS customers. Host bits must be zero. |
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
| `runner_port` | 8765 | |
| `runner_artifact_url`, `runner_artifact_sha256` | empty | A zip of the win-x64 publish, or the `.exe`. A set hash is checked. A changed URL replaces the VM; `install-runner` doesn't. |
| `runner_executable` | `rpa-desktop-runner.exe` | |
| `runner_arguments` | `[]` | Never the token |
| `runner_policy` | allows `ErpDemo.exe` | The contract's policy: `allowedApps`, `writeControls`, `gatedKeys`, `maxFileBytes` |
| `secret_recovery_window_days` | 7 | 0 deletes the secrets at once on destroy |
| `tags` | `{}` | |

## Outputs

`instance_id`, `region`, `public_ip`, `private_ip`, `runner_url`, `runner_token_secret_arn`, `runner_user_password_secret_arn`, `admin_password_secret_arn`, `fingerprint_command`, `security_group_id`, `vpc_id`, `subnet_id`.

- `public_ip` and `runner_url` are the address at apply time. Without `elastic_ip` it changes on every stop and start; `desktop-testbed.sh status` shows the current one.
- `fingerprint_command` is an AWS CLI command line. It searches the `*.log` files in `%ProgramData%\RPA Runner` and its `logs\` folder (no recursion) through SSM Run Command and prints the newest SHA-256 fingerprint (colon-separated uppercase hex). `desktop-testbed.sh fingerprint` does the same.

## Cost

While running, you pay for the instance, including the Windows licence, and its public IPv4 address. With `cpu_credits = "unlimited"` (the default), CPU use above the t3 baseline, averaged over 24 hours, is billed too; the first boot and Windows' own maintenance cost a little of that. `standard` avoids it at the price of a slower boot. While stopped, you pay for the gp3 volume and the three secrets, plus the Elastic IP if you set one. `desktop-testbed.sh stop` stops the instance; `down` destroys everything. Nothing else runs: no NAT gateway, no load balancer, no CloudWatch alarms or logs.

## Security notes

- **Exposure:** only `allowed_cidrs`, only the runner port and RDP. The runner refuses plain `ws://` and checks the bearer token. n8n pins the runner's certificate fingerprint before sending the token.
- **RDP as Administrator** opens a session of its own and leaves rpa-runner's console session alone. Don't RDP in as rpa-runner: disconnecting that session locks its desktop, and the runner then reports `desktop_unavailable` until the VM restarts.
- **The instance role** can use SSM and write, never read, its three secrets. rpa-runner can't reach the instance metadata service, so it can't use the role at all. Administrators and SYSTEM can, with two consequences:
  - `AmazonSSMManagedInstanceCore` also allows `ssm:GetParameter(s)` on every parameter, so an administrator on the VM could read the account's SecureString parameters in the region. Keep the test bed in an account without production parameters, or replace the managed policy with an inline one limited to `ssm:UpdateInstanceInformation`, `ssmmessages:*Channel` and `ec2messages:*`.
  - The role keeps `PutSecretValue` after the first boot, so an administrator on the VM could replace a secret's value.
- **The runner and the apps it drives run as the same user.** A driven app could read the token file, stop the runner or take its port. The ACL on `policy.json` only keeps the runner itself from changing its policy; it is no boundary against the apps. Only allow apps you trust in `runner_policy`; the production model runs them under separate users.
- **Egress** on 80 and 443 to anywhere is open to the driven apps as well.

## Unverified until the runner exists

The runner itself isn't released yet. With the runner installed, check:
- that it reads `RPA_RUNNER_TOKEN_FILE`, `RPA_RUNNER_POLICY_FILE` and `RPA_RUNNER_PORT`. If it takes other names or flags, adjust `start-runner.ps1` or set `runner_arguments`.
- that it can write its certificate under `%ProgramData%\RPA Runner\`
- that it prints its fingerprint to stdout or stderr, or logs it under that directory as a `*.log` file

## Tests

`make -C deploy check` runs `terraform fmt`, `validate`, `terraform test` and tflint here. `terraform test` runs plan-only against a mocked AWS provider. It asserts:
- the security group rules, with a structural check that no other rule resources, inline rules or all-protocol rules exist
- IMDSv2, the encrypted root volume, the tags and the placement in each network mode
- the role: SSM, plus `PutSecretValue` on exactly the three secrets, and with a key, `kms:GenerateDataKey` through Secrets Manager only
- the user data:
  - under 10 KB
  - the setup gzipped inside it
  - the policy, runner settings and ARNs base64-encoded
  - never a `DefaultPassword` registry write
- the outputs
- the input validations (0.0.0.0/0, ::/0, /1, /8, IPv6 /32, host bits, Arm types, http:// URLs, quotes, short hashes)

`deploy/scripts/test/desktop-testbed.test.mjs` runs `desktop-testbed.sh` against fake `terraform`, `aws`, `curl` and `pbcopy` commands.
