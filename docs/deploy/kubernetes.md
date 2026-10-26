# Runbook: the RPA browser service on Kubernetes

This runbook installs the RPA browser service next to an n8n that runs on Kubernetes, with Amazon EKS as the worked example. It covers the first day too: n8n's credential, the connection check and the first automation. For an n8n on Amazon ECS, use [aws-ecs.md](aws-ecs.md) instead.

The service is a Deployment of the `rpa-browser` image: Playwright's run-server behind the RPA token gate. Each pod serves a fixed number of browser sessions (4 by default), reports metrics on port 9464, and drains on scale-in. n8n's workers connect to it through the **RPA Browser** credential in Browser Server mode. Chromium never runs inside an n8n pod.

What's in the repository:

| Path | What it is |
|---|---|
| [`deploy/helm/rpa-browser`](../../deploy/helm/rpa-browser) | The Helm chart. Its README covers drain, scaling and egress in detail. |
| [`deploy/terraform/modules/k8s-browser`](../../deploy/terraform/modules/k8s-browser) | A Terraform module that installs the chart with one `helm_release`. |
| [`deploy/terraform/examples/eks-attach`](../../deploy/terraform/examples/eks-attach) | Attach: the browser service next to an n8n you already run on EKS. |
| [`deploy/terraform/examples/eks-managed-terraform-aws-n8n`](../../deploy/terraform/examples/eks-managed-terraform-aws-n8n) | Managed: n8n on EKS with n8n's own Terraform module, plus the browser service and a worker pool for RPA. |
| [`deploy/scripts/configure-n8n.mjs`](../../deploy/scripts/configure-n8n.mjs) | Creates the RPA Browser credential and imports the templates through n8n's public API. |
| [`deploy/test/kind-e2e.sh`](../../deploy/test/kind-e2e.sh) | The chart end to end on a throwaway kind cluster: the session limit and the drain on pod deletion. |

## 1. Before you start

- **n8n 2.41 or later, in queue mode.** Set `EXECUTIONS_MODE=queue` on the main pods and every worker. n8n's Helm chart and n8n's Terraform module do this already.
- **The RPA node package on the main pods and every worker.** The main pods need it to show the node and for the credential type that the public API checks; the workers need it to run.
  - **From npm:** install `n8n-nodes-rpa` once under **Settings → Community nodes**, and set `N8N_REINSTALL_MISSING_PACKAGES=true` (in n8n's module: `n8n_reinstall_missing_packages = true`) so every pod that starts later installs it too. It is an unverified community package (it depends on `playwright-core`), so n8n must allow installing unverified packages. Loading it needs `N8N_COMMUNITY_PACKAGES_ENABLED=true`.
  - **Or a custom image** with the package baked in, from [`docker/n8n.Dockerfile`](../../docker/n8n.Dockerfile) (build context: the repository root): push it to your registry and run it as n8n's image for the main pods and the workers. It keeps the npm install out of pod start.
  - The templates name the node by its package (`n8n-nodes-rpa.playwright`). If an imported template shows an unknown node, the package is missing on that pod, or the templates come from a different version: import them from the installed version (the package's `templates/` folder, or the repository at its `v<version>` tag).
- **Tools:** Terraform 1.11 or later, `kubectl`, `helm` (3 or 4), `node` 22 or later and `openssl`. On EKS, the AWS CLI as well: the providers get cluster tokens from `aws eks get-token`.
- **A CNI that enforces NetworkPolicy.** Without one, the browser's NetworkPolicy is accepted and silently ignored. On EKS, turn on the VPC CNI's network policy agent (see [Security notes](#9-security-notes)). Calico and Cilium also enforce it.
- **For scaling on session use (KEDA):** KEDA, and a Prometheus that scrapes port 9464 of the browser pods. Without them the chart scales on CPU (`hpa-cpu`), which needs metrics-server.

## 2. Choose attach or managed

| You have | Use |
|---|---|
| n8n already running on Kubernetes (any distribution; the example is EKS) | **Attach**: `eks-attach`, or the `k8s-browser` module in your own root module, or the chart alone with `helm install`. |
| No n8n yet, and you want it on EKS | **Managed**: `eks-managed-terraform-aws-n8n`. It deploys n8n with n8n's module, an `rpa` worker pool, and the browser service in a namespace of its own. |
| n8n on Amazon ECS | [aws-ecs.md](aws-ecs.md). The ECS setup is attach only; n8n publishes no ECS module. |

The managed example uses worker pools, an early-alpha n8n feature that needs an Enterprise license with `feat:workerPools`, and a preview build of n8n's chart. Read its README before you choose it.

## 3. The image

The image is `ghcr.io/jb-n8n/rpa-browser:<version>`, built from `images/browser/`. Its Playwright version must match the node's `playwright-core` (1.63 today; repository README, "Version matching"). A mismatch fails every run with `browser_unavailable` and names the version it needs.

**Publishing it (owner, once).** `.github/workflows/browser-image.yml` publishes only from a `browser-v<major>.<minor>.<patch>` tag on `main`, or from `main` by hand, after the image's tests pass. Before the first publish:

1. Create the GitHub environment `ghcr` (**Settings → Environments**). Add required reviewers, and a deployment branch and tag policy that allows only `main` and `browser-v*`. Without it, GitHub creates the environment on the first run with no approval gate.
2. Push a tag, for example `git tag browser-v0.1.0 && git push origin browser-v0.1.0`, and approve the run.
3. Make the package public (**Packages → rpa-browser → Package settings → Change visibility**), or give your cluster a pull secret (`imagePullSecrets`).
4. Check the provenance: `gh attestation verify oci://ghcr.io/jb-n8n/rpa-browser:<version> --owner jb-n8n`.

To keep image pulls inside your network, copy the image into your own registry, for example with `docker buildx imagetools create --tag <registry>/rpa-browser:<version> ghcr.io/jb-n8n/rpa-browser:<version>`, and pin it by digest (`image.digest`).

## 4. Create the token secret

n8n's credential and the gate share one token, 32 characters or more. The chart and the module never create it and never take it as a value, so it stays out of Helm values and Terraform state.

**By hand.** The token goes from `openssl` to the Secret through a pipe, so it is in no command line and no shell history:

```sh
kubectl create namespace rpa-browser
openssl rand -hex 32 | tr -d '\n' \
  | kubectl -n rpa-browser create secret generic rpa-browser-token --from-file=token=/dev/stdin
```

**With External Secrets**, from a secret in AWS Secrets Manager whose value is the token:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: rpa-browser-token
  namespace: rpa-browser
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: aws-secrets-manager   # your store
  target:
    name: rpa-browser-token
  data:
    - secretKey: token
      remoteRef:
        key: rpa-browser/token  # the Secrets Manager secret
```

**The managed example** creates the Secret itself, write-only, from an ephemeral password: skip this step there.

Don't read the Secret back with a Terraform `kubernetes_secret` data source: that copies the token into state.

The gate reads the token at start. After a rotation, restart the pods (`kubectl -n rpa-browser rollout restart deploy/rpa-browser`: each old pod drains first) and update n8n's credential.

## 5. Deploy

**Attach (`eks-attach`):**

```sh
cd deploy/terraform/examples/eks-attach
cat > terraform.tfvars <<'EOF'
aws_region           = "eu-west-1"
cluster_name         = "n8n"
namespace            = "rpa-browser"       # holds the token Secret
n8n_namespace        = "n8n"
image                = { repository = "ghcr.io/jb-n8n/rpa-browser", tag = "<version>" }
allowed_egress_cidrs = ["0.0.0.0/0"]       # the sites the browser may open on 80/443
vpc_cidrs            = ["10.0.0.0/16"]     # cut out of the allowed CIDRs, with the cluster's service range
n8n_url              = "https://n8n.example.com"
EOF
terraform init
terraform plan -out tfplan
terraform apply tfplan
```

Check `n8n_pod_selector` before you apply. Its default admits the workers of n8n's Helm chart released as `n8n` (`app.kubernetes.io/component=worker`). Compare it with `kubectl -n n8n get pods --show-labels`.

**Managed (`eks-managed-terraform-aws-n8n`):** follow its README. It runs `terraform init` and `apply` the same way, and needs the n8n license key in `TF_VAR_n8n_license_key`. To run the custom n8n image from section 1, add `n8n_image_repository` to its `module "n8n"` block and set the `n8n_image_tag` variable in your tfvars (the block already sets it).

**Your own root module, or the chart alone:** see the [module README](../../deploy/terraform/modules/k8s-browser/README.md) and the [chart README](../../deploy/helm/rpa-browser/README.md).

After the apply:

```sh
kubectl -n rpa-browser get pods,svc,networkpolicy,pdb,hpa,scaledobject
kubectl -n rpa-browser logs deploy/rpa-browser | head
```

Each pod is Ready once `/healthz` answers `200`. The gate's log names its session limit; it never prints the token.

**Which pods may connect.** The NetworkPolicy admits port 3000 only from `n8n_pod_selector` (in `n8n_namespace_selector`). Two n8n features run on other pods:

- **The credential's Test button runs on n8n's main pod.** If the selector admits only workers, the test times out. Either admit the main pod too, for example `n8n_pod_selector = { "app.kubernetes.io/instance" = "n8n" }`, or skip the button and use the connection-check workflow in section 7, which runs where your executions run.
- **Manual executions** run on the main pod unless `OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true` (n8n's chart sets it). With worker pools, whether a pool-assigned project's manual runs go to the pool isn't verified (see the checklist).

## 6. Configure n8n

`configure-n8n.mjs` creates the **RPA Browser** credential (Browser Server mode, the endpoint, the token, Private Network Endpoint on for a `ws://` endpoint) and imports the templates. It is idempotent: it skips a credential or workflow with the same name and says so.

1. In n8n, create an API key as the owner or an admin: **Settings → n8n API**. Listing credentials, which the script needs to stay idempotent, is limited to those roles.
2. From the repository root, put both secrets into your shell's environment without typing them into a command line:

   ```sh
   read -rs N8N_API_KEY && export N8N_API_KEY          # paste the key, then Enter
   export RPA_BROWSER_TOKEN="$(kubectl -n rpa-browser get secret rpa-browser-token -o jsonpath='{.data.token}' | base64 -d)"
   node deploy/scripts/configure-n8n.mjs --n8n-url https://n8n.example.com \
     --endpoint "$(terraform -chdir=deploy/terraform/examples/eks-attach output -raw browser_endpoint)"
   unset N8N_API_KEY RPA_BROWSER_TOKEN
   ```

   `terraform output -raw configure_command` prints the same `node` command with the URL and the endpoint filled in; it expects both variables exported as above and never carries them. The managed example also has `browser_token_command`, which prints the `export RPA_BROWSER_TOKEN=...` line. The script reads both secrets from the environment only and never prints them.
3. Add `--project-id <id>` to create the credential and the workflows in the project that will run RPA workflows rather than in your personal project; the id is in the project's URL in n8n (`/projects/<id>/...`). Use an `https://` n8n URL: the script warns when the key and the token would cross the network unencrypted.
4. The script stops early, with the reason, when the node package isn't installed (the credential type is unknown to n8n), the API key can't list credentials, or a credential with the same name but another type exists.

To set the credential up by hand instead: **+ → New credential → RPA Browser**, Mode **Browser Server**, Endpoint URL `ws://rpa-browser.rpa-browser.svc.cluster.local:3000/`, the token, **Private Network Endpoint** on.

## 7. First day

1. **Connection check.** Open **RPA: 0 Connection check**, pick the **RPA Browser** credential on the RPA node, replace the URL in **Site to check** with the login page of the site you'll automate, and run it. The screenshot proves the whole path: n8n to the browser service, the browser's egress rules, DNS and TLS. If it fails:

   | Message | Cause |
   |---|---|
   | `Could not connect to the browser server at ...` or a timeout | The NetworkPolicy doesn't admit the pod that ran it (section 5), or the service isn't Ready. |
   | `... refused the token ...` | The credential's token doesn't match the Secret, or the pods haven't restarted since a rotation. |
   | `The browser server is version X but this node needs Y` | Image and node package versions differ (section 3). |
   | `... had no free browser session for 60 s ...` | Every session was busy for the engine's whole 60 s wait: add capacity (section 8). |
   | A navigation timeout or a DNS error on the page | The browser's egress: `allowed_egress_cidrs`, `egress_except_cidrs`, or DNS (NodeLocal DNSCache, section 9). The attach examples don't expose `egress_except_cidrs`; add it to the example's `module` block. |

2. **Hello world.** Open **RPA: Hello world**, pick the credentials and run it. It takes a screenshot and extracts a table, as in the repository README's "Hello world in 10 minutes". Its second node, **Extract the sandbox table**, reads `http://sandbox:8080`, the repository's compose sandbox, which your cluster doesn't have: point it at a table on a page of your own, or remove it.
3. **First automation.** Run **RPA: 1 Create tables (run once)** once; it creates the two Data Tables. Then follow the repository README's "The self-healing data feed": **RPA: 2 Data feed** runs the steps, and **RPA: 3 Approve steps** is where a person approves repaired steps. Pick the credentials on each node; the sticky notes list them.

## 8. Sizing

Every RPA run holds one browser session from its first step to its last, and each session is its own Chromium.

- **Start at 4 sessions per pod on 2 vCPU and 4 GiB**, the chart's defaults (`sessionsPerReplica: 4`, requests `cpu: 2`, `memory: 4Gi`, memory limit `4Gi`, no CPU limit: a throttled browser times out). Then measure with your real sites:
  - Hold 4 sessions on one pod with real workflows (or the load test in section 10) and watch `kubectl top pod` or your dashboards. Memory is usually the limit. Keep the peak under about 75 % of the limit; if it goes over, lower `sessionsPerReplica` or raise memory.
  - CPU peaks while pages load. Keep the CPU request at about what 4 loading pages use, so the scheduler places pods where they fit.
- **`/tmp`** (`tmpVolume.sizeLimit`, 2Gi) holds Chromium's profiles, downloads and caches. A pod that writes more than the limit is **evicted at once, with no drain**, and its sessions end. Raise it for runs that download large files. With `tmpVolume.medium: Memory` it counts against the memory limit.
- **Capacity on both sides.** Total sessions = `autoscaling.max × sessionsPerReplica` (40 by default). n8n can start at most `workers × worker concurrency` RPA runs at once; keep that at or below the browser's capacity. A run that finds every session busy waits up to 60 s, then fails `browser_unavailable` ("no free browser session"), so excess runs fail rather than hang.
- **Nodes.** Browser pods need room on your nodes at `autoscaling.max`: 10 pods at the default 2 vCPU request is 20 vCPU. In the managed example they share n8n's node group; raise its `node_max` together with `browser_max_replicas` (its README shows the arithmetic).
- **Drain time** (`drainSeconds`, 600) should cover your longest run. It sets the grace period (`drainSeconds + 30`).

## 9. Security notes

- **The browser's egress.** The NetworkPolicy allows DNS to kube-dns and `allowed_egress_cidrs` on 80 and 443, nothing else.
  - **List the cluster's own ranges in `egress_except_cidrs`** (`egress.exceptCIDRs` in the chart): the VPC or node range, the pod range and the service range. NetworkPolicy applies after Service translation, so `0.0.0.0/0` on 80/443 opens every in-cluster pod listening on 80 or 443 (an ingress controller, a dashboard, a webhook), though not n8n (5678), Redis (6379) or Postgres (5432) on their own ports. If n8n's database or Redis sits outside the cluster in a private range, list that range too. On EKS the default service ranges are `10.100.0.0/16` or `172.20.0.0/16`; `eks-attach` reads the cluster's and adds `vpc_cidrs`.
  - **Metadata addresses are always cut out** of every allowed CIDR: `169.254.0.0/16` (the cloud metadata services, including 169.254.169.254), `fe80::/10`, `fd00:ec2::/32`, `100.100.100.200/32`, `168.63.129.16/32` and `fd20:ce::254/128`.
  - **NodeLocal DNSCache.** Pods that use it send DNS to `169.254.20.10`, not to kube-dns, and the policy would block that. Add `169.254.20.10/32` to `dns_ip_blocks` (`egress.dns.ipBlocks`); it is the only metadata-range address the chart accepts, and only for port 53. The attach examples don't expose `dns_ip_blocks`; add it to the example's `module` block.
- **Enforcement.** On EKS, the VPC CNI enforces NetworkPolicy only with its network policy agent on: `aws eks update-addon --cluster-name <cluster> --addon-name vpc-cni --configuration-values '{"enableNetworkPolicy":"true"}'`, or the add-on's configuration in Terraform. The managed example adopts `vpc-cni` as a managed add-on with `resolve_conflicts_on_create = "OVERWRITE"`. Adopting it that way replaces a self-managed CNI configuration (custom environment variables such as warm IP targets or custom networking); if you have one, set `manage_vpc_cni_network_policy = false` and turn the agent on yourself.
- **Domain allowlists.** NetworkPolicy matches addresses only. For names:
  - On Cilium, `egress_fqdns` (`egress.fqdns`) adds a CiliumNetworkPolicy that allows the listed names on 80/443 through Cilium's DNS proxy, and denies the metadata ranges and `egress_except_cidrs` on every port, so a name that resolves into them stays blocked.
  - Elsewhere, route the browser's egress through a transparent filtering gateway. The gate doesn't pass proxy settings to the browser, and an explicit forward proxy would also blur the engine's address checks (repository README, "Address checks run in n8n").
- **Ingress** on 3000 comes only from `n8n_pod_selector`; on 9464 only from `metrics_from`. The Service never carries 9464.
- **The token.**
  - It stays out of Terraform state, Helm values, logs and metrics.
  - **Residual risk:** the gate and Chromium run as the same user (`pwuser`). The run-server and the browsers start without the token in their environment, but a page that escaped Chromium and ran code as that user could read it from the gate's `/proc/<pid>/environ`. With the token it could open sessions on this service, which only n8n's pods can reach. Rotate the token if you suspect a browser compromise.
- **Pod hardening:** non-root (uid 1001), no privilege escalation, all capabilities dropped, read-only root filesystem, RuntimeDefault seccomp, no service account token, no service links.
- **Removing or renaming the release** removes the NetworkPolicy at once while old pods may still drain open sessions for up to `drainSeconds`, with unrestricted egress. Scale to 0 or wait until `rpa_browser_sessions_active` is 0 first, or keep a default-deny policy in the namespace.

## 10. Drain, evictions and scaling

**Drain.** A pod being removed gets SIGTERM. Its gate refuses new sessions (`503`, `X-RPA-Browser: draining`), turns `/healthz` to 503 so the pod leaves the Service, and exits once its sessions end or `drainSeconds` passes. `deploy/test/kind-e2e.sh` shows it on a kind cluster: the pod stays Terminating while a session is open and goes about a second after the session closes. Whatever removes pods has to allow `drainSeconds + 30` (630 s by default):

- **cluster-autoscaler** caps scale-down evictions at `--max-graceful-termination-sec`, 600 by default, which is less than 630. Set it to at least `drainSeconds + 30`, or keep it off browser pods with the pod annotation `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` (`podAnnotations`). Karpenter: check its `terminationGracePeriod` on the NodePool.
- **Node drains** go through the PodDisruptionBudget, `maxUnavailable: 1` by default: one pod at a time, and even a single pod can be evicted (it still drains its full grace). Set `podDisruptionBudget.minAvailable` to keep pods serving instead; with it at or above the pod count, evictions wait.
- **Rollouts** add a new pod before the old one drains (`maxSurge: 1`, `maxUnavailable: 0`).

**Scaling modes** (`autoscaling.mode`):

| Mode | When | Signal |
|---|---|---|
| `keda` | Default once `autoscaling.prometheus_server` is set | Session utilisation: `sum(active) / sum(capacity)` over this release's pods that aren't draining, target 0.7 |
| `hpa-cpu` | Default without Prometheus | CPU at 70 % of the request |
| `none` | Fixed size | `replicas` (in the module, `autoscaling.min`) |

KEDA details that matter:
- **`metrics_from` is required** while the NetworkPolicy is on: it must admit your Prometheus pods to port 9464, or the scrape is blocked and KEDA sees nothing. The module and the chart refuse an empty list in that case.
- The query selects the labels `namespace` and `app_kubernetes_io_instance`. `pod_monitor_enabled` writes both; a scrape config of your own must write the same two.
- `ignoreNullValues` is `false`: with no samples, or every pod draining (0 / 0), the scaler reports an error and KEDA keeps the current replica count. It never scales in on missing data, but it doesn't scale out either until samples come back.
- With Amazon Managed Prometheus, pass a `TriggerAuthentication` with pod identity as `autoscaling.authentication_ref`, and set `autoscaling.prometheus_extra_metadata`:

  ```hcl
  autoscaling = {
    prometheus_server         = "https://aps-workspaces.<region>.amazonaws.com/workspaces/<id>"
    authentication_ref        = "<TriggerAuthentication name>"
    prometheus_extra_metadata = { awsRegion = "<region>" }
  }
  ```

**Verify scaling after the first apply:**

1. The metrics reach Prometheus. In Prometheus, `rpa_browser_sessions_capacity{namespace="rpa-browser"}` returns one series per pod.
2. The scaler is healthy: `kubectl -n rpa-browser get scaledobject,hpa`. The ScaledObject is `READY True`, and `kubectl -n rpa-browser describe scaledobject rpa-browser` shows no errors. In `hpa-cpu` mode, the HPA shows a CPU percentage, not `<unknown>`.
3. **A load test with N held sessions scales out.** Hold `sessionsPerReplica × current pods` sessions (100 % utilisation) from inside an n8n worker. The worker is admitted by the NetworkPolicy and already has the node's `playwright-core`: the custom n8n image from section 1 installs it under `/opt/n8n-rpa/node_modules` (`docker/n8n.Dockerfile`), and its entrypoint copies it to `/home/node/.n8n/nodes/node_modules`, where a Community nodes install puts it too. The script takes the first that exists. The token goes through stdin:

   ```sh
   cat > /tmp/hold-sessions.js <<'EOF'
   // Opens N browser sessions, retrying while every session is busy, holds them HOLD seconds, then closes them.
   const fs = require('fs');
   const pw = ['/opt/n8n-rpa/node_modules/playwright-core', '/home/node/.n8n/nodes/node_modules/playwright-core'].find((p) => fs.existsSync(p));
   const { chromium } = require(pw);
   const token = fs.readFileSync(0, 'utf8').trim();
   const n = Number(process.env.N), holdMs = Number(process.env.HOLD) * 1000;
   const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
   (async () => {
     const held = [];
     for (let i = 1; i <= n; i += 1) {
       for (;;) {
         try {
           held.push(await chromium.connect(process.env.ENDPOINT, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }));
           console.log(new Date().toISOString(), `session ${i} open`);
           break;
         } catch (err) {
           console.log(new Date().toISOString(), `session ${i}: ${err.message.split('\n').slice(-1)[0]}; retrying in 5 s`);
           await sleep(5000);
         }
       }
     }
     await sleep(holdMs);
     await Promise.all(held.map((b) => b.close()));
   })();
   EOF
   kubectl -n rpa-browser get secret rpa-browser-token -o jsonpath='{.data.token}' | base64 -d \
     | kubectl -n n8n exec -i <worker pod> -- env N=8 HOLD=900 \
         ENDPOINT=ws://rpa-browser.rpa-browser.svc.cluster.local:3000/ node -e "$(cat /tmp/hold-sessions.js)"
   ```

   With 1 pod of 4 sessions, N=8 holds 4 at once, then waits on `busy` until a second pod is Ready, then opens the other 4. Watch `kubectl -n rpa-browser get hpa -w`: the replica count rises within a few minutes (the ScaledObject polls every 15 s). When the script closes its sessions, the count falls back after the HPA's scale-down stabilisation (5 minutes by default). Removed pods leave at once because they hold no sessions.

## 11. First-apply checklist

These were checked against documentation, schemas and renders, or on kind, but not on a real cluster. Tick them on the first apply:

- [ ] **NetworkPolicy is enforced.** From a pod that isn't an n8n worker, the gate's port times out: `kubectl -n n8n run np-check --rm -it --restart=Never --image=busybox:1.37 -- nc -zv -w 5 rpa-browser.rpa-browser.svc.cluster.local 3000`. From a worker, the connection check works.
- [ ] **The pod selector matches.** `kubectl -n n8n get pods --show-labels` shows the selector's labels on the workers (for worker pools: `app.kubernetes.io/component=worker-group`, `n8n.io/worker-pool=rpa`).
- [ ] **The credential type is accepted by the public API.** `configure-n8n.mjs` creates the credential without a schema error.
- [ ] **Pool routing** (managed example): a manual run of a workflow in a pool-assigned project lands on a pool worker. If it doesn't, admit every n8n pod (section 5).
- [ ] **The managed example's first apply:** the `vpc-cni` add-on adoption with `OVERWRITE` leaves pod networking working (pods keep getting IPs, nodes stay Ready), and the token Secret written through `data_wo` exists with a `token` key of 48 characters, while `terraform state show` holds no value for it.
- [ ] **KEDA scales on the session query**: `threshold: "0.7"` with `metricType: Value` gives the expected replica count in the load test.
- [ ] **No samples keeps the count**: stop Prometheus scraping briefly (or set an impossible label); the ScaledObject reports an error and the replica count stays.
- [ ] **Cilium only:** a deny over the pod range in `egress_except_cidrs` doesn't also block DNS to kube-dns. Cilium's CIDR rules are meant to match only destinations outside the cluster; confirm that names still resolve in the browser pod. Also confirm a name in `egress_fqdns` loads and a name outside it doesn't.
- [ ] **Evictions wait for the drain:** drain a node that runs a browser pod with a session open; the pod stays Terminating until the session ends. With cluster-autoscaler, check `--max-graceful-termination-sec` first.
- [ ] **A rollout with draining pods** (`terraform apply` after an image change) completes while old pods are still draining. Helm's wait looks at the new ReplicaSet, so it shouldn't wait for them.

Settled while building, for reference:
- playwright-core's connect error carries the gate's `503` and `busy` or `draining`, so the engine's wait for a free session works on the error text alone.
- The supervisor never relies on how the run-server handles SIGTERM: it signals the gate first and stops the run-server last, killing it if needed.
- n8n's chart labels for worker pools and the `n8n-io/n8n/aws` registry address were read from their sources at the pinned versions (managed example README).
- The read-only root filesystem with `/tmp` on an emptyDir, `fsGroup` and the probes work: `kind-e2e.sh` runs the chart with them.

## Upgrades

- **Image.** Change `image.tag` (or `digest`) and apply. New pods start first; old pods drain. Keep the image's Playwright version equal to the node package's `playwright-core`: upgrade both together (repository README, "Version matching").
- **Chart or module.** `terraform plan` shows chart template changes too: the module adds a digest of the chart's files to the values.
- **n8n.** Keep n8n at 2.41 or later.
