# eks-managed-terraform-aws-n8n

An example root module that deploys n8n on Amazon EKS with n8n's own Terraform module, and the RPA browser service next to it. It composes two modules:

- **`n8n-io/n8n/aws` 0.5.0**, the registry address of [n8n-io/terraform-aws-n8n](https://github.com/n8n-io/terraform-aws-n8n). Its source is tag `0.5.0`, commit `3d54ab2c439fbc01a5438fa4845423f2b99305a5`. It creates the EKS cluster, PostgreSQL, Redis, S3 and n8n in queue mode with n8n's Helm chart, and installs KEDA and metrics-server.
- **[`../../modules/k8s-browser`](../../modules/k8s-browser)**, the browser service in a namespace of its own.

The example wires a worker pool named `rpa` for the projects that run RPA workflows. Only that pool's workers may open browser sessions, and Chromium never runs in an n8n pod.

> **Early alpha.** Worker pools are an early-alpha n8n feature. They need an Enterprise license with the feature **`feat:workerPools`**. n8n's module marks `n8n_worker_pools` as early alpha, subject to change without notice. The chart side (`queueMode.workerGroups`) is not in a numbered chart release yet, so the example pins n8n's official preview build, `1.11.0-preview.workerpools.1`. Read [n8n's worker-pools example](https://github.com/n8n-io/terraform-aws-n8n/tree/0.5.0/examples/worker-pools) before you rely on it.

## Requirements

- **Terraform** 1.11 or later, and the AWS CLI on the machine that runs it. The providers get cluster tokens from `aws eks get-token`.
- **A VPC** with public and private subnets in at least two Availability Zones. The subnets need the EKS and load balancer tags that n8n's module documents.
- **An n8n Enterprise license** with `feat:workerPools`. n8n's default multi-main topology also needs `feat:multipleMainInstances`. n8n's module writes the key into a Kubernetes Secret, so it is in Terraform state. n8n's module also accepts `n8n_license_key_secret_ref` instead.
- **n8n 2.41 or later** (`n8n_image_tag`, default `2.41.0`). Pools themselves need 2.39 or later.
- **Queue mode.** n8n's module always runs n8n in queue mode: `EXECUTIONS_MODE=queue` on every pod, and manual executions offloaded to workers.
- **The node package on the main pods and every worker.**
  - **From npm:** install `n8n-nodes-rpa` once under **Settings → Community nodes**; `n8n_reinstall_missing_packages = true` makes each pod that starts later reinstall it, pool workers included. The example already sets `N8N_COMMUNITY_PACKAGES_ENABLED=true`. It is an unverified community package (it depends on `playwright-core`), so n8n must allow installing unverified packages.
  - **Or a custom image** with the package baked in, from [`docker/n8n.Dockerfile`](../../../../docker/n8n.Dockerfile) (build context: the repository root): push it to your registry, add `n8n_image_repository = "<registry>/<repository>"` to the `module "n8n"` block in `main.tf` and set `n8n_image_tag` to your tag; when that tag is not an n8n version, add `n8n_task_runner_image_tag = "2.45.3"` too, or the task runner sidecar's image is not found. It keeps the npm install out of pod start, and the package loads in pool workers and webhook processors although the chart starts them past the image's entrypoint. The image can install the tarball from the [GitHub Release](https://github.com/jb-n8n/n8n-nodes-rpa/releases) instead of building the source (`--build-arg RPA_PACKAGE=release --build-context rpa-release=<directory holding the tarball>`; [the Kubernetes runbook](../../../../docs/deploy/kubernetes.md#1-before-you-start)).
- **No secrets in `n8n_extra_env`.** Its values are stored in plaintext in the Helm release and in Terraform state. The example refuses names that look like secrets (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `_PASS`, `CREDENTIAL`; `N8N_SMTP_PASS` for example) unless they end in `_FILE`.
- **The rpa-browser image** (`browser_image`), built from `images/browser/` or pulled from GHCR. Its run-server must match the node's `playwright-core` (repository README, "Version matching").

## Use it

```sh
cd deploy/terraform/examples/eks-managed-terraform-aws-n8n
cat > terraform.tfvars <<'EOF'
aws_region         = "eu-west-1"
n8n_domain         = "n8n.example.com"
route53_zone_id    = "Z0123456789ABCDEFGHIJ"
vpc_id             = "vpc-0123456789abcdef0"
vpc_cidr_block     = "10.0.0.0/16"
private_subnet_ids = ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"]
public_subnet_ids  = ["subnet-0bbbbbbbbbbbbbbb1", "subnet-0bbbbbbbbbbbbbbb2"]
browser_image      = { repository = "ghcr.io/jb-n8n/rpa-browser", tag = "<version>" }
# The sites the browser may open on 80/443; the VPC and the service range are always cut out.
browser_allowed_egress_cidrs = ["0.0.0.0/0"]
EOF
export TF_VAR_n8n_license_key='...'   # or n8n_license_key_secret_ref, see Requirements
terraform init
terraform apply
```

Then do these in order:

1. Configure kubectl with `terraform output -raw kubectl_config_command`.
2. Open n8n (`terraform output -raw n8n_url`) and create an API key under **Settings → n8n API** as the owner or an admin. Install `n8n-nodes-rpa` under **Settings → Community nodes** first, unless your n8n image has it baked in (Requirements).
3. From the repository root, export the token and the API key without typing either into the command line (shell history), then run the configure script:

   ```sh
   eval "$(terraform -chdir=deploy/terraform/examples/eks-managed-terraform-aws-n8n output -raw browser_token_command)"   # exports RPA_BROWSER_TOKEN
   read -rs N8N_API_KEY && export N8N_API_KEY   # paste the API key; nothing is echoed
   node deploy/scripts/configure-n8n.mjs \
     --n8n-url "$(terraform -chdir=deploy/terraform/examples/eks-managed-terraform-aws-n8n output -raw n8n_url)" \
     --endpoint "$(terraform -chdir=deploy/terraform/examples/eks-managed-terraform-aws-n8n output -raw browser_endpoint)"
   unset N8N_API_KEY RPA_BROWSER_TOKEN
   ```

   `terraform output -raw configure_command` prints the same `node` command with the URL and the endpoint filled in; it expects both variables exported as above and never carries them. The script creates the **RPA Browser** credential (Browser Server mode, Private Network Endpoint on) and imports the templates. Add `--project-id <id>` to create them in the project that will run RPA workflows instead of your personal project; the project id is in the project's URL in n8n (`/projects/<id>/...`).
4. Assign each project that runs RPA workflows to the `rpa` pool: **Project → Settings → Worker Pools**. n8n lists a pool there only while one of its workers runs, which is why `rpa_pool_min_replicas` defaults to 1.
5. Open **RPA: 0 Connection check** in that project (move it there if you ran step 3 without `--project-id`). Pick the credential, replace the URL in **Site to check** with your login page, and run it. The screenshot proves the network path, the egress rules and TLS.

## What the example sets

**n8n's module.** These inputs:
- `n8n_worker_pools = [{ name = "rpa", min_replicas, max_replicas, concurrency, extra_env = [] }]`
- `n8n_reinstall_missing_packages = true`
- The webhook processor's resources: `n8n_webhook_cpu_request = "800m"`, `n8n_webhook_cpu_limit = "1500m"`, `n8n_webhook_memory_request = "1Gi"` and `n8n_webhook_memory_limit = "2Gi"`. Every webhook pod reinstalls the package at boot as well, and n8n's module warns at plan time below these values when `n8n_reinstall_missing_packages` is on (check `webhook_resources_sized_for_reinstall_missing_packages`).
- `n8n_chart_version = "1.11.0-preview.workerpools.1"`. Helm reported this chart's digest as `sha256:44c36f4ec8c5512fe9f59393745312231164b262d0a950c321de06b62ecd8011` on 2026-10-22.
- `n8n_extra_env`: `N8N_COMMUNITY_PACKAGES_ENABLED=true`, plus your additions.
- `node_max = 12` (`node_max` variable). The browser pods run on n8n's node group, 2 vCPU each, and n8n's module's capacity check (`autoscaling_maxima_fit_node_group_capacity`) counts only n8n's pods: about 22.7 vCPU at their maxima with the pool and the webhook sizing above, plus 20 vCPU for 10 browser pods, against about 3.6 vCPU per t3.xlarge.

Keep the pool's capacity within the browser's: `rpa_pool_max_replicas * rpa_pool_concurrency` should not exceed `browser_max_replicas * 4` sessions. Each open run holds one session. A run that finds no free session waits up to 60 s, then fails `browser_unavailable`.

**Which pods may open sessions.** The NetworkPolicy admits these pod labels in n8n's namespace:

| Label | Value | Source in n8n's chart (`1.11.0-preview.workerpools.1`) |
|---|---|---|
| `app.kubernetes.io/name` | `n8n` | `templates/_helpers.tpl`, `n8n.podLabels`: the chart name (no `nameOverride` from n8n's module) |
| `app.kubernetes.io/instance` | `n8n` | the same helper: the release name, fixed to `n8n` in n8n's module (`n8n.tf`, `helm_release.n8n`) |
| `app.kubernetes.io/component` | `worker-group` | `templates/_worker.tpl`: `worker-group` for a `queueMode.workerGroups` entry, `worker` for the chart's default workers |
| `n8n.io/worker-pool` | `rpa` | `templates/_worker.tpl`: the group's `poolName` |

The credential's **Test** button runs on n8n's main pod, which this selector does not admit, so that test times out. Use the connection-check workflow instead. To admit every n8n pod, set `n8n_pod_selector = { "app.kubernetes.io/instance" = "n8n" }`. Two cases need that: you want the Test button, or manual runs of an RPA project land outside the pool. Whether n8n routes the manual executions of a pool-assigned project to the pool is not verified here.

**The NetworkPolicy is enforced.** EKS accepts a NetworkPolicy and ignores it unless the VPC CNI's network policy agent is on, and n8n's module leaves the CNI as EKS installed it. So the example adopts `vpc-cni` as a managed add-on with `enableNetworkPolicy = "true"`. Set `manage_vpc_cni_network_policy = false` if you already manage that add-on, and turn the agent on yourself. n8n's chart has its own NetworkPolicy, off by default. If you turn it on, it limits n8n's egress to DNS, PostgreSQL, Redis and 443, so the workers can no longer reach the browser on 3000.

**The browser's egress** is `browser_allowed_egress_cidrs` on 80 and 443, plus DNS to kube-dns. Three ranges are cut out: the VPC CIDR (nodes, pods, the database and Redis), and `10.100.0.0/16` and `172.20.0.0/16`, the service ranges EKS picks when none is set. The metadata addresses are always cut out.

**The gate token never enters Terraform state.** An ephemeral `random_password` generates it at plan and apply time. `kubernetes_secret_v1.data_wo` writes it, a write-only argument (Kubernetes provider 3.2.1 or later). To rotate it, raise `data_wo_revision` and apply, restart the browser pods, then put the new token in the RPA Browser credential (the configure script leaves an existing credential as it is). `browser_token_command` reads the token from the cluster into your shell, never into Terraform.

**Scaling.** The browser scales on CPU through the metrics-server that n8n's module installs (`hpa-cpu`). To scale on session use with KEDA, which n8n's module also installs, you need a Prometheus that scrapes port 9464. Then set `autoscaling.prometheus_server` and `metrics_from` on the browser module; see its README.

## Outputs

| Name | Description |
|---|---|
| `n8n_url` | n8n's URL. |
| `kubectl_config_command` | Configures kubectl for the cluster. |
| `browser_endpoint` | `ws://rpa-browser.rpa-browser.svc.cluster.local:3000/` |
| `browser_token_command` | Reads the gate token into `RPA_BROWSER_TOKEN`. |
| `n8n_settings` | Queue mode, the RPA Browser credential settings, the node package and notes. |
| `configure_command` | The `deploy/scripts/configure-n8n.mjs` invocation (`--n8n-url`, `--endpoint`). It reads `N8N_API_KEY` and `RPA_BROWSER_TOKEN` from the environment and never carries them. |

## Checks

`make -C deploy check` runs `terraform init -backend=false`, `validate` and `terraform test` here, which fetches n8n's module at 0.5.0, plus `tflint`. `tests/plan.tftest.hcl` plans the whole example against mocked AWS, Kubernetes and Helm providers. A failed check block fails the run, so it proves n8n's module's plan-time checks pass, including the webhook sizing and the node capacity. CI runs it on Terraform 1.11.4, the floor this example declares, and on 1.16.7. n8n's module's `main` branch already requires Terraform 1.13 or later; its pinned release 0.5.0 still accepts 1.11, so raise `required_version` when you move to a newer release of n8n's module. The first real `terraform apply` is a manual step for the owner.
