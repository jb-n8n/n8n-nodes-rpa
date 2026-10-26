# Runbook: the RPA browser service on Amazon ECS

This runbook attaches the RPA browser service to an n8n that already runs on Amazon ECS. It covers the first day too: n8n's credential, the connection check and the first automation. For an n8n on Kubernetes (including EKS), use [kubernetes.md](kubernetes.md) instead.

The service is an ECS service of the `rpa-browser` image (Playwright's run-server behind the RPA token gate) on Fargate, behind an internal Network Load Balancer. Each task serves a fixed number of browser sessions (4 by default), protects itself from scale-in while sessions are open, and scales on session utilisation through CloudWatch. n8n's workers connect to it through the **RPA Browser** credential in Browser Server mode. Chromium never runs inside an n8n task.

What's in the repository:

| Path | What it is |
|---|---|
| [`deploy/terraform/modules/aws-ecs-browser`](../../deploy/terraform/modules/aws-ecs-browser) | The Terraform module. Its README has every input, the security group table and the provider facts. |
| [`deploy/terraform/examples/ecs-attach`](../../deploy/terraform/examples/ecs-attach) | An example root module that calls it. |
| [`deploy/scripts/configure-n8n.mjs`](../../deploy/scripts/configure-n8n.mjs) | Creates the RPA Browser credential and imports the templates through n8n's public API. |

## 1. Before you start

- **n8n 2.41 or later, in queue mode**, on ECS in a VPC with private subnets. Set `EXECUTIONS_MODE=queue` on the main task and every worker.
- **The RPA node package on the main task and every worker.** The main task needs it to show the node and for the credential type that the public API checks; the workers need it to run.
  - **From npm:** install `n8n-nodes-rpa` under **Settings → Community nodes**, with `N8N_REINSTALL_MISSING_PACKAGES=true` on every task so tasks that start later install it too. It is an unverified community package (it depends on `playwright-core`), so n8n must allow installing unverified packages. Loading it needs `N8N_COMMUNITY_PACKAGES_ENABLED=true`.
  - **Or a custom image** with the package baked in, from [`docker/n8n.Dockerfile`](../../docker/n8n.Dockerfile) (build context: the repository root): push it to ECR and use it in the task definitions of the main task and the workers. It keeps the npm install out of task start.
  - The templates name the node by its package (`n8n-nodes-rpa.playwright`). If an imported template shows an unknown node, the package is missing on that task, or the templates come from a different version: import them from the installed version (the package's `templates/` folder, or the repository at its `v<version>` tag).
- **An existing ECS cluster** with Fargate, in n8n's VPC, and the security group IDs of n8n's tasks.
- **Outbound HTTPS from the private subnets**, through a NAT gateway or VPC endpoints, to the image registry, Secrets Manager and CloudWatch Logs. On Fargate the task reaches all three through its own network interface, so the module opens 443 to `platform_egress_cidrs` for them.
- **Tools:** Terraform 1.11 or later, the AWS CLI, `node` 22 or later and `openssl`.

## 2. Choose your path

| You have | Use |
|---|---|
| n8n on Amazon ECS | **Attach**, this runbook: `ecs-attach`, or the `aws-ecs-browser` module in your own root module. |
| n8n on Kubernetes or EKS | [kubernetes.md](kubernetes.md) (attach). |
| No n8n yet | [kubernetes.md](kubernetes.md), managed: n8n on EKS with n8n's own Terraform module. n8n publishes no ECS module, so there is no managed ECS path. |

## 3. The image

The image is `ghcr.io/jb-n8n/rpa-browser:<version>`, built from `images/browser/`. Its Playwright version must match the node's `playwright-core` (1.63 today; repository README, "Version matching"). A mismatch fails every run with `browser_unavailable` and names the version it needs.

**Publishing it (owner, once).** `.github/workflows/browser-image.yml` publishes only from a `browser-v<major>.<minor>.<patch>` tag on `main`, or from `main` by hand, after the image's tests pass. Before the first publish:

1. Create the GitHub environment `ghcr` (**Settings → Environments**). Add required reviewers, and a deployment branch and tag policy that allows only `main` and `browser-v*`. Without it, GitHub creates the environment on the first run with no approval gate.
2. Push a tag, for example `git tag browser-v0.1.0 && git push origin browser-v0.1.0`, and approve the run.
3. Make the package public (**Packages → rpa-browser → Package settings → Change visibility**).
4. Check the provenance: `gh attestation verify oci://ghcr.io/jb-n8n/rpa-browser:<version> --owner jb-n8n`.

**Pulling it from ECR** keeps image pulls inside AWS (with VPC endpoints for ECR and S3). Copy it, for example with `docker buildx imagetools create --tag <account>.dkr.ecr.<region>.amazonaws.com/rpa-browser:<version> ghcr.io/jb-n8n/rpa-browser:<version>`, and pass that URI as `image`, ideally with `@sha256:<digest>`. For an ECR image the module grants the execution role pull rights on that repository only.

## 4. The token secret

n8n's credential and the gate share one token, 32 characters or more.

**Default: the module makes it.** An ephemeral `random_password` generates 48 letters and digits at plan and apply time and writes it to a new Secrets Manager secret through the write-only `secret_string_wo`. Terraform never stores it in the plan or state, and no output carries it; `token_secret_arn` is the ARN only. The task reads it at start through `secrets.valueFrom`.

**Bring your own:** create a secret whose whole `SecretString` is the token, without the token on a command line:

```sh
umask 077
openssl rand -hex 32 | tr -d '\n' > token.txt
aws secretsmanager create-secret --region <region> --name rpa-browser/token --secret-string file://token.txt \
  --query ARN --output text
rm token.txt
```

Pass the full ARN (with its 6-character suffix) as `existing_token_secret_arn`, and the KMS key as `token_kms_key_arn` if the secret uses a customer managed key. Don't read the secret with a `data "aws_secretsmanager_secret_version"`: that copies the token into state.

**Rotation.** With the generated secret, raise `secret_string_wo_version` in the module's `secret.tf` from 1 to 2 and apply (it is a literal on purpose: the provider refuses an ephemeral value there). With your own secret, put a new value. Then force a new deployment (`aws ecs update-service --cluster <cluster> --service <name> --force-new-deployment`) and update n8n's credential. Tasks with open sessions stay protected until those end.

## 5. Deploy

```sh
cd deploy/terraform/examples/ecs-attach
cat > terraform.tfvars <<'EOF'
aws_region             = "eu-west-1"
vpc_id                 = "vpc-0123456789abcdef0"
private_subnet_ids     = ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"]
cluster_arn            = "arn:aws:ecs:eu-west-1:123456789012:cluster/n8n"
image                  = "ghcr.io/jb-n8n/rpa-browser:<version>"
n8n_security_group_ids = ["sg-0123456789abcdef0"]   # n8n's workers (and main, see below)
allowed_egress_cidrs   = ["203.0.113.0/24"]         # the sites the browser may open on 80/443
platform_egress_cidrs  = ["0.0.0.0/0"]              # required: image pull (GHCR), Secrets Manager, Logs through NAT
n8n_url                = "https://n8n.example.com"
EOF
terraform init
terraform plan -out tfplan
terraform apply tfplan
terraform output n8n_settings
```

`platform_egress_cidrs` has no default on purpose. Behind a NAT gateway it is `["0.0.0.0/0"]`: pulling the image from GHCR needs 443 to the internet, as do Secrets Manager and CloudWatch Logs without VPC endpoints. It widens the browser's egress too: the task has one network interface, so the browser can use that 443 path whatever `allowed_egress_cidrs` says. With VPC endpoints and the image in ECR (section 3), list the endpoint subnets instead (the S3 gateway endpoint for ECR's layers is the module's `platform_egress_prefix_list_ids`).

`n8n_settings.notes` lists what's left for n8n, with your region and ARNs filled in, and warns about risky inputs (an empty egress list, the whole internet, the EC2 launch type).

**Which n8n tasks may connect.** Only the security groups in `n8n_security_group_ids` reach the load balancer on port 3000. If their egress is restricted, allow TCP 3000 to `load_balancer_security_group_id`. Two n8n features run on the main task:
- **The credential's Test button runs on n8n's main task.** Add the main task's security group, or skip the button and use the connection-check workflow in section 7.
- **Manual executions** run on the main task unless `OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true`. Without that setting, the main task's security group has to be in the list for manual runs to reach the browser.

After the apply:

```sh
aws ecs describe-services --cluster <cluster> --services rpa-browser \
  --query 'services[0].{running:runningCount,desired:desiredCount,events:events[0:3].message}'
aws elbv2 describe-target-health --target-group-arn "$(aws elbv2 describe-target-groups --names rpa-browser \
  --query 'TargetGroups[0].TargetGroupArn' --output text)"
```

Targets turn `healthy` once `/healthz` answers 200. The gate's log (CloudWatch Logs, log group `/ecs/rpa-browser` unless you renamed it) names its session limit and never prints the token.

## 6. Configure n8n

`configure-n8n.mjs` creates the **RPA Browser** credential (Browser Server mode, the endpoint, the token, Private Network Endpoint on for a `ws://` endpoint) and imports the templates. It is idempotent: it skips a credential or workflow with the same name and says so.

1. In n8n, create an API key as the owner or an admin: **Settings → n8n API**. Listing credentials, which the script needs to stay idempotent, is limited to those roles.
2. From the repository root, put both secrets into your shell's environment without typing them into a command line:

   ```sh
   read -rs N8N_API_KEY && export N8N_API_KEY          # paste the key, then Enter
   export RPA_BROWSER_TOKEN="$(aws secretsmanager get-secret-value --region <region> \
     --secret-id "$(terraform -chdir=deploy/terraform/examples/ecs-attach output -raw token_secret_arn)" \
     --query SecretString --output text)"
   node deploy/scripts/configure-n8n.mjs --n8n-url https://n8n.example.com \
     --endpoint "$(terraform -chdir=deploy/terraform/examples/ecs-attach output -raw browser_endpoint)"
   unset N8N_API_KEY RPA_BROWSER_TOKEN
   ```

   `terraform output -raw configure_command` prints the same `node` command with the URL and the endpoint filled in; it expects both variables exported as above and never carries them. The script reads both secrets from the environment only and never prints them.
3. Add `--project-id <id>` to create the credential and the workflows in the project that will run RPA workflows rather than in your personal project; the id is in the project's URL in n8n (`/projects/<id>/...`). Use an `https://` n8n URL: the script warns when the key and the token would cross the network unencrypted.
4. The script stops early, with the reason, when the node package isn't installed (the credential type is unknown to n8n), the API key can't list credentials, or a credential with the same name but another type exists.

To set the credential up by hand instead: **+ → New credential → RPA Browser**, Mode **Browser Server**, Endpoint URL from `terraform output -raw browser_endpoint` (`ws://<internal NLB>:3000/`), the token, **Private Network Endpoint** on.

## 7. First day

1. **Connection check.** Open **RPA: 0 Connection check**, pick the **RPA Browser** credential on the RPA node, replace the URL in **Site to check** with the login page of the site you'll automate, and run it. The screenshot proves the whole path: n8n to the load balancer, the browser's egress, DNS and TLS. If it fails:

   | Message | Cause |
   |---|---|
   | `Could not connect to the browser server at ...` or a timeout | The task that ran it isn't in `n8n_security_group_ids`, its egress doesn't allow 3000 to the load balancer, or no target is healthy. |
   | `... refused the token ...` | The credential's token doesn't match the secret, or the tasks haven't restarted since a rotation. |
   | `The browser server is version X but this node needs Y` | Image and node package versions differ (section 3). |
   | `... had no free browser session for 60 s ...` | Every session was busy for the engine's whole 60 s wait: add capacity (section 8). |
   | A navigation timeout or a DNS error on the page | The browser's egress: `allowed_egress_cidrs`, or DNS (`vpc_dns_cidrs` for custom resolvers; the `ecs-attach` example doesn't expose it, so add it to the example's `module` block). |

2. **Hello world.** Open **RPA: Hello world**, pick the credentials and run it. It takes a screenshot and extracts a table, as in the repository README's "Hello world in 10 minutes". Its second node, **Extract the sandbox table**, reads `http://sandbox:8080`, the repository's compose sandbox, which your VPC doesn't have: point it at a table on a page of your own, or remove it.
3. **First automation.** Run **RPA: 1 Create tables (run once)** once; it creates the two Data Tables. Then follow the repository README's "The self-healing data feed": **RPA: 2 Data feed** runs the steps, and **RPA: 3 Approve steps** is where a person approves repaired steps. Pick the credentials on each node; the sticky notes list them.

## 8. Sizing

Every RPA run holds one browser session from its first step to its last, and each session is its own Chromium.

- **Start at 4 sessions per task on 2 vCPU and 4 GB**, the module's defaults (`sessions_per_task = 4`, `cpu = 2048`, `memory = 4096`). Then measure with your real sites:
  - Hold 4 sessions on one task with real workflows (or the load test in section 10) and watch the service's `MemoryUtilization` and `CPUUtilization` in CloudWatch (Container Insights gives per-task detail). Memory is usually the limit. Keep the peak under about 75 %; if it goes over, lower `sessions_per_task` or raise `memory`.
  - On Fargate, `cpu` and `memory` must be a valid pair (the module checks the documented pairs). For example, 8 sessions on 4 vCPU and 8 GB (`cpu = 4096`, `memory = 8192`) is the same ratio.
- **Disk.** The root filesystem is read-only; Chromium's profiles, downloads and caches go to `/tmp`, a bind mount on Fargate's ephemeral storage (20 GiB by default), removed with the task.
- **Capacity on both sides.** Total sessions = `max_tasks × sessions_per_task` (40 by default). n8n can start at most `workers × worker concurrency` RPA runs at once; keep that at or below the browser's capacity. A run that finds every session busy waits up to 60 s, then fails `browser_unavailable` ("no free browser session"), so excess runs fail rather than hang.
- **`max_run_seconds`** (600) should cover your longest run. It sets the gate's drain time, the default deregistration delay (+60 s) and the listener's idle timeout (+60 s).

## 9. Security notes

- **Security groups.** n8n's security groups reach the NLB on 3000; the NLB reaches the tasks on 3000; nothing else comes in (9464 only from `metrics_cidrs`, empty by default). The tasks go out only on 80/443 to `allowed_egress_cidrs`, 443 to `platform_egress_cidrs`, and DNS to the VPC resolver. The module README has the full table.
- **Security groups have no exceptions.** With `allowed_egress_cidrs = ["0.0.0.0/0"]` the browser can also reach this VPC's own services on 80 and 443, such as an internal load balancer in front of n8n. n8n's 5678, Redis and Postgres stay closed. Narrow the list to the sites your runs visit where you can.
- **Platform egress is shared.** Fargate gives a task one network interface, so the browser can use the 443 path you open for the registry, Secrets Manager and Logs. VPC endpoints keep that path inside AWS.
- **DNS can't be blocked by security groups.** Traffic to the Route 53 Resolver (VPC + 2) isn't filtered. To filter names, use Route 53 Resolver DNS Firewall.
- **Domain allowlists.** Security groups match addresses only. For names, put AWS Network Firewall in the path of the browser's subnets with a domain list rule group (it matches TLS SNI and HTTP Host), or another transparent filtering gateway. The gate doesn't pass proxy settings to the browser, and an explicit forward proxy would also blur the engine's address checks (repository README, "Address checks run in n8n").
- **Task metadata can't be blocked.** Fargate has no EC2 instance metadata service, but every task reaches the ECS task metadata endpoint at `169.254.170.2`, and security groups don't filter it. That covers the task metadata, the task role credentials and the agent endpoint the gate uses for protection. This is a residual risk:
  - The paths carry per-task IDs a page doesn't know, and the engine's private-network block refuses link-local addresses by default. Keep it on.
  - The worst case is bounded by the task role, which allows only `ecs:UpdateTaskProtection` on this cluster's tasks: a page that found the agent endpoint could hold scale-in protection and delay scale-in. It could not read the token, which reaches the gate through `secrets`; the run-server and browsers start without it.
  - IAM can scope that action to the cluster, not to one task. A tag condition (`aws:ResourceTag` on the service's propagated tags) could narrow it to this service's tasks; how that applies to the agent's calls isn't verified, so it is a follow-up.
- **The token on the task.** The gate and Chromium run as the same user (`pwuser`). A page that escaped Chromium and ran code as that user could read the token from the gate's `/proc/<pid>/environ`. With it, it could open sessions on this service, which only n8n's security groups reach. Rotate the token if you suspect a browser compromise.
- **Hardening:** all capabilities dropped, never privileged, non-root, no public IP, inline least-privilege IAM, a task role trust policy limited to ECS in this account and region (`aws:SourceAccount`, `aws:SourceArn`), and a read-only root filesystem as in the Kubernetes chart. `/tmp` is a task bind mount: the image declares `VOLUME ["/tmp"]` (root-owned 1777), and Fargate copies that path's owner and mode into the mount, so `pwuser` can write it. An image of your own needs the same; the module README explains it.
- **EC2 launch type.** On EC2 the task can reach the instance metadata service, and through it the instance role, unless the ECS agent runs with `ECS_AWSVPC_BLOCK_IMDS=true`. Set it, or stay on Fargate.

## 10. Drain and scaling

**Drain.** Fargate allows at most 120 s between SIGTERM and SIGKILL, less than a run, so three things work together:

1. **Task scale-in protection, the main guard.** The gate asks the ECS agent to protect its task while any session is open (for the drain time plus 5 minutes, renewed 5 minutes before it runs out) and clears it at zero. Scale-in and deployments skip protected tasks.
   - If the task stops while a protection request is still in flight, the final "off" can be lost. Protection then lingers until it expires, at most `max_run_seconds` + 5 minutes, and only delays scale-in of that task.
2. **Load balancer deregistration.** A stopping task is deregistered first and gets SIGTERM only after the deregistration delay (`max_run_seconds + 60`, at most 3600, by default). Live connections are never cut during the delay.
3. **The gate's own drain** on SIGTERM: it refuses new sessions (`503`, `X-RPA-Browser: draining`), turns `/healthz` to 503, and waits for open sessions within the 120 s.

**What it costs.** Each scale-in, and each deployment or rollback batch, takes about the deregistration delay extra, 11 minutes by default, even for idle tasks. Lower `deregistration_delay_seconds` for faster deployments; protection, not the delay, keeps busy tasks running.

**Scaling.** Each gate prints one CloudWatch EMF line a minute (namespace `RPA/Browser`, metrics `SessionsActive` and `SessionsCapacity`, dimension `ServiceName = <cluster>/<name>`). Target tracking holds `100 × active / capacity` at `target_utilization_percent` (70). Draining tasks report 0 and 0. When every task is draining, capacity is 0, the division drops the datapoint, and target tracking does nothing until a serving task reports. The scale-in cooldown is `max(300, deregistration delay + 180)`, 840 s by default; scale-out's is 60 s.

A deregistering task keeps reporting its capacity until SIGTERM, so utilisation reads low for that window. **Follow-up idea, unverified:** the gate could poll the task metadata endpoint (`${ECS_CONTAINER_METADATA_URI_V4}/task`) and start draining when `DesiredStatus` turns `STOPPED`, which would remove that window. It isn't checked that `DesiredStatus` changes when deregistration starts.

**Verify scaling after the first apply:**

1. **The metrics appear** within a few minutes of the first task starting: `aws cloudwatch list-metrics --namespace RPA/Browser` lists `SessionsActive` and `SessionsCapacity` with your `ServiceName`. If they don't, see the first item of the checklist.
2. **The policy and its alarms exist:**

   ```sh
   aws application-autoscaling describe-scaling-policies --service-namespace ecs \
     --resource-id service/<cluster>/rpa-browser
   aws cloudwatch describe-alarms --alarm-name-prefix "TargetTracking-service/<cluster>/rpa-browser" \
     --query 'MetricAlarms[].{name:AlarmName,state:StateValue}'
   ```

   Target tracking creates an `AlarmHigh` and an `AlarmLow`. Both leave `INSUFFICIENT_DATA` once the metrics flow.
3. **A load test with N held sessions scales out.** Run it from a host in one of `n8n_security_group_ids`, for example a temporary EC2 instance with that security group and an instance role that can read the token secret, with `npm install playwright-core@1.63.0` in a scratch directory. Hold `sessions_per_task × running tasks` sessions (100 % utilisation):

   ```sh
   cat > hold-sessions.js <<'EOF'
   // Opens N browser sessions, retrying while every session is busy, holds them HOLD seconds, then closes them.
   const { chromium } = require('playwright-core');
   const token = process.env.RPA_BROWSER_TOKEN;
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
   export RPA_BROWSER_TOKEN="$(aws secretsmanager get-secret-value --region <region> --secret-id '<token secret ARN>' \
     --query SecretString --output text)"
   N=8 HOLD=1200 ENDPOINT='ws://<internal NLB>:3000/' node hold-sessions.js
   unset RPA_BROWSER_TOKEN
   ```

   With 1 task of 4 sessions, N=8 holds 4 at once, then waits on `busy` until a second task is healthy, then opens the other 4. `AlarmHigh` goes to `ALARM` after a few one-minute datapoints above 70 % and the desired count rises: `aws ecs describe-services --cluster <cluster> --services rpa-browser --query 'services[0].desiredCount'`. While the sessions are open, `aws ecs get-task-protection --cluster <cluster> --tasks <task ID>` shows the busy tasks protected. After the script closes its sessions, scale-in waits for `AlarmLow` (about 15 minutes of low utilisation), then the cooldown, and each removed task then waits the deregistration delay.

## 11. First-apply checklist

These were checked against AWS and provider documentation and with mocked `terraform test` runs, but not against a real AWS account. Tick them on the first apply:

- [ ] **EMF is extracted from awslogs lines**: the `RPA/Browser` metrics appear (section 10, step 1). The gate's lines follow the EMF specification, and the awslogs driver needs no special format, but this hasn't run on AWS.
- [ ] **Target tracking does nothing on missing data**: with every task draining (or the metrics briefly absent), the desired count stays.
- [ ] **ECS honours the gate's protection during a deployment**: start a deployment while a session is open (`--force-new-deployment`); the protected task keeps running until the session ends, then stops.
- [ ] **The task role's `ecs:cluster` condition matches the agent's call**: with a session open, the gate's log shows no `AccessDeniedException`, and `aws ecs get-task-protection` reports the task protected.
- [ ] **`/tmp` is writable on the read-only root**: the connection check's screenshot works (Chromium can't start without a writable `/tmp`). Docker copies the image's `/tmp` owner and mode into the volume the same way (`images/browser/test/container.test.js` checks it); that Fargate does is from the AWS documentation, not run here.
- [ ] **The NLB's health checks reach the targets** through the NLB security group: targets turn `healthy`.
- [ ] **AWS accepts the `cpu`/`memory` pair** you chose (the module checks the documented pairs, not AWS itself).
- [ ] **Deployments take about the deregistration delay extra** per batch, and scale-in about that long per task.
- [ ] **The credential type is accepted by the public API**: `configure-n8n.mjs` creates the credential without a schema error.
- [ ] **A long quiet stretch in a run isn't cut**: the listener's TCP idle timeout is `max_run_seconds + 60`.

Settled while building, for reference:
- playwright-core's connect error carries the gate's `503` and `busy` or `draining`, so the engine's wait for a free session works on the error text alone.
- The supervisor never relies on how the run-server handles SIGTERM: it signals the gate first and stops the run-server last, killing it if needed.
- Provider facts the module relies on (`secret_string_wo` from AWS provider 5.88, the NLB listener's `tcp_idle_timeout_seconds`, metric math in target tracking, the open provider issue that keeps `secret_string_wo_version` a literal) are in the module README with their sources.

## Upgrades

- **Image.** Change `image` and apply. ECS starts new tasks before stopping old ones (100 % minimum healthy); old tasks with sessions stay protected. Keep the image's Playwright version equal to the node package's `playwright-core`: upgrade both together (repository README, "Version matching").
- **n8n.** Keep n8n at 2.41 or later.
