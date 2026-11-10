#!/usr/bin/env bash
# The RPA desktop test bed: a Windows Server 2022 VM on EC2 (deploy/terraform/examples/aws-ec2-desktop-runner). With a
# package (TESTBED_PACKAGE_URL and TESTBED_PACKAGE_SHA256) the first boot installs the RPA Windows package with its own
# installer: the user rpa-runner signs in on the console, and the runner and the browser start at its logon. Without
# one the VM comes up with nothing of the product installed.
#
#   TESTBED_STATE_DIR=<dir outside this repository> deploy/scripts/desktop-testbed.sh <command>
#
#   up [apply args]          terraform init + apply (asks before changing anything; pass -auto-approve to skip that).
#                            The first boot takes about 10 minutes; with a package it then installs it, the VM restarts
#                            once and rpa-runner signs in.
#   status                   instance state, public IP, runner and browser URLs, whether SSM sees the VM, and
#                            whether the first boot finished, failed or is still running
#   stop                     stops the VM (no instance charge while stopped) and waits until it has
#   start                    starts it, waits until SSM sees it, prints the new URLs (the IP changes)
#   fingerprint              the SHA-256 fingerprints of the runner's and the browser's certificates, one line each, as
#                            the package's Show-RpaConnection.ps1 prints them on the VM (through SSM)
#   rdp-password [--print]   copies the Administrator's RDP password to the clipboard (--print: to stdout instead)
#   install <url> <sha256>   upgrades the installed package from an https:// URL through SSM, without a new VM: the VM
#                            downloads the zip, compares its SHA-256 with the one given, unpacks it and runs its
#                            Install-Rpa.ps1 as an upgrade (the user, the policy, the tokens and the firewall addresses
#                            stay; a run in progress fails). It does not make a first install.
#   down [destroy args]      terraform destroy
#
# Env:
#   TESTBED_STATE_DIR        required: the Terraform state, its working data and the saved variables live here. Refused
#                            inside this repository, so a test bed's state can't be committed.
#   TESTBED_ALLOWED_CIDRS    (up) comma-separated CIDRs for the runner port, the browser port and RDP; default this
#                            machine's public IPv4 as a /32 (https://checkip.amazonaws.com). Wider than /16 (IPv6 /48)
#                            is refused here and by the module. A later up with other CIDRs changes the security
#                            group's rules and leaves the VM as it is.
#   TESTBED_PACKAGE_URL, TESTBED_PACKAGE_SHA256   (up) optional, both or neither: the RPA Windows package
#                            (rpa-windows-x64.zip) to install on the first boot, and its SHA-256. The URL is kept in
#                            the saved variables, the state and the VM's user data.
#   TESTBED_INSTANCE_TYPE, TESTBED_NAME   (up) optional
#   AWS_REGION / AWS_DEFAULT_REGION (up; else the AWS CLI profile's region), AWS_PROFILE as usual.
#
# Needs terraform >= 1.11 and the AWS CLI v2. Never prints a secret except rdp-password --print, on request. Its own
# messages leave out a URL's query string, where a pre-signed URL carries its signature (terraform's plan shows the
# user data, which holds the package URL in encoded form).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
EXAMPLE="$ROOT/deploy/terraform/examples/aws-ec2-desktop-runner"
FINGERPRINT_PATTERN='([0-9A-F]{2}:){31}[0-9A-F]{2}'

say() { printf '[testbed] %s\n' "$*"; }
fail() { printf '[testbed] error: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//' >&2; exit 2; }

# Compared case-insensitively: macOS's default file system is, so /users/... is the same directory as /Users/....
outside_repo() {
  local dir root
  dir="$(printf '%s/' "$1" | tr '[:upper:]' '[:lower:]')"
  root="$(printf '%s/' "$ROOT" | tr '[:upper:]' '[:lower:]')"
  case "$dir" in "$root"*) fail "TESTBED_STATE_DIR ($1) is inside the repository; choose a directory outside $ROOT" ;; esac
}

state_dir() {
  [ -n "${TESTBED_STATE_DIR:-}" ] || fail "set TESTBED_STATE_DIR to a directory outside this repository for the Terraform state"
  # Checked before and after creating it: the path as written, then the real path (symlinks resolved).
  case "$TESTBED_STATE_DIR" in /*) STATE="$TESTBED_STATE_DIR" ;; *) STATE="$PWD/$TESTBED_STATE_DIR" ;; esac
  outside_repo "$STATE"
  if [ ! -d "$TESTBED_STATE_DIR" ]; then
    mkdir -p "$TESTBED_STATE_DIR"
    chmod 700 "$TESTBED_STATE_DIR"
  fi
  STATE="$(cd "$TESTBED_STATE_DIR" && pwd -P)"
  outside_repo "$STATE"
  VARS="$STATE/testbed.tfvars.json"
}

tf() { TF_DATA_DIR="$STATE/.terraform" terraform -chdir="$EXAMPLE" "$@"; }

tf_init() {
  tf init -input=false -reconfigure -backend-config="path=$STATE/terraform.tfstate" >"$STATE/init.log" 2>&1 \
    || { cat "$STATE/init.log" >&2; fail "terraform init failed"; }
}

# Reads the test bed's instance ID and region from the Terraform outputs.
load_outputs() {
  state_dir
  [ -f "$STATE/terraform.tfstate" ] || fail "no test bed state in $STATE (run up first)"
  [ -d "$STATE/.terraform" ] || tf_init
  INSTANCE_ID="$(tf output -raw instance_id 2>/dev/null)" || fail "no instance_id output in $STATE (run up first)"
  REGION="$(tf output -raw region)"
  RUNNER_PORT="$(tf output -raw runner_url | sed -E 's#^wss://.*:([0-9]+)/rpa/v1$#\1#')"
  # A state from before the browser has no browser_url output until the next up.
  BROWSER_PORT="$(tf output -raw browser_url 2>/dev/null | sed -E 's#^wss://.*:([0-9]+)$#\1#')" || BROWSER_PORT=""
  case "$BROWSER_PORT" in *[!0-9]*) BROWSER_PORT="" ;; esac
  case "$INSTANCE_ID" in i-*) ;; *) fail "unexpected instance_id output: $INSTANCE_ID" ;; esac
}

aws_r() { aws --region "$REGION" "$@"; }

public_ip() {
  aws_r ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
}

# Online, ConnectionLost, Inactive, or "not registered" (the AWS CLI prints None for an empty list).
ssm_ping() {
  local ping
  ping="$(aws_r ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text)" || ping=None
  [ -n "$ping" ] && [ "$ping" != None ] || ping="not registered"
  printf '%s\n' "$ping"
}

json_string() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }

# Runs a PowerShell command on the VM through SSM Run Command and prints its output. Waits up to 15 minutes (a package
# download can take a while) and fails on a command that failed or didn't finish.
ssm_run() {
  local comment="$1" command="$2" id status="" output
  id="$(aws_r ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunPowerShellScript \
    --comment "$comment" --parameters "{\"commands\":[$(json_string "$command")]}" --query Command.CommandId --output text)"
  for _ in $(seq 1 180); do
    sleep "${TESTBED_POLL_SECONDS:-5}"
    status="$(aws_r ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || true)"
    case "$status" in Pending | InProgress | Delayed | "") continue ;; esac
    break
  done
  output="$(aws_r ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" --query StandardOutputContent --output text)"
  [ "$status" = Success ] || { printf '%s\n' "$output" >&2; fail "SSM command $id ended $status"; }
  printf '%s\n' "$output"
}

# The package URL and its SHA-256 travel inside single quotes in a PowerShell command line (install) and into the VM's
# user data (up). The URL may hold only RFC 3986's characters without the single quote: no space, quote or backtick,
# and nothing outside ASCII (Windows PowerShell reads typographic quotes as quotes). Compared as bytes (LC_ALL=C): the
# ranges are then ASCII ranges in every locale. The module and the script on the VM make the same test.
valid_package_url() {
  local LC_ALL=C re='^https://[][A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$'
  [[ "$1" =~ $re ]]
}

valid_sha256() {
  local LC_ALL=C re='^[0-9A-Fa-f]{64}$'
  [[ "$1" =~ $re ]]
}

# The package URL as this script's messages show it: the text before the first ? or # (a pre-signed URL carries its
# signature in the query string), without a user name or password in front of the host.
shown_url() {
  printf '%s' "${1%%[?#]*}" | sed -E 's#^https://[^/]*@#https://#'
}

check_cidr() {
  local c="$1"
  [[ "$c" =~ ^[0-9A-Fa-f:.]+/([0-9]{1,3})$ ]] || fail "$c is not a CIDR (for example 203.0.113.7/32)"
  local prefix="${BASH_REMATCH[1]}" floor=16
  case "$c" in *:*) floor=48 ;; esac
  [ "$prefix" -ge "$floor" ] || fail "refusing $c: the test bed opens to /$floor or narrower, never the internet (the module refuses it too)"
}

cmd_up() {
  state_dir
  local cidrs="${TESTBED_ALLOWED_CIDRS:-}" region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}" list="" c ip
  local url="${TESTBED_PACKAGE_URL:-}" sha="${TESTBED_PACKAGE_SHA256:-}"
  if [ -n "$url" ] || [ -n "$sha" ]; then
    valid_package_url "$url" || fail "TESTBED_PACKAGE_URL must be an https:// URL of plain URL characters, without spaces or quotes (it goes with TESTBED_PACKAGE_SHA256)"
    valid_sha256 "$sha" || fail "TESTBED_PACKAGE_SHA256 must be the package's SHA-256, 64 hexadecimal characters (required with TESTBED_PACKAGE_URL)"
  fi
  if [ -z "$cidrs" ]; then
    ip="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')" || fail "could not read this machine's public IP; set TESTBED_ALLOWED_CIDRS"
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "checkip.amazonaws.com returned '$ip', not an IPv4 address; set TESTBED_ALLOWED_CIDRS"
    cidrs="$ip/32"
  fi
  IFS=',' read -r -a parts <<<"$cidrs"
  for c in "${parts[@]}"; do
    c="${c// /}"
    [ -n "$c" ] || continue
    check_cidr "$c"
    list="${list:+$list, }$(json_string "$c")"
  done
  [ -n "$list" ] || fail "TESTBED_ALLOWED_CIDRS lists no CIDR"
  [ -n "$region" ] || region="$(aws configure get region 2>/dev/null || true)"
  [ -n "$region" ] || fail "no region: set AWS_REGION"
  {
    printf '{\n  "aws_region": %s,\n  "allowed_cidrs": [%s]' "$(json_string "$region")" "$list"
    [ -z "${TESTBED_NAME:-}" ] || printf ',\n  "name": %s' "$(json_string "$TESTBED_NAME")"
    [ -z "${TESTBED_INSTANCE_TYPE:-}" ] || printf ',\n  "instance_type": %s' "$(json_string "$TESTBED_INSTANCE_TYPE")"
    [ -z "$url" ] || printf ',\n  "package_url": %s,\n  "package_sha256": %s' "$(json_string "$url")" "$(json_string "$sha")"
    printf '\n}\n'
  } >"$VARS"
  chmod 600 "$VARS"
  say "region $region, open to: ${list//\"/}; state in $STATE"
  if [ -n "$url" ]; then say "package: $(shown_url "$url")"; else say "no package: nothing of the product is installed"; fi
  tf_init
  tf apply -input=false -var-file="$VARS" "$@"
  say "applied. The first boot takes about 10 minutes (longer with a package, and it then ends with a restart); then: $0 status"
}

cmd_down() {
  state_dir
  [ -f "$VARS" ] || fail "no saved variables in $STATE (nothing was brought up from here)"
  tf_init
  tf destroy -input=false -var-file="$VARS" "$@"
}

# One word about the first boot, from the test bed's own folder on the VM: done (the done marker is there), failed (the
# log holds a "setup FAILED" line), running, or "not started".
FIRST_BOOT_PS="\$d = 'C:\\Program Files\\RPA Test Bed'; if (Test-Path -LiteralPath (\$d + '\\setup.done')) { 'done' } elseif (-not (Test-Path -LiteralPath (\$d + '\\setup.log'))) { 'not started' } elseif (Select-String -LiteralPath (\$d + '\\setup.log') -SimpleMatch -Pattern 'setup FAILED' -Quiet) { 'failed' } else { 'running' }"

cmd_status() {
  load_outputs
  local state ip ping setup
  state="$(aws_r ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].State.Name' --output text)"
  say "instance $INSTANCE_ID ($REGION): $state"
  if [ "$state" = running ]; then
    ip="$(public_ip)"
    ping="$(ssm_ping)"
    [ "$ip" = None ] || say "public IP $ip, runner URL wss://$ip:$RUNNER_PORT/rpa/v1"
    [ "$ip" = None ] || [ -z "$BROWSER_PORT" ] || say "browser URL wss://$ip:$BROWSER_PORT"
    say "SSM: $ping"
    # Whether the first boot finished, so that a VM whose setup failed or is still running shows as that.
    if [ "$ping" = Online ]; then
      setup="$(ssm_run 'RPA test bed first boot' "$FIRST_BOOT_PS" 2>/dev/null | tr -d '\r' | head -n 1)" || setup=""
      case "$setup" in
        done) say "first boot: finished" ;;
        failed) say "first boot: FAILED (see C:\\Program Files\\RPA Test Bed\\setup.log on the VM)" ;;
        running) say "first boot: still running" ;;
        "not started") say "first boot: not started yet" ;;
        *) say "first boot: unknown (the VM gave no answer)" ;;
      esac
    fi
  fi
}

cmd_stop() {
  load_outputs
  aws_r ec2 stop-instances --instance-ids "$INSTANCE_ID" --query 'StoppingInstances[0].CurrentState.Name' --output text >/dev/null
  say "stopping $INSTANCE_ID ($REGION)..."
  aws_r ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
  say "stopped. Start it again with: TESTBED_STATE_DIR=$STATE $0 start"
}

cmd_start() {
  load_outputs
  local ip ping=""
  aws_r ec2 start-instances --instance-ids "$INSTANCE_ID" --query 'StartingInstances[0].CurrentState.Name' --output text >/dev/null
  say "starting $INSTANCE_ID ($REGION)..."
  aws_r ec2 wait instance-running --instance-ids "$INSTANCE_ID"
  ip="$(public_ip)"
  for _ in $(seq 1 60); do
    ping="$(ssm_ping)"
    [ "$ping" = Online ] && break
    sleep "${TESTBED_POLL_SECONDS:-5}"
  done
  say "running; SSM: $ping"
  [ "$ip" = None ] || say "public IP $ip, runner URL wss://$ip:$RUNNER_PORT/rpa/v1 (rpa-runner signs in about a minute after boot)"
  [ "$ip" = None ] || [ -z "$BROWSER_PORT" ] || say "browser URL wss://$ip:$BROWSER_PORT"
}

# Runs the package's Show-RpaConnection.ps1 on the VM, never with -ShowTokens, and prints only its fingerprint lines,
# and of those only ones of the exact form. When the command itself fails on the VM, ssm_run writes what the command
# printed to stderr as it came. The runner's fingerprint comes from a log the bot user can write, so it is what that
# user reports.
cmd_fingerprint() {
  load_outputs
  local out lines
  out="$(ssm_run 'RPA fingerprints' "& 'C:\\Program Files\\RPA Runner\\scripts\\Show-RpaConnection.ps1'")"
  lines="$(printf '%s\n' "$out" | tr -d '\r' | LC_ALL=C grep -E "^(Runner|Browser) fingerprint: ($FINGERPRINT_PATTERN|not known yet)\$" || true)"
  [ -n "$lines" ] || fail "Show-RpaConnection.ps1 printed no fingerprint: is the package installed? (status, install)"
  printf '%s\n' "$lines"
  case "$lines" in *"not known yet"*) fail "a fingerprint is not known yet: that program has not started (rpa-runner signs in about a minute after boot)" ;; esac
}

cmd_rdp_password() {
  load_outputs
  local arn password ip copy=""
  arn="$(tf output -raw admin_password_secret_arn)"
  password="$(aws_r secretsmanager get-secret-value --secret-id "$arn" --query SecretString --output text)" \
    || fail "could not read the Administrator password (the first boot writes it; wait for setup to finish)"
  ip="$(public_ip)"
  if [ "${1:-}" = --print ]; then
    printf '%s\n' "$password"
    return
  fi
  if command -v pbcopy >/dev/null 2>&1; then copy=pbcopy
  elif command -v wl-copy >/dev/null 2>&1; then copy=wl-copy
  elif command -v xclip >/dev/null 2>&1; then copy="xclip -selection clipboard"
  fi
  [ -n "$copy" ] || fail "no clipboard tool (pbcopy, wl-copy, xclip); use rdp-password --print"
  printf '%s' "$password" | $copy
  say "Administrator password copied to the clipboard. RDP to ${ip/None/<no public IP>} as Administrator (a session of its own; rpa-runner's console session stays signed in)."
}

cmd_install() {
  load_outputs
  local url="${1:-}" sha="${2:-}"
  valid_package_url "$url" || fail "install needs an https:// URL of plain URL characters, without spaces or quotes: install <url> <sha256>"
  valid_sha256 "$sha" || fail "install needs the package's SHA-256 (64 hexadecimal characters): install <url> <sha256>"
  say "installing the package from $(shown_url "$url") (SSM Run Command keeps the URL in its history)"
  ssm_run 'RPA package install' "& 'C:\\Program Files\\RPA Test Bed\\install-package.ps1' -Url '$url' -Sha256 '$sha'"
}

[ $# -ge 1 ] || usage
command="$1"
shift
case "$command" in
  up) cmd_up "$@" ;;
  down) cmd_down "$@" ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  start) cmd_start ;;
  fingerprint) cmd_fingerprint ;;
  rdp-password) cmd_rdp_password "$@" ;;
  install) cmd_install "$@" ;;
  -h | --help | help) usage ;;
  *) printf '[testbed] unknown command: %s\n' "$command" >&2; usage ;;
esac
