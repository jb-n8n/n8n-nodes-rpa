#!/usr/bin/env bash
# Renders the module's chart values through the real chart: for each tests/values/*.tfvars, terraform console prints
# the values the module passes to helm_release (local.chart_values plus extra_values), helm template renders the chart
# with them (the chart's values.schema.json and its own checks run), and kubeconform validates the objects. terraform
# test (mocked helm) proves the value names and shapes; this proves the chart accepts them.
# Run after terraform init in the module directory (make -C deploy check does both; it exports TF_DATA_DIR).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE="$(dirname "$HERE")"
CHART="$(cd "$MODULE/../../../helm/rpa-browser" && pwd)"
KUBERNETES_VERSION="${KUBERNETES_VERSION:-1.31.0}"
# datreeio/CRDs-catalog pinned to a commit (main on 2026-10-18), so a catalog change can't change the result.
CRD_SCHEMAS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/501527ab9c40c827144c8f45945b25a023e344ce/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
CACHE="${KUBECONFORM_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/kubeconform}"
mkdir -p "$CACHE"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for tool in terraform helm kubeconform node; do
  command -v "$tool" >/dev/null || { echo "chart.sh: $tool is required" >&2; exit 1; }
done

# terraform console prints a string as an HCL literal: JSON escapes plus $${ and %%{ for template sequences.
# console_string <tfvars> <expression yielding a string> prints the string itself.
console_string() {
  echo "$2" | terraform -chdir="$MODULE" console -var-file="$1" | node -e '
    const s = require("fs").readFileSync(0, "utf8").trim().replace(/\$\$\{/g, "${").replace(/%%\{/g, "%{");
    process.stdout.write(JSON.parse(s));
  '
}

for vars in "$HERE"/values/*.tfvars; do
  set_name="$(basename "$vars" .tfvars)"
  # The same list helm_release.this.values gets: the module's values, then extra_values.
  console_string "$vars" "jsonencode(local.chart_values)" >"$WORK/$set_name-values.json"
  console_string "$vars" "jsonencode(var.extra_values)" | node -e '
    const [dir, name] = process.argv.slice(1);
    JSON.parse(require("fs").readFileSync(0, "utf8")).forEach((doc, i) =>
      require("fs").writeFileSync(`${dir}/${name}-extra-${i}.yaml`, doc));
  ' "$WORK" "$set_name"
  args=(-f "$WORK/$set_name-values.json")
  for extra in "$WORK/$set_name"-extra-*.yaml; do
    [ -e "$extra" ] && args+=(-f "$extra")
  done
  release="$(console_string "$vars" var.release_name)"
  namespace="$(console_string "$vars" var.namespace)"
  helm template "$release" "$CHART" --namespace "$namespace" "${args[@]}" >"$WORK/$set_name.out.yaml" \
    || { echo "chart.sh: the chart refused the module's values for $set_name" >&2; exit 1; }
  printf '%s: ' "$set_name"
  kubeconform -strict -summary -kubernetes-version "$KUBERNETES_VERSION" -cache "$CACHE" \
    -schema-location default -schema-location "$CRD_SCHEMAS" "$WORK/$set_name.out.yaml"
  # The scaler each set picks, and extra_values reaching the chart.
  expect() { grep -Eq "$2" "$WORK/$set_name.out.yaml" || { echo "chart.sh: $set_name: expected $1" >&2; exit 1; }; }
  refuse() { ! grep -Eq "$2" "$WORK/$set_name.out.yaml" || { echo "chart.sh: $set_name: unexpected $1" >&2; exit 1; }; }
  case "$set_name" in
    keda) expect "a ScaledObject" '^kind: ScaledObject$'; expect "the nodeSelector from extra_values" 'kubernetes.io/arch: amd64'
      expect "kube-dns still allowed next to dns_ip_blocks" 'k8s-app: kube-dns'; expect "the NodeLocal DNSCache block" 'cidr: 169.254.20.10/32' ;;
    minimal) expect "a CPU HPA" '^kind: HorizontalPodAutoscaler$'; refuse "a ScaledObject" '^kind: ScaledObject$' ;;
    none) refuse "a scaler" '^kind: (ScaledObject|HorizontalPodAutoscaler)$'; expect "2 fixed replicas" '^  replicas: 2$' ;;
  esac
done
