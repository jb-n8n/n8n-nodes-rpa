#!/usr/bin/env bash
# The RPA desktop runner test bed: a Windows Server 2022 VM on EC2 (deploy/terraform/examples/aws-ec2-desktop-runner)
# with the user rpa-runner signed in on the console and the runner started at its logon.
#
#   TESTBED_STATE_DIR=<dir outside this repository> deploy/scripts/desktop-testbed.sh <command>
#
#   up [apply args]          terraform init + apply (asks before changing anything; pass -auto-approve to skip that).
#                            The first boot takes about 10 minutes, then the VM restarts once and rpa-runner signs in.
#   status                   instance state, public IP, runner URL and whether SSM sees the VM
#   stop                     stops the VM (no instance charge while stopped) and waits until it has
#   start                    starts it, waits until SSM sees it, prints the new runner URL (the IP changes)
#   fingerprint              the runner certificate's SHA-256 fingerprint, read from the runner's log through SSM
#   rdp-password [--print]   copies the Administrator's RDP password to the clipboard (--print: to stdout instead)
#   install-runner <url> [sha256]
#                            installs or replaces the runner from an https:// URL through SSM, without a new VM
#   down [destroy args]      terraform destroy
#
# Env:
#   TESTBED_STATE_DIR        required: the Terraform state, its working data and the saved variables live here. Refused
#                            inside this repository, so a test bed's state can't be committed.
#   TESTBED_ALLOWED_CIDRS    (up) comma-separated CIDRs for the runner port and RDP; default this machine's public IPv4
#                            as a /32 (https://checkip.amazonaws.com). Wider than /16 (IPv6 /48) is refused here and by
#                            the module.
#   TESTBED_RUNNER_ARTIFACT_URL, TESTBED_RUNNER_ARTIFACT_SHA256, TESTBED_INSTANCE_TYPE, TESTBED_NAME   (up) optional
#   AWS_REGION / AWS_DEFAULT_REGION (up; else the AWS CLI profile's region), AWS_PROFILE as usual.
#
# Needs terraform >= 1.11 and the AWS CLI v2. Never prints a secret except rdp-password --print, on request.
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

# Runs a PowerShell command on the VM through SSM Run Command and prints its output. Waits up to 15 minutes (a runner
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
    [ -z "${TESTBED_RUNNER_ARTIFACT_URL:-}" ] || printf ',\n  "runner_artifact_url": %s' "$(json_string "$TESTBED_RUNNER_ARTIFACT_URL")"
    [ -z "${TESTBED_RUNNER_ARTIFACT_SHA256:-}" ] || printf ',\n  "runner_artifact_sha256": %s' "$(json_string "$TESTBED_RUNNER_ARTIFACT_SHA256")"
    printf '\n}\n'
  } >"$VARS"
  chmod 600 "$VARS"
  say "region $region, open to: ${list//\"/}; state in $STATE"
  tf_init
  tf apply -input=false -var-file="$VARS" "$@"
  say "applied. The first boot takes about 10 minutes and ends with a restart; then: $0 status"
}

cmd_down() {
  state_dir
  [ -f "$VARS" ] || fail "no saved variables in $STATE (nothing was brought up from here)"
  tf_init
  tf destroy -input=false -var-file="$VARS" "$@"
}

cmd_status() {
  load_outputs
  local state ip ping
  state="$(aws_r ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].State.Name' --output text)"
  say "instance $INSTANCE_ID ($REGION): $state"
  if [ "$state" = running ]; then
    ip="$(public_ip)"
    ping="$(ssm_ping)"
    [ "$ip" = None ] || say "public IP $ip, runner URL wss://$ip:$RUNNER_PORT/rpa/v1"
    say "SSM: $ping"
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
}

cmd_fingerprint() {
  load_outputs
  local ps out fp
  ps="Get-ChildItem -Path \"\$env:ProgramData\\RPA Runner\\*.log\", \"\$env:ProgramData\\RPA Runner\\logs\\*.log\" -File | Sort-Object LastWriteTime | Select-String -CaseSensitive -Pattern '$FINGERPRINT_PATTERN' | Select-Object -Last 1 | ForEach-Object { \$_.Matches[0].Value }"
  out="$(ssm_run 'RPA runner fingerprint' "$ps")"
  fp="$(printf '%s\n' "$out" | grep -Eo "$FINGERPRINT_PATTERN" | tail -n 1 || true)"
  [ -n "$fp" ] || fail "no fingerprint in the runner's log yet: is the runner installed and started? (status, install-runner)"
  printf '%s\n' "$fp"
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

cmd_install_runner() {
  load_outputs
  local url="${1:-}" sha="${2:-}" sha_arg=""
  [[ "$url" =~ ^https://[^[:space:]\'\"\`]+$ ]] || fail "install-runner needs an https:// URL without spaces or quotes"
  [ -z "$sha" ] || [[ "$sha" =~ ^[0-9A-Fa-f]{64}$ ]] || fail "the SHA-256 must be 64 hexadecimal characters"
  say "installing the runner from ${url%%\?*} (SSM Run Command keeps the URL in its history)"
  [ -z "$sha" ] || sha_arg=" -Sha256 '$sha'"
  ssm_run 'RPA runner install' "& 'C:\\Program Files\\RPA Runner\\install-runner.ps1' -Url '$url'$sha_arg"
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
  install-runner) cmd_install_runner "$@" ;;
  -h | --help | help) usage ;;
  *) printf '[testbed] unknown command: %s\n' "$command" >&2; usage ;;
esac
