# k8s-browser

A Terraform module that installs the RPA browser service on Kubernetes, next to an existing n8n. It makes one `helm_release` of the [`rpa-browser` chart](../../../helm/rpa-browser). Each pod runs the `rpa-browser` image: Playwright's run-server behind the token gate. A pod serves a fixed number of browser sessions, reports metrics and drains on scale-in.

n8n's workers connect to the service through the RPA Browser credential in Browser Server mode. Chromium never runs inside an n8n pod.

## Requirements

- Terraform 1.11 or later.
- The Helm provider 3.x (`hashicorp/helm ~> 3.0`). The module was written against the [v3.3.0 `helm_release` docs](https://registry.terraform.io/providers/hashicorp/helm/3.3.0/docs/resources/release). You configure the provider; in v3, `kubernetes` is an attribute, `kubernetes = { ... }`.
- An existing namespace with the token Secret in it (see below).
- A CNI that enforces NetworkPolicy, unless you set `network_policy_enabled = false`. On EKS that means the VPC CNI network policy agent; Calico and Cilium also work.
- For `autoscaling.mode = "keda"` (the default once `prometheus_server` is set):
  - KEDA installed in the cluster
  - a Prometheus that scrapes port 9464
- For `pod_monitor_enabled`: the Prometheus Operator CRDs.
- For `egress_fqdns`: Cilium.

## The token

The module never takes, creates or reads the gate token, so the token never enters Terraform state or outputs. Create the Secret yourself, or with External Secrets, before you apply:

```sh
kubectl -n <namespace> create secret generic rpa-browser-token \
  --from-literal=token="$(openssl rand -hex 32)"
```

Then pass its name as `token_secret_name`. Don't add a `kubernetes_secret` data source to look the token up: that copies it into state. the RPA Browser credential in n8n gets the same token; [Configure n8n](#configure-n8n) shows how to pass it without Terraform.

## Example

```hcl
provider "helm" {
  kubernetes = {
    config_path = "~/.kube/config"
  }
}

module "rpa_browser" {
  source = "../../modules/k8s-browser" # or git::https://github.com/jb-n8n/n8n-nodes-rpa.git//deploy/terraform/modules/k8s-browser?ref=<tag>

  namespace         = "n8n"
  token_secret_name = "rpa-browser-token"
  image = {
    repository = "ghcr.io/jb-n8n/rpa-browser"
    tag        = "0.1.0"
  }

  # Only n8n's workers may open sessions.
  n8n_pod_selector = { "app.kubernetes.io/component" = "worker" }

  # The sites the browser may open on 80/443. Cut the cluster's own ranges out of 0.0.0.0/0.
  allowed_egress_cidrs = ["0.0.0.0/0"]
  egress_except_cidrs  = ["10.0.0.0/16", "172.20.0.0/16"] # VPC / pod range, service range

  autoscaling = {
    prometheus_server = "http://prometheus-operated.monitoring.svc:9090"
    min               = 1
    max               = 10
  }
  metrics_from = [{
    namespace_selector = { "kubernetes.io/metadata.name" = "monitoring" }
    pod_selector       = { "app.kubernetes.io/name" = "prometheus" }
  }]
  pod_monitor_enabled = true
  pod_monitor_labels  = { release = "kube-prometheus-stack" }
}

output "rpa_browser" {
  value = module.rpa_browser.n8n_settings
}
```

## Configure n8n

After `terraform apply`, export the n8n API key and the token in your shell, then run `terraform output -raw configure_command` (exported from your root module) from the repository root. It creates the RPA Browser credential and imports the templates through n8n's public API. The command reads both secrets from the environment and never carries them.

Read the token straight from the Secret rather than pasting it, so it never lands in your shell history. Escape dots in the key for kubectl's jsonpath; `n8n_settings.notes` prints this line with the dots already escaped:

```sh
read -rs N8N_API_KEY && export N8N_API_KEY   # paste the key, then Enter; nothing is echoed
export RPA_BROWSER_TOKEN="$(kubectl -n n8n get secret rpa-browser-token -o jsonpath='{.data.token}' | base64 -d)"
node deploy/scripts/configure-n8n.mjs --n8n-url 'https://n8n.example.com' --endpoint 'ws://rpa-browser.n8n.svc.cluster.local:3000/'   # = configure_command
unset N8N_API_KEY RPA_BROWSER_TOKEN
```

Add `--project-id <id>` to create the credential and the workflows in that n8n project instead of your personal one.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `namespace` | `string` | required | Namespace to install into. It must exist and hold the token Secret. |
| `release_name` | `string` | `"rpa-browser"` | Helm release name. The Service is named after it. |
| `chart_path` | `string` | `null` | Local chart path. `null` means the in-repo `deploy/helm/rpa-browser`, resolved from `path.module`. Ignored when `chart_repository` is set. A digest of the chart's files goes into the values (`global.rpaChartDigest`), so editing the chart shows up in plan and deploys. |
| `chart_repository` | `string` | `null` | Repository to install `rpa-browser` from instead, for example `oci://<registry>/charts`. |
| `chart_version` | `string` | `null` | Exact chart version. Required with `chart_repository`. |
| `image` | `object({repository, tag, digest})` | required | `repository` plus `tag` and/or `digest` (`sha256:...`). |
| `token_secret_name` | `string` | required | An existing Secret in `namespace` that holds the gate token. |
| `token_secret_key` | `string` | `"token"` | The key in that Secret. |
| `sessions_per_replica` | `number` | `4` | Sessions per pod, 1 to 64. |
| `drain_seconds` | `number` | `600` | Drain time on scale-in, 1 to 86400 seconds; at least the longest run. The grace period is this plus 30 (see [Drain and evictions](#drain-and-evictions)). |
| `autoscaling` | `object` | `{}` | `mode` (`keda`, `hpa-cpu`, `none`, or `""` to let the chart pick), `min` (1), `max` (10), `target` (0.7), `cpu_target_percent` (70), `prometheus_server`, `authentication_ref` (`{name, kind}`, kind defaults to `TriggerAuthentication`), `prometheus_extra_metadata` (for example `awsRegion`). `min`, `max` and `cpu_target_percent` are whole numbers, and `min` must not exceed `max`. With `mode = "none"`, `min` is the fixed pod count. |
| `network_policy_enabled` | `bool` | `true` | Render the NetworkPolicy. |
| `n8n_pod_selector` | `map(string)` | `{}` | matchLabels of the n8n pods that open sessions. Required while the NetworkPolicy is on. |
| `n8n_namespace_selector` | `map(string)` | `{}` | matchLabels of n8n's namespace when it is not `namespace`. |
| `metrics_from` | `list(object({pod_selector, namespace_selector}))` | `[]` | Who may scrape port 9464. Required when KEDA scales the service behind the NetworkPolicy (the module and the chart refuse an empty list then); set it for a PodMonitor too. |
| `pod_monitor_enabled` | `bool` | `false` | Create a PodMonitor that writes the labels the KEDA query selects. |
| `pod_monitor_labels` | `map(string)` | `{}` | Labels your Prometheus selects PodMonitors by. |
| `allowed_egress_cidrs` | `list(string)` | `[]` | CIDRs the browser may reach on 80/443. If it is empty, the browser reaches no site. |
| `egress_except_cidrs` | `list(string)` | `[]` | Ranges cut out of every allowed CIDR that contains them. |
| `egress_fqdns` | `list(string)` | `[]` | Domain names the browser may reach (Cilium only). Lower case, one leading `*.` at most; never `*`, `*.*` or `*.<tld>`. |
| `dns_ip_blocks` | `list(string)` | `[]` | More DNS servers by CIDR, allowed on port 53 next to kube-dns. With NodeLocal DNSCache, list `169.254.20.10/32`; it is the only address inside a metadata range the chart accepts, and only here. |
| `resources` | `any` | `null` | Container resources. `null` keeps the chart's defaults (2 CPU / 4Gi). |
| `extra_values` | `list(string)` | `[]` | More chart values as YAML maps, merged after the module's own (for example `nodeSelector`, `tolerations` or `podDisruptionBudget`). They may not set `fullnameOverride`, `nameOverride`, `token`, `n8n`, `networkPolicy` or `egress`. Those are module inputs, and the endpoint output depends on the names. |
| `timeout_seconds` | `number` | `600` | How long Helm waits for the rollout. |
| `node_package_name` | `string` | `"n8n-nodes-rpa"` | The RPA node package, for `n8n_settings`. |
| `n8n_url` | `string` | `null` | n8n's base URL for `configure_command`. If it is `null`, the command has a placeholder. |

## Outputs

| Name | Description |
|---|---|
| `browser_endpoint` | `ws://<release_name>.<namespace>.svc.cluster.local:3000/` |
| `n8n_settings` | An object with four fields; see the list below this table. |
| `configure_command` | The `deploy/scripts/configure-n8n.mjs` invocation (`--n8n-url`, `--endpoint`). It reads `N8N_API_KEY` and `RPA_BROWSER_TOKEN` from the environment, so export them first; it never carries them, not even as placeholders. |
| `autoscaling_mode` | The scaling mode the chart uses: `keda`, `hpa-cpu` or `none`. |

The `n8n_settings` fields:
- `executions_mode`: `"queue"`.
- `rpa_browser_credential`: `{ mode = "playwright", endpoint, token_secret = "<namespace>/<secret>" }`. `playwright` is the stored value of Browser Server mode.
- `node_package`: the package name.
- `notes`: a list of the remaining steps and warnings.

## Security notes

- **List the cluster's own ranges in `egress_except_cidrs`.** NetworkPolicy is enforced on pod IPs after Service translation. So `0.0.0.0/0` on 80/443 opens every in-cluster pod that listens on 80 or 443 (an ingress controller, a metrics UI, a webhook), but not n8n (5678), Redis (6379) or Postgres (5432) on their own ports. Cut out the VPC or node range, the pod range and the service range so a page can only reach the internet. If n8n or its database sits outside the cluster in a private range, list that range too.
- **The NetworkPolicy needs a CNI that enforces it.** Without one, the policy is accepted and silently ignored. Then any pod can open browser sessions (it still needs the token), and the browser can reach anything the node can. On EKS, enable the VPC CNI's network policy agent. Check enforcement once after the first apply: from a pod that is not an n8n worker, a connection to port 3000 must time out.
- **Metadata ranges are always excluded.** The chart cuts `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::/32`, `100.100.100.200/32`, `168.63.129.16/32` and `fd20:ce::254/128` out of every allowed CIDR that contains them, and refuses an allowed CIDR inside one. With `egress_fqdns`, the CiliumNetworkPolicy also denies those ranges and `egress_except_cidrs` on every port.
- **DNS goes only to cluster DNS.** Egress on port 53 reaches the kube-dns pods, plus `dns_ip_blocks` when your cluster runs NodeLocal DNSCache (`169.254.20.10/32`).
- **Ingress is only from n8n.** Port 3000 admits only pods matching `n8n_pod_selector` (and `n8n_namespace_selector`). The metrics port 9464 is never on the Service, and the NetworkPolicy admits only `metrics_from` to it.
- **Domain allowlists** (`egress_fqdns`) need Cilium. On other CNIs, use CIDRs or route egress through a filtering proxy.
- **The token stays out of Terraform.** See [The token](#the-token).

## Drain and evictions

**Destroying the module or renaming the release.** Both remove the NetworkPolicy at once, but the old pods keep draining for up to `drain_seconds` with open sessions. During that time nothing restricts their egress. To avoid it, do one of these first:
- scale to 0, or wait until no sessions are open (`rpa_browser_sessions_active` is 0)
- keep a default-deny NetworkPolicy in the namespace, so pods without their own policy reach nothing

A pod that is scaled in or evicted drains for up to `drain_seconds`, and its grace period is `drain_seconds + 30` (630 s by default). Whatever removes pods must allow that long. cluster-autoscaler's default `--max-graceful-termination-sec` is 600, so raise it, or keep it from evicting browser pods. The chart's PodDisruptionBudget defaults to `maxUnavailable: 1`, so node drains move one pod at a time. A pod that writes more to `/tmp` than the chart's `tmpVolume.sizeLimit` is evicted at once, with no drain. See the [chart README](../../../helm/rpa-browser/README.md).

## Tests

`make -C deploy check` runs `terraform fmt`, `init -backend=false`, `validate` and `terraform test` here, then `tests/chart.sh`.
- `terraform test` runs plan-only against a mocked Helm provider. It decodes the values YAML passed to `helm_release` and asserts:
  - the chart value names, checked against the chart's `values.schema.json` two levels deep, and three under `autoscaling.prometheus`. Deeper keys, such as `egress.dns.ipBlocks`, are covered by `tests/chart.sh`.
  - the chart digest: present for a local chart, absent for a repository chart, and covering file names and contents
  - the endpoint and n8n settings outputs
  - that no output or variable carries a token
  - the input validations
- `tests/chart.sh` renders the module's values for `tests/values/*.tfvars` through the real chart with `helm template` and `kubeconform`. `helm template` applies the whole `values.schema.json`, so it catches a wrong key at any depth.
