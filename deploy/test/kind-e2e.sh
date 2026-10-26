#!/usr/bin/env bash
# End-to-end check of the rpa-browser chart on a throwaway kind cluster: the session limit and the drain on pod deletion.
#
#   deploy/test/kind-e2e.sh            (from anywhere; needs docker, kind, kubectl, helm, node, openssl and bash 5,
#                                       plus `pnpm install` for the engine's playwright-core)
#
# 1. Creates a kind cluster with a unique name and its own kubeconfig in a temporary directory: your kube contexts and
#    other docker containers are never touched. Everything it creates is removed on exit, pass or fail.
# 2. Builds images/browser under a unique tag (or uses RPA_BROWSER_IMAGE, a local image, and leaves it in place) and
#    loads it into the cluster.
# 3. Creates the token Secret from a random value, never printed.
# 4. helm install of deploy/helm/rpa-browser: autoscaling none, 1 replica, 1 session per replica, a 60 s drain, no
#    NetworkPolicy (kind's default CNI does not enforce one).
# 5. Port-forwards the Service's 3000 and the pod's 9464; a playwright-core client opens and holds a session. Asserts
#    /metrics shows 1 active session and a second connect gets 503 busy.
# 6. pod deletion waits for the session: kubectl delete pod --wait=false; 10 s later the pod is still Terminating, the
#    gate refuses new sessions (503 draining) and the held session still works; after the session closes the pod is gone
#    within 15 s.
#
# Env: KIND_NODE_IMAGE (default: the node image of kind v0.33.0, pinned by digest), RPA_BROWSER_IMAGE (skip the build).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_IMAGE="${KIND_NODE_IMAGE:-kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5}"
CLUSTER="rpa-kind-e2e-$$"
NAMESPACE="rpa-e2e"
RELEASE="rpa-browser"
PREBUILT="${RPA_BROWSER_IMAGE:-}"
IMAGE="${PREBUILT:-rpa-browser:kind-e2e-$$}"
DRAIN_SECONDS=60

say() { printf '[kind-e2e %6.1fs] %s\n' "$(elapsed)" "$*"; }
fail() { printf '[kind-e2e] FAIL: %s\n' "$*" >&2; exit 1; }
START="${EPOCHREALTIME:-}"
elapsed() { awk -v a="$START" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.1f", b - a }'; }
since() { awk -v a="$1" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.1f", b - a }'; }

if [ -n "$PREBUILT" ]; then
  case "$PREBUILT" in *@*) fail "RPA_BROWSER_IMAGE=$PREBUILT: a digest reference is not supported, use repository:tag" ;; esac
  case "${PREBUILT##*/}" in *:?*) ;; *) fail "RPA_BROWSER_IMAGE=$PREBUILT has no :tag after the last /, use repository:tag" ;; esac
fi
[ "${BASH_VERSINFO[0]}" -ge 5 ] || fail "needs bash 5 or later (EPOCHREALTIME), found $BASH_VERSION"
for tool in docker kind kubectl helm node openssl awk; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool not found"
done
PW_PACKAGE="$ROOT/packages/engine/package.json"
[ -f "$ROOT/packages/engine/node_modules/playwright-core/package.json" ] \
  || fail "packages/engine/node_modules/playwright-core is missing: run pnpm install first"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rpa-kind-e2e.XXXXXX")"
KCFG="$WORK/kubeconfig"
# Every kubectl and helm call below also passes --kubeconfig; the export covers anything else.
export KUBECONFIG="$KCFG"
k() { kubectl --kubeconfig "$KCFG" -n "$NAMESPACE" "$@"; }
h() { helm --kubeconfig "$KCFG" -n "$NAMESPACE" "$@"; }

CREATED_CLUSTER=0
BUILT_IMAGE=0
PIDS=()
OK=0

cleanup() {
  local status=$?
  set +e
  if [ "$OK" != 1 ] && [ "$CREATED_CLUSTER" = 1 ]; then
    echo "---- diagnostics" >&2
    k get pods -o wide >&2
    k describe pods 2>&1 | tail -n 60 >&2
    k logs -l "app.kubernetes.io/instance=$RELEASE" --all-containers --tail=50 >&2
    for f in client.err pf-gate.log pf-metrics.log; do
      [ -s "$WORK/$f" ] && { echo "---- $f" >&2; tail -n 30 "$WORK/$f" >&2; }
    done
  fi
  exec 3>&- 4<&-
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null; done
  if [ "$CREATED_CLUSTER" = 1 ]; then
    kind delete cluster --name "$CLUSTER" --kubeconfig "$KCFG" >/dev/null 2>&1 || echo "could not delete kind cluster $CLUSTER" >&2
  fi
  [ "$BUILT_IMAGE" = 1 ] && docker rmi -f "$IMAGE" >/dev/null 2>&1
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Waits until a background kubectl port-forward logs its local port for the remote port $2; prints the local port.
forwarded_port() {
  local log="$1" remote="$2" port=""
  for _ in $(seq 1 100); do
    port="$(sed -n "s/^Forwarding from 127\.0\.0\.1:\([0-9][0-9]*\) -> $remote\$/\1/p" "$log" | head -n 1)"
    [ -n "$port" ] && { echo "$port"; return 0; }
    sleep 0.2
  done
  fail "port-forward to $remote did not start: $(cat "$log")"
}

# One prometheus sample from the pod's /metrics, for example metric rpa_browser_sessions_active.
# shellcheck disable=SC2016 # JavaScript, not shell
metric() { node -e '
  fetch(`http://127.0.0.1:${process.argv[1]}/metrics`).then((r) => r.text()).then((t) => {
    const line = t.split("\n").find((l) => l.startsWith(`${process.argv[2]} `));
    process.stdout.write(line === undefined ? "missing" : line.slice(process.argv[2].length + 1));
  }).catch((e) => { process.stdout.write(`error ${e.message}`); });' "$METRICS_PORT" "$1"; }

# The client: holds one browser session and answers one command per line on stdin with "ok <command>" or
# "fail <command> <reason>". It reads the token from a file, so the token is in no argument, environment or output.
# shellcheck disable=SC2016 # JavaScript, not shell
CLIENT='
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { request } from "node:http";
import { createInterface } from "node:readline";
const { chromium } = createRequire(process.env.PW_PACKAGE)("playwright-core");
const url = process.env.GATE_URL;
const token = readFileSync(process.env.TOKEN_FILE, "utf8");
const headers = { Authorization: `Bearer ${token}` };
const scrub = (m) => String(m).split(token).join("***").split("\n").slice(0, 2).join(" | ");
const connect = () => chromium.connect(url, { headers, timeout: 15_000 });
// A bare WebSocket upgrade with the token; resolves with the status and the X-RPA-Browser header.
const upgrade = () => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(url);
  const req = request({ host: hostname, port, path: "/", headers: { ...headers, Connection: "Upgrade", Upgrade: "websocket",
    "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
  req.on("upgrade", (res, socket) => { socket.destroy(); resolve(`${res.statusCode} ${res.headers["x-rpa-browser"]}`); });
  req.on("response", (res) => { res.resume(); resolve(`${res.statusCode} ${res.headers["x-rpa-browser"]}`); });
  req.on("error", reject);
  req.setTimeout(10_000, () => req.destroy(new Error("upgrade timed out")));
  req.end();
});
let browser, page;
const commands = {
  async open() {
    for (let attempt = 1; ; attempt += 1) {
      try { browser = await connect(); break; } catch (err) { if (attempt >= 10) throw err; await new Promise((r) => setTimeout(r, 1000)); }
    }
    page = await browser.newPage();
    await page.setContent("<title>held</title><p id=n>1</p>");
    if (await page.title() !== "held") throw new Error("the page did not load");
  },
  async busy() {
    const refused = await upgrade();
    if (refused !== "503 busy") throw new Error(`a second upgrade got ${refused}, not 503 busy`);
    let second;
    try { second = await connect(); } catch (err) {
      if (/503/.test(err.message) && /busy/.test(err.message)) return;
      throw new Error(`a second connect failed without 503 busy: ${scrub(err.message)}`);
    }
    await second.close();
    throw new Error("a second connect succeeded beyond sessionsPerReplica 1");
  },
  async draining() {
    const refused = await upgrade();
    if (refused !== "503 draining") throw new Error(`a new upgrade on the draining pod got ${refused}, not 503 draining`);
  },
  async use() {
    if (!browser.isConnected()) throw new Error("the held session is disconnected");
    const n = await page.evaluate(() => { const el = document.getElementById("n"); el.textContent = String(Number(el.textContent) * 42); return Number(el.textContent); });
    if (n !== 42) throw new Error(`evaluate returned ${n}`);
  },
  async close() { await browser.close(); },
};
for await (const line of createInterface({ input: process.stdin })) {
  const name = line.trim();
  if (name === "quit") break;
  try {
    if (!commands[name]) throw new Error("unknown command");
    await commands[name]();
    process.stdout.write(`ok ${name}\n`);
  } catch (err) {
    process.stdout.write(`fail ${name} ${scrub(err.message)}\n`);
  }
}
process.exit(0);
'

# Sends a command to the client and waits up to $2 seconds for "ok <command>".
ask() {
  local reply=""
  printf '%s\n' "$1" >&3
  IFS= read -r -t "${2:-30}" -u 4 reply || fail "the client did not answer \"$1\" within ${2:-30} s"
  [ "$reply" = "ok $1" ] || fail "$reply"
}

# ---- 1. cluster
say "creating kind cluster $CLUSTER ($NODE_IMAGE)"
T="$EPOCHREALTIME"
CREATED_CLUSTER=1
kind create cluster --name "$CLUSTER" --image "$NODE_IMAGE" --kubeconfig "$KCFG" --wait 180s >"$WORK/kind.log" 2>&1 \
  || { cat "$WORK/kind.log" >&2; fail "kind create cluster failed"; }
say "cluster ready in $(since "$T") s"

# ---- 2. image
T="$EPOCHREALTIME"
if [ -n "$PREBUILT" ]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "RPA_BROWSER_IMAGE=$IMAGE is not a local image"
  say "using prebuilt image $IMAGE"
else
  say "building $IMAGE from images/browser"
  BUILT_IMAGE=1
  # No attestation manifests: kind load imports a single-platform image.
  docker build --provenance=false --sbom=false -t "$IMAGE" "$ROOT/images/browser" >"$WORK/build.log" 2>&1 \
    || { tail -n 40 "$WORK/build.log" >&2; fail "docker build failed"; }
  say "built in $(since "$T") s"
fi
T="$EPOCHREALTIME"
kind load docker-image "$IMAGE" --name "$CLUSTER" >"$WORK/load.log" 2>&1 || { cat "$WORK/load.log" >&2; fail "kind load failed"; }
say "image loaded in $(since "$T") s"

# ---- 3. token secret (the value goes from openssl to a 0600 file to the Secret; never printed, never an argument)
kubectl --kubeconfig "$KCFG" create namespace "$NAMESPACE" >/dev/null
(umask 077 && openssl rand -hex 32 | tr -d '\n' >"$WORK/token")
[ -s "$WORK/token" ] || fail "openssl produced no token"
k create secret generic rpa-browser-token --from-file=token="$WORK/token" >/dev/null
say "token secret created"

# ---- 4. helm install
cat >"$WORK/values.yaml" <<EOF
image:
  repository: "${IMAGE%:*}"
  tag: "${IMAGE##*:}"
  pullPolicy: Never
autoscaling:
  mode: none
replicas: 1
sessionsPerReplica: 1
drainSeconds: $DRAIN_SECONDS
token:
  existingSecret: rpa-browser-token
networkPolicy:
  enabled: false
# Small requests so the pod fits a kind node next to other containers.
resources:
  requests:
    cpu: 250m
    memory: 512Mi
  limits:
    memory: 2Gi
EOF
T="$EPOCHREALTIME"
h install "$RELEASE" "$ROOT/deploy/helm/rpa-browser" -f "$WORK/values.yaml" --wait --timeout 5m >"$WORK/helm.log" 2>&1 \
  || { cat "$WORK/helm.log" >&2; fail "helm install failed"; }
# Helm 3 and 4 wait differently; the rollout status is the same on both.
k rollout status "deploy/$RELEASE" --timeout=180s >/dev/null || fail "the Deployment did not become ready"
POD="$(k get pods -l "app.kubernetes.io/instance=$RELEASE" -o jsonpath='{.items[0].metadata.name}')"
[ -n "$POD" ] || fail "no pod for the release"
GRACE="$(k get pod "$POD" -o jsonpath='{.spec.terminationGracePeriodSeconds}')"
[ "$GRACE" = "$((DRAIN_SECONDS + 30))" ] || fail "terminationGracePeriodSeconds is $GRACE, expected $((DRAIN_SECONDS + 30))"
say "helm install ready in $(since "$T") s (pod $POD, grace $GRACE s)"

# ---- 5. one session held, the second refused busy
kubectl --kubeconfig "$KCFG" -n "$NAMESPACE" port-forward --address 127.0.0.1 "svc/$RELEASE" :3000 >"$WORK/pf-gate.log" 2>&1 &
PIDS+=($!)
kubectl --kubeconfig "$KCFG" -n "$NAMESPACE" port-forward --address 127.0.0.1 "pod/$POD" :9464 >"$WORK/pf-metrics.log" 2>&1 &
PIDS+=($!)
GATE_PORT="$(forwarded_port "$WORK/pf-gate.log" 3000)"
METRICS_PORT="$(forwarded_port "$WORK/pf-metrics.log" 9464)"

mkfifo "$WORK/to-client" "$WORK/from-client"
GATE_URL="ws://127.0.0.1:$GATE_PORT/" TOKEN_FILE="$WORK/token" PW_PACKAGE="$PW_PACKAGE" \
  node --input-type=module -e "$CLIENT" <"$WORK/to-client" >"$WORK/from-client" 2>"$WORK/client.err" &
PIDS+=($!)
exec 3>"$WORK/to-client"
exec 4<"$WORK/from-client"

T="$EPOCHREALTIME"
ask open 90
say "session open in $(since "$T") s"
[ "$(metric rpa_browser_sessions_active)" = 1 ] || fail "metrics: rpa_browser_sessions_active is $(metric rpa_browser_sessions_active), expected 1"
[ "$(metric rpa_browser_sessions_capacity)" = 1 ] || fail "metrics: rpa_browser_sessions_capacity is $(metric rpa_browser_sessions_capacity), expected 1"
say "PASS metrics show 1 active session of 1"
ask busy 30
say "PASS a second connect gets 503 busy"

# ---- 6. pod deletion waits for the session
k delete pod "$POD" --wait=false >/dev/null
DELETED="$EPOCHREALTIME"
say "pod $POD deleted (--wait=false); waiting 10 s"
sleep 10
[ -n "$(k get pod "$POD" -o jsonpath='{.metadata.deletionTimestamp}' 2>/dev/null)" ] || fail "pod $POD is gone 10 s after deletion"
[ -n "$(k get pod "$POD" -o jsonpath='{.status.containerStatuses[0].state.running.startedAt}')" ] \
  || fail "the container of pod $POD is no longer running 10 s after deletion"
[ "$(metric rpa_browser_draining)" = 1 ] || fail "metrics: rpa_browser_draining is $(metric rpa_browser_draining), expected 1"
[ "$(metric rpa_browser_sessions_active)" = 1 ] || fail "metrics: the session is no longer counted while draining"
ask draining 30
ask use 30
say "PASS $(since "$DELETED") s after deletion the pod is Terminating, refuses new sessions (503 draining) and the held session still works"

ask close 30
CLOSED="$EPOCHREALTIME"
gone=0
while awk -v a="$CLOSED" -v b="$EPOCHREALTIME" 'BEGIN { exit !(b - a < 15) }'; do
  if [ -z "$(k get pod "$POD" -o name --ignore-not-found 2>/dev/null)" ]; then gone=1; break; fi
  sleep 0.2
done
[ "$gone" = 1 ] || fail "pod $POD still exists 15 s after the session closed"
say "PASS pod gone $(since "$CLOSED") s after the session closed ($(since "$DELETED") s after deletion; grace was $GRACE s)"

printf 'quit\n' >&3
OK=1
say "all checks passed"
