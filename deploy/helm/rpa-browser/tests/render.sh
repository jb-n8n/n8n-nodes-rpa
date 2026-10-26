#!/usr/bin/env bash
# Checks the rpa-browser chart without a cluster. Runs from any directory; exits non-zero on the first failure.
#   1. helm lint --strict with each value set in tests/values
#   2. helm template with each value set, validated by kubeconform -strict (Kubernetes schemas plus the CRD catalog for
#      KEDA ScaledObject, CiliumNetworkPolicy and PodMonitor)
#   3. renders that must fail, each with its message (no token secret, a token value, bad selectors or CIDRs, ...)
#   4. assert.mjs: policy facts on the rendered objects (metadata address, ingress, drain, scalers, token, ports)
# Needs helm (3.x or 4.x), kubeconform and node; kubeconform downloads schemas, so it needs the network (cached after).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART="$(dirname "$HERE")"
KUBERNETES_VERSION="${KUBERNETES_VERSION:-1.31.0}"
# datreeio/CRDs-catalog pinned to a commit (main on 2026-10-18), so a catalog change can't change the result.
CRD_SCHEMAS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/501527ab9c40c827144c8f45945b25a023e344ce/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

for tool in helm kubeconform node; do
  command -v "$tool" >/dev/null || { echo "render.sh: $tool is required" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CACHE="${KUBECONFORM_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/kubeconform}"
mkdir -p "$CACHE"

SETS="$(node "$HERE/assert.mjs" --sets)"

# helm template's YAML as JSON, without a YAML library: a throwaway chart reads the rendered file and re-emits it as one
# Kubernetes List through Helm's own fromYaml/toJson.
mkdir -p "$WORK/tojson/templates"
printf 'apiVersion: v2\nname: tojson\nversion: 0.0.0\n' >"$WORK/tojson/Chart.yaml"
cat >"$WORK/tojson/templates/list.yaml" <<'EOF'
{{- $items := list }}
{{- range regexSplit "(?m)^---[ \t]*$" (.Files.Get "in.yaml") -1 }}
{{- $doc := fromYaml . }}
{{- if hasKey $doc "Error" }}{{ fail (printf "rendered output is not YAML: %v" (get $doc "Error")) }}{{ end }}
{{- if $doc }}{{ $items = append $items $doc }}{{ end }}
{{- end }}
{{ dict "apiVersion" "v1" "kind" "List" "items" $items | toJson }}
EOF
to_json() {
  cp "$1" "$WORK/tojson/in.yaml"
  helm template tojson "$WORK/tojson" | grep '^{'
}

echo "== helm lint"
while read -r set release namespace <&3; do
  helm lint --strict "$CHART" --namespace "$namespace" -f "$HERE/values/$set.yaml" >"$WORK/lint-$set.txt" 2>&1 \
    || { cat "$WORK/lint-$set.txt" >&2; echo "render.sh: helm lint failed for $set" >&2; exit 1; }
  echo "$set: $(grep -E 'linted' "$WORK/lint-$set.txt")"
done 3<<<"$SETS" # fd 3: nothing in the loop can eat the list from stdin

echo "== helm template | kubeconform"
while read -r set release namespace <&3; do
  helm template "$release" "$CHART" --namespace "$namespace" -f "$HERE/values/$set.yaml" >"$WORK/$set.yaml"
  printf '%s: ' "$set"
  kubeconform -strict -summary -kubernetes-version "$KUBERNETES_VERSION" -cache "$CACHE" \
    -schema-location default -schema-location "$CRD_SCHEMAS" "$WORK/$set.yaml"
  to_json "$WORK/$set.yaml" >"$WORK/$set.json"
done 3<<<"$SETS" # fd 3: nothing in the loop can eat the list from stdin

echo "== renders that must fail"
BASE=(-f "$HERE/values/keda.yaml")
must_fail() { # must_fail <description> <message regex> <helm template args...>
  local what="$1" pattern="$2"
  shift 2
  if helm template rpa-browser "$CHART" --namespace rpa "$@" >"$WORK/out.txt" 2>"$WORK/err.txt"; then
    echo "render.sh: expected the render to fail: $what" >&2
    exit 1
  fi
  grep -Eq "$pattern" "$WORK/err.txt" || {
    echo "render.sh: $what failed without the expected message /$pattern/:" >&2
    cat "$WORK/err.txt" >&2
    exit 1
  }
  echo "ok: $what"
}
must_fail 'no values at all: the token secret comes first' 'token.existingSecret is required'
must_fail 'no token.existingSecret' 'token.existingSecret is required' "${BASE[@]}" --set token.existingSecret=
must_fail 'a token value instead of a secret' "token.*(value|additional)" "${BASE[@]}" --set token.value=abcdefabcdefabcdefabcdefabcdefabcdef
must_fail 'no image repository' 'image.repository is required' "${BASE[@]}" --set image.repository=
must_fail 'neither image tag nor digest' 'image.tag or image.digest' "${BASE[@]}" --set image.tag=
must_fail 'keda without a Prometheus address' 'autoscaling.prometheus.serverAddress' "${BASE[@]}" \
  --set autoscaling.mode=keda --set autoscaling.prometheus.serverAddress=
must_fail 'an unknown autoscaling mode' 'autoscaling.mode' "${BASE[@]}" --set autoscaling.mode=vpa
must_fail 'a NetworkPolicy without an n8n pod selector' 'n8n.podSelector' "${BASE[@]}" --set n8n.podSelector=null
must_fail 'the metadata address as an allowed CIDR' '169.254.169.254' "${BASE[@]}" --set 'egress.allowedCIDRs={169.254.169.254/32}'
must_fail 'IPv4 link-local as an allowed CIDR' 'inside the metadata range 169.254.0.0/16' "${BASE[@]}" --set 'egress.allowedCIDRs={169.254.0.0/16}'
must_fail 'IPv6 link-local as an allowed CIDR' 'inside the metadata range fe80::/10' "${BASE[@]}" --set 'egress.allowedCIDRs={fe80::/64}'
must_fail "Azure's WireServer as an allowed CIDR" '168.63.129.16' "${BASE[@]}" --set 'egress.allowedCIDRs={168.63.129.16/32}'
must_fail 'a DNS ipBlock on the metadata address' 'egress.dns.ipBlocks.*169.254.169.254' "${BASE[@]}" --set 'egress.dns.ipBlocks={169.254.169.254/32}'
must_fail 'a bare * FQDN' 'fqdns' "${BASE[@]}" --set 'egress.fqdns={*}'
must_fail 'a top-level-domain wildcard FQDN' 'fqdns' "${BASE[@]}" --set 'egress.fqdns={*.com}'
must_fail 'a *.* FQDN' 'fqdns' "${BASE[@]}" --set 'egress.fqdns={*.*}'
must_fail 'a bare * FQDN past the schema (the template refuses it too)' 'egress.fqdns: "\*" is not' "${BASE[@]}" \
  --skip-schema-validation --set 'egress.fqdns={*}'
must_fail 'the IPv6 metadata address as an allowed CIDR' 'fd00:ec2::254' "${BASE[@]}" --set 'egress.allowedCIDRs={fd00:ec2::254/128}'
must_fail 'an except that covers a whole allowed CIDR' 'covers all of' "${BASE[@]}" --set 'egress.allowedCIDRs={10.1.0.0/16}'
must_fail 'a malformed CIDR' 'not an IPv4 or IPv6 CIDR' "${BASE[@]}" --set 'egress.allowedCIDRs={10.0.0.0}'
must_fail 'a CPU HPA without a CPU request' 'resources.requests.cpu' "${BASE[@]}" \
  --set autoscaling.mode=hpa-cpu --set resources.requests.cpu=null
must_fail 'a typo in an egress value' 'egress.*(allowedCidrs|additional)' "${BASE[@]}" --set 'egress.allowedCidrs={1.2.3.0/24}'
must_fail 'sessionsPerReplica above the gate limit' 'sessionsPerReplica' "${BASE[@]}" --set sessionsPerReplica=65
must_fail 'drainSeconds 0 (the gate takes 1-86400)' 'drainSeconds' "${BASE[@]}" --set drainSeconds=0
must_fail 'autoscaling.min above autoscaling.max' 'autoscaling.min .* above autoscaling.max' "${BASE[@]}" \
  --set autoscaling.min=5 --set autoscaling.max=3
must_fail 'KEDA with the metrics port closed by the NetworkPolicy' 'metrics.from' "${BASE[@]}" --set metrics.from=null

echo "== assert.mjs"
node "$HERE/assert.mjs" "$WORK"
