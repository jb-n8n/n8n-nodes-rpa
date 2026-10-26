# aws-ecs-browser

A Terraform module that attaches the RPA browser service to an existing n8n on Amazon ECS. It runs the `rpa-browser` image (Playwright's run-server behind the token gate) as an ECS service in an existing cluster, behind an internal Network Load Balancer, and scales it on session utilisation. Each task serves a fixed number of browser sessions, protects itself from scale-in while sessions are open, and drains when it stops.

n8n's workers connect to the service through the RPA Browser credential in Browser Server mode. Chromium never runs inside an n8n task.

## What it creates

- **Network:**
  - an internal NLB with a TCP listener on 3000 and an IP target group (health check `GET /healthz`)
  - two security groups, one for the NLB and one for the tasks (see [Security groups](#security-groups))
- **Token:** a Secrets Manager secret with a generated token, written write-only. Skipped when you pass `existing_token_secret_arn`.
- **Task:**
  - a CloudWatch log group
  - a Fargate task definition
  - an execution role and a task role, each with an inline policy only
- **Service and scaling:**
  - the ECS service: private subnets, no public IP, deployment circuit breaker with rollback
  - an Application Auto Scaling target and a target tracking policy on session utilisation

## Requirements

- Terraform 1.11 or later: write-only arguments need 1.11, ephemeral resources 1.10.
- AWS provider `>= 5.89.0, < 7.0.0` and random provider `>= 3.7.1, < 4.0.0`. See [Provider facts](#provider-facts) for why. You configure the AWS provider; the region comes from it and must match `cluster_arn`.
- An existing ECS cluster with Fargate available, n8n running in the same VPC, and private subnets.
- Outbound HTTPS from the private subnets to these, through a NAT gateway or VPC endpoints:
  - the image registry
  - Secrets Manager
  - CloudWatch Logs

  On Fargate the task does all three through its own network interface, so its security group must allow them too: see `platform_egress_cidrs`.
- The image: `ghcr.io/jb-n8n/rpa-browser:<version>` from `images/browser/`. Its run-server version must match the engine's playwright-core (repository README, "Version matching").

## The token

By default the module makes the token and n8n's credential reads it from the secret. Terraform never stores the token:

- `ephemeral "random_password"` generates 48 letters and digits during plan and apply, and is never written to the plan or state.
- `aws_secretsmanager_secret_version.secret_string_wo` is a write-only argument: the provider passes the value to AWS and keeps nothing.
- `secret_string_wo_version = 1` is a plain integer. The value is written once, when the version is created; the password generated on later runs is discarded.
  - To rotate, change it to `2` and apply, then restart the tasks and update n8n's credential.
  - It stays a literal on purpose: the provider refuses an ephemeral value there ([hashicorp/terraform-provider-aws#44590](https://github.com/hashicorp/terraform-provider-aws/issues/44590)).
- The ECS task gets the token through `secrets.valueFrom` at start. No output carries it; `token_secret_arn` is the ARN only.

For n8n's credential, export it in your shell straight from Secrets Manager. Never paste it into a file, a terminal transcript or Terraform:

```sh
export RPA_BROWSER_TOKEN="$(aws secretsmanager get-secret-value --region <region> \
  --secret-id "$(terraform output -raw token_secret_arn)" --query SecretString --output text)"
```

`n8n_settings.notes` carries the same line with the region and ARN filled in.

To bring your own token, create a secret whose whole `SecretString` is the token (32 characters or more). Pass its full ARN, including the 6-character suffix, as `existing_token_secret_arn`. If the secret uses a customer managed KMS key, pass that key as `token_kms_key_arn`, so the execution role may decrypt it. Don't read the secret with a `data "aws_secretsmanager_secret_version"`: that copies the token into state.

## Example

```hcl
provider "aws" {
  region = "eu-west-1"
}

module "rpa_browser" {
  source = "../../modules/aws-ecs-browser" # or git::https://github.com/jb-n8n/n8n-nodes-rpa.git//deploy/terraform/modules/aws-ecs-browser?ref=<tag>

  vpc_id      = "vpc-0123456789abcdef0"
  subnet_ids  = ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"]
  cluster_arn = "arn:aws:ecs:eu-west-1:123456789012:cluster/n8n"
  image       = "ghcr.io/jb-n8n/rpa-browser:0.1.0"

  # Only n8n's workers may open sessions.
  n8n_security_group_ids = ["sg-0123456789abcdef0"]

  # The sites the browser may open on 80/443.
  allowed_egress_cidrs = ["203.0.113.0/24"]
  # Image pull, the token secret and logs go out through a NAT gateway.
  platform_egress_cidrs = ["0.0.0.0/0"]
}

output "rpa_browser" {
  value = module.rpa_browser.n8n_settings
}
```

After `terraform apply`, export the n8n API key and the token in your shell, then run `terraform output -raw configure_command` (exported from your root module) from the repository root. It creates the RPA Browser credential and imports the templates through n8n's public API. The command reads both secrets from the environment and never carries them:

```sh
read -rs N8N_API_KEY && export N8N_API_KEY   # paste the key, then Enter; nothing is echoed
export RPA_BROWSER_TOKEN="$(aws secretsmanager get-secret-value --region <region> \
  --secret-id "$(terraform output -raw token_secret_arn)" --query SecretString --output text)"
node deploy/scripts/configure-n8n.mjs --n8n-url 'https://n8n.example.com' --endpoint '<browser_endpoint>'   # = configure_command
unset N8N_API_KEY RPA_BROWSER_TOKEN
```

Add `--project-id <id>` to create the credential and the workflows in that n8n project instead of your personal one.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `"rpa-browser"` | Service name and resource prefix, at most 32 characters. |
| `vpc_id` | `string` | required | n8n's VPC. |
| `subnet_ids` | `list(string)` | required | Private subnets for the tasks and the internal NLB. |
| `cluster_arn` | `string` | required | The existing ECS cluster. The region and account of every ARN come from it. |
| `n8n_security_group_ids` | `list(string)` | required | Security groups of the n8n tasks that open sessions. Only they reach the NLB on 3000. |
| `metrics_cidrs` | `list(string)` | `[]` | CIDRs that may scrape 9464. Scaling doesn't need it. |
| `allowed_egress_cidrs` | `list(string)` | `[]` | CIDRs the browser may reach on 80 and 443. Link-local and metadata ranges are refused. |
| `platform_egress_cidrs` | `list(string)` | `[]` | More CIDRs on 443 for the registry, Secrets Manager and CloudWatch Logs: VPC endpoint subnets, or `0.0.0.0/0` behind NAT. |
| `platform_egress_prefix_list_ids` | `list(string)` | `[]` | Prefix lists on 443, for example the S3 gateway endpoint's (ECR layers). |
| `vpc_dns_cidrs` | `list(string)` | `null` | DNS destinations on TCP/UDP 53. `null` means `["<VPC CIDR base + 2>/32"]`, the VPC resolver. Set it for custom resolvers; an empty list is refused. |
| `image` | `string` | required | The image with a tag and/or a digest. |
| `cpu` | `number` | `2048` | Task CPU units. |
| `memory` | `number` | `4096` | Task memory, MiB. On Fargate it must be a valid pair with `cpu` (256: 512/1024/2048; 512: 1024-4096; 1024: 2048-8192; 2048: 4096-16384; 4096: 8192-30720, steps of 1024; 8192: 16384-61440, steps of 4096; 16384: 32768-122880, steps of 8192). |
| `sessions_per_task` | `number` | `4` | Sessions per task, 1 to 64 (`BROWSER_GATE_MAX_SESSIONS`). |
| `min_tasks` | `number` | `1` | Fewest tasks (at least 1). |
| `max_tasks` | `number` | `10` | Most tasks. |
| `target_utilization_percent` | `number` | `70` | Session utilisation target tracking holds. |
| `max_run_seconds` | `number` | `600` | Longest run, 1 to 86400. It sets the gate's drain (`BROWSER_GATE_DRAIN_SECONDS`), the default deregistration delay (+60, at most 3600) and the listener idle timeout (+60, 60 to 6000). |
| `deregistration_delay_seconds` | `number` | `null` | The NLB's deregistration delay, 0 to 3600. `null` means `max_run_seconds + 60`, at most 3600. Shorter scales in and deploys faster: protection, not this delay, keeps busy tasks running. The scale-in cooldown is `max(300, delay + 180)`. |
| `existing_token_secret_arn` | `string` | `null` | Use this secret instead of generating one. |
| `token_kms_key_arn` | `string` | `null` | The token secret's customer managed KMS key, if any. It is also used for the generated secret. |
| `launch_type` | `string` | `"FARGATE"` | `FARGATE` or `EC2` (see Security notes). |
| `log_retention_days` | `number` | `30` | Log retention. |
| `tags` | `map(string)` | `{}` | Tags for every resource. |
| `node_package_name` | `string` | `"n8n-nodes-rpa"` | The RPA node package, for `n8n_settings`. |
| `n8n_url` | `string` | `null` | n8n's base URL for `configure_command`. If it is `null`, the command has a placeholder. |

## Outputs

| Name | Description |
|---|---|
| `browser_endpoint` | `ws://<nlb-dns>:3000/` |
| `token_secret_arn` | The token secret's ARN (never its value). |
| `security_group_id` | The tasks' security group. |
| `load_balancer_security_group_id` | The NLB's security group. Allow TCP 3000 to it if n8n's egress is restricted. |
| `n8n_settings` | `executions_mode = "queue"`; `rpa_browser_credential = { mode = "playwright", endpoint, token_secret = <secret ARN> }` (`playwright` is the stored value of Browser Server mode); `node_package`; `notes`. |
| `configure_command` | The `deploy/scripts/configure-n8n.mjs` invocation (`--n8n-url`, `--endpoint`). It reads `N8N_API_KEY` and `RPA_BROWSER_TOKEN` from the environment, so export them first; it never carries them, not even as placeholders. |

## How it works

### Security groups

n8n reaches the tasks through the NLB, and the target group uses IP targets with client IP preservation off (`preserve_client_ip = false`, the default for IP targets made explicit). So each task sees the NLB's private addresses as the source, for sessions and health checks alike, not n8n's. The rules follow from that:

| Security group | Direction | Port | Peer |
|---|---|---|---|
| NLB | in | TCP 3000 | each of `n8n_security_group_ids` |
| NLB | out | TCP 3000 | the task security group |
| tasks | in | TCP 3000 | the NLB security group |
| tasks | in | TCP 9464 | `metrics_cidrs` (none by default) |
| tasks | out | TCP 80, 443 | `allowed_egress_cidrs` |
| tasks | out | TCP 443 | `platform_egress_cidrs`, `platform_egress_prefix_list_ids` |
| tasks | out | TCP, UDP 53 | `vpc_dns_cidrs` (the VPC resolver by default) |

Terraform removes the default allow-all outbound rule from security groups it creates, so this table is everything. Port 9464 is never on the NLB.

### Drain

Fargate gives a container at most 120 s between SIGTERM and SIGKILL (`stopTimeout`), less than a run. Three things together keep open sessions alive:

1. **Task scale-in protection, the main guard.** With `BROWSER_GATE_ECS_PROTECTION=on`, the gate asks the ECS agent (`ECS_AGENT_URI`) to protect its task while any session is open, and clears it at zero. Scale-in and deployments skip protected tasks, so a busy task isn't picked at all. The task role allows only `ecs:UpdateTaskProtection`.
2. **Load balancer deregistration.** When ECS stops a task, it first deregisters the target. This happens in the task's DEACTIVATING state, before SIGTERM ([task lifecycle](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-lifecycle-explanation.html)). The NLB sends the task no new connections. With `connection_termination = false` it never cuts the open ones, so the delay doesn't end live sessions; it only postpones SIGTERM. The delay is `deregistration_delay_seconds`, by default `max_run_seconds + 60` (at most 3600). It covers a session that opened just before protection was set, or a task stopped for another reason.
3. **The gate's own drain.** On SIGTERM the gate refuses new sessions (503 `draining`, `/healthz` 503) and waits for the open ones up to `BROWSER_GATE_DRAIN_SECONDS`, within the 120 s stop timeout. `target_health_state.enable_unhealthy_connection_termination = false`, so a 503 health check never cuts a live session.

The listener's TCP idle timeout is `max_run_seconds + 60` (60 to 6000), so a quiet stretch in a run doesn't drop the connection.

**What the delay costs.** Every task that stops waits the full delay before SIGTERM, even an idle one. So each scale-in, and each deployment or rollback batch, takes about the delay extra: 11 minutes by default. Lower `deregistration_delay_seconds` if you want faster scale-in and deployments, and rely on protection for busy tasks.

### Scaling

The gate writes one CloudWatch EMF line a minute to stdout (`BROWSER_GATE_EMF=on`). The awslogs driver ships it, and CloudWatch Logs turns it into two metrics:

- namespace `RPA/Browser`, metrics `SessionsActive` and `SessionsCapacity`
- one dimension, `ServiceName = <cluster>/<name>` (`BROWSER_GATE_SERVICE_NAME`)

Target tracking holds `100 * active / capacity` at `target_utilization_percent`. Here `active` and `capacity` are those two metrics with the statistic `Sum`.

- **Why `Sum`, not `SUM()`.** Every task writes to the same series (the only dimension is the service), so `Sum` over the 1-minute period adds up every task's datapoints. The expression is then `100*SUM(active)/SUM(capacity)` across tasks. The metric math function `SUM()` would be wrong here: on a single series it returns one scalar for the whole query window ([metric math functions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/using-metric-math.html)).
- **Why the ratio holds.** Both values come from the same line. So if one task's line lands twice in a minute, or not at all, it moves both sums together and the ratio stays a true utilisation.
- **Deregistering tasks still count.** Until SIGTERM, which comes only after the deregistration delay, the gate doesn't know its task is leaving. Its `SessionsCapacity` still counts while it gets no new sessions. For that window utilisation reads low: a second scale-in could overshoot, and scale-out lags a little. So the scale-in cooldown is `max(300, deregistration delay + 180)`: 840 s by default. Scale-out isn't held by that cooldown; its own cooldown is 60 s.
- **Draining tasks**, after SIGTERM, report 0 and 0 and drop out of both sums.
- **When every task is draining**, capacity sums to 0. CloudWatch drops a datapoint that divides by zero, so target tracking sees missing data and does nothing until a serving task reports.

ECS only stops unprotected tasks, so scale-in waits for sessions to end.

## Security notes

- **Task metadata can't be blocked.** Fargate has no EC2 instance metadata service, but every task can reach the task metadata endpoint at `169.254.170.2`, and security groups don't filter that traffic. This covers the task metadata, credentials and agent (`ECS_AGENT_URI`) paths. A page opened by the browser could send requests there too. The paths carry per-task IDs that a page doesn't know, and the engine's private-network block refuses link-local addresses by default. The worst case is still bounded by the task role: a page that found the agent URI could hold scale-in protection on tasks of this cluster and delay scale-in. It could not read the token: the token reaches the gate through `secrets`, and the run-server and browser processes start without it. Keep the engine's private-network block on.
- **DNS to the VPC resolver can't be blocked.** Security groups don't filter DNS to the Route 53 Resolver (VPC + 2) ([security group rules](https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html)). The DNS rule is there for clarity and for custom resolvers (`vpc_dns_cidrs`). Use Route 53 Resolver DNS Firewall to filter names.
- **Security groups have no exceptions.** With `allowed_egress_cidrs = ["0.0.0.0/0"]`, the browser can also reach this VPC's own services on 80 and 443, such as an internal ALB in front of n8n. It still can't reach n8n's 5678, Redis 6379 or Postgres 5432, which aren't opened. Narrow the list to the customer's portals where you can. For domain allowlists, route egress through AWS Network Firewall or an egress proxy.
- **Platform egress is shared.** `platform_egress_cidrs` opens 443 for the registry, Secrets Manager and Logs, and the browser can use it too: Fargate has one network interface per task. VPC endpoints keep that path inside AWS.
- **The token stays out of Terraform.** See [The token](#the-token).
- **Hardening:**
  - all Linux capabilities dropped
  - never privileged
  - non-root user (the image's `pwuser`)
  - no public IP
  - least-privilege inline IAM policies: the execution role can read the token secret, write its log stream, and pull from ECR (only when the image is in ECR) and decrypt with `token_kms_key_arn` (only when set)
  - a task role trust policy with `aws:SourceAccount` and `aws:SourceArn`
  - a read-only root filesystem, as in the Helm chart (next item)
- **`initProcessEnabled` is left unset.** The image already runs `tini` as PID 1 (`ENTRYPOINT ["/usr/bin/tini", "--", ...]`), which reaps the browser's orphaned processes and forwards SIGTERM to the supervisor. ECS's init would put a second `tini` in front of it, adding a signal hop and a "not PID 1" warning.
- **Read-only root filesystem, `/tmp` on a bind mount.** `readonlyRootFilesystem` is on, and the task has a bind-mount volume `tmp` mounted at `/tmp`, on the task's ephemeral storage (20 GiB on Fargate by default) and removed with the task. Chromium writes profiles, downloads and shared-memory files there (Playwright starts it with `--disable-dev-shm-usage`); `XDG_CACHE_HOME` and `XDG_CONFIG_HOME` point under `/tmp`, as in the chart.
  - Fargate creates a bind mount owned by root with mode 0755, unless the image declares that path as a `VOLUME`: then it copies the image's contents there, and the owner and permissions the Dockerfile set ([bind mounts](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/bind-mounts.html)). The `rpa-browser` image declares `VOLUME ["/tmp"]`, root-owned 1777 like a normal `/tmp`, so `pwuser` can write it.
  - An image of your own needs the same `VOLUME` line and mode, or the browser can't start.
  - Checked with docker (`images/browser/test/container.test.js`: `--read-only` with a volume at `/tmp`, a screenshot through the gate); the Fargate copy itself is a first-apply check in the runbook.
- **EC2 launch type.** On EC2 the task can reach the instance metadata service, and through it the instance role, unless the ECS agent runs with `ECS_AWSVPC_BLOCK_IMDS=true`. Set it, or stay on Fargate.

## Provider facts

Each fact below was checked on 2026-10-22 against the provider changelogs, the provider docs and the AWS docs.

| Fact | Version | Source |
|---|---|---|
| `aws_secretsmanager_secret_version.secret_string_wo` and `secret_string_wo_version` added | AWS provider v5.88.0 (#41371) | [CHANGELOG v5](https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/CHANGELOG.md) (5.88.0, February 20, 2025); [v5.88.0 resource docs](https://github.com/hashicorp/terraform-provider-aws/blob/v5.88.0/website/docs/r/secretsmanager_secret_version.html.markdown) |
| `RequiredWith` between `secret_string_wo` and `secret_string_wo_version` | v5.89.0 (#41562), the module's floor | same changelog (5.89.0, February 27, 2025) |
| `secret_string_wo_version` refuses an ephemeral value, so the module uses the literal `1` | open issue | [#44590](https://github.com/hashicorp/terraform-provider-aws/issues/44590) |
| NLB listener TCP idle timeout: `aws_lb_listener.tcp_idle_timeout_seconds`, TCP listeners on an NLB (or a GWLB), 60 to 6000 s, default 350 | v5.73.0 (#39585) | [CHANGELOG v5](https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/CHANGELOG.md) (5.73.0); [lb_listener docs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lb_listener#tcp_idle_timeout_seconds-1) |
| Metric math in target tracking: `customized_metric_specification.metrics` (`id`, `expression`, `metric_stat`, `return_data`) | v4.66.0 (#30172) | [CHANGELOG v4](https://github.com/hashicorp/terraform-provider-aws/blob/v4.67.0/CHANGELOG.md) (4.66.0); [appautoscaling_policy docs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/appautoscaling_policy); [Application Auto Scaling metric math](https://docs.aws.amazon.com/autoscaling/application/userguide/application-auto-scaling-target-tracking-metric-math.html) |
| `target_health_state.enable_unhealthy_connection_termination` on NLB target groups | v5.x (#34070) | [lb_target_group docs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lb_target_group#target_health_state) |
| Security groups on Network Load Balancers (`aws_lb.security_groups` for `network`) | v5.x (#32987) | [lb docs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lb#security_groups-1) |
| `ephemeral "random_password"` | random v3.7.1 (#625). It is listed under 3.7.0 too, but the registry has no 3.7.0 release. | [random CHANGELOG](https://github.com/hashicorp/terraform-provider-random/blob/main/CHANGELOG.md); registry versions API |
| `ecs:UpdateTaskProtection` and `ecs:GetTaskProtection`: resource type `task`, condition keys include `ecs:cluster` | AWS | [Service Authorization Reference, Amazon ECS](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html) |
| Fargate `stopTimeout` at most 120 s; `privileged` not supported on Fargate | AWS | [ContainerDefinition](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html) |
| `capabilities` supported on Fargate (`add` only from platform 1.4.0); `sharedMemorySize` not supported on Fargate | AWS | [LinuxParameters](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_LinuxParameters.html) |
| Fargate 1.4.0 pulls images, reads secrets and ships logs through the task ENI | AWS | [Fargate task networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html) |
| Metric math: `SUM()` of one series is a scalar; a division by zero drops the datapoint | AWS | [Using metric math](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/using-metric-math.html) |
| Fargate task sizes: the CPU/memory pairs `memory` is validated against (32768 CPU isn't offered by the module) | AWS | [Fargate task CPU and memory](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html#fargate-tasks-size) |
| awslogs `mode = "non-blocking"` with `max-buffer-size` | AWS | [Route logs to CloudWatch (example)](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specify-log-config.html) |

`terraform validate` and `terraform test` pass on Terraform 1.11.4 with the providers at their floors (AWS 5.89.0, random 3.7.1), and on Terraform 1.11.4 and 1.15.5 with the locked versions (AWS 6.70.0, random 3.9.1).

### Unverified until the first apply

These go on the runbook's first-apply checklist:
- that CloudWatch Logs extracts the EMF lines shipped by the awslogs driver, so the `RPA/Browser` metrics appear
- that target tracking with missing data, when every task is draining, takes no action
- that ECS honours the task protection the gate sets during a deployment
- that the task role's `ecs:cluster` condition matches the agent's call: with a session open, the gate's log shows no `AccessDeniedException` and `aws ecs get-task-protection` reports the task protected
- that the NLB's health checks reach the IP targets through the NLB security group (targets turn healthy)
- that AWS accepts the chosen `cpu`/`memory` pair (the module checks the documented Fargate pairs, not AWS itself)
- that a deployment takes about the deregistration delay extra per batch, and scale-in about that long per task

**Follow-up idea, unverified:** the gate could poll the task metadata endpoint (`${ECS_CONTAINER_METADATA_URI_V4}/task`) and start draining when `DesiredStatus` turns `STOPPED`. It would then report 0 capacity during the deregistration delay instead of only after SIGTERM, which would remove the low-utilisation window above. It isn't checked that `DesiredStatus` changes when deregistration starts.

## Tests

`make -C deploy check` runs `terraform fmt`, `init -backend=false`, `validate` and `terraform test` here. `terraform test` runs plan-only against a mocked AWS provider and the real random provider. Overrides make IDs, ARNs and the NLB DNS name known at plan. It asserts:
- the security group rules: ingress, egress, DNS and metrics, plus a structural check that no other rule resources, inline rules or all-protocol rules exist
- the drain settings: deregistration delay (default, capped and set), connection termination, unhealthy-target termination, the health check, the idle timeout, `stopTimeout` and the gate's drain time
- the scaling policy: the expression, both metrics, their dimension and statistic, the target, and the scale-in cooldown formula
- the log driver's non-blocking mode and buffer size, and the Fargate CPU/memory pairs

The security group rules for `n8n_security_group_ids` and `platform_egress_prefix_list_ids` are keyed by position, so IDs created in the same root (unknown at plan) work. `terraform test` can't pass an unknown value between runs ("Reference to unknown value"), so this was checked in a scratch root instead: with an ID from a `terraform_data` resource, the plan succeeds, while `toset(...)` keys fail with "Invalid for_each argument".
- the token: a write-only version fed by the ephemeral password, `secrets.valueFrom`, no token in the environment, no output, variable or stored random resource that could hold it, and an existing secret skipping generation
- the IAM policies: the task role allows only `ecs:UpdateTaskProtection` on the cluster's tasks, and the execution role reads only the token secret
- the task's hardening and the input validations
