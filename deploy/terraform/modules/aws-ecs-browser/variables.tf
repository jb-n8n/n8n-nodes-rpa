# Inputs of the aws-ecs-browser module. The module never takes the gate token: it generates one into Secrets Manager
# through a write-only argument, or reads an existing secret by ARN, so the token stays out of state.

variable "name" {
  description = "Name of the ECS service and prefix of every resource (load balancer, target group, roles, log group, secret). At most 32 characters, the load balancer name limit."
  type        = string
  default     = "rpa-browser"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,30}[a-z0-9]$", var.name))
    error_message = "name must be 2 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen."
  }
}

variable "vpc_id" {
  description = "The VPC n8n runs in. The browser service, its load balancer and its security groups go here."
  type        = string

  validation {
    condition     = can(regex("^vpc-[0-9a-f]+$", var.vpc_id))
    error_message = "vpc_id must be a VPC ID (vpc-...)."
  }
}

variable "subnet_ids" {
  description = "Private subnets for the tasks and the internal load balancer, one per Availability Zone you want to use. They need a route to the image registry, Secrets Manager and CloudWatch Logs (a NAT gateway or VPC endpoints)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) > 0 && alltrue([for s in var.subnet_ids : can(regex("^subnet-[0-9a-f]+$", s))])
    error_message = "subnet_ids must list at least one subnet ID (subnet-...)."
  }
}

variable "cluster_arn" {
  description = "ARN of the existing ECS cluster to run the service in (arn:aws:ecs:<region>:<account>:cluster/<name>). The region and account of every other ARN come from it."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:cluster/[A-Za-z0-9_-]{1,255}$", var.cluster_arn))
    error_message = "cluster_arn must be an ECS cluster ARN, arn:aws:ecs:<region>:<account>:cluster/<name>."
  }
}

variable "n8n_security_group_ids" {
  description = "Security groups of the n8n tasks that open browser sessions (the workers in queue mode). Only they may reach the load balancer on 3000. If their egress is restricted, allow TCP 3000 to load_balancer_security_group_id."
  type        = list(string)

  validation {
    condition     = length(var.n8n_security_group_ids) > 0 && alltrue([for s in var.n8n_security_group_ids : can(regex("^sg-[0-9a-f]+$", s))])
    error_message = "n8n_security_group_ids must list at least one security group ID (sg-...)."
  }
}

variable "metrics_cidrs" {
  description = "CIDRs that may scrape the gate's Prometheus metrics on 9464 (optional; ECS scaling uses the EMF metrics in CloudWatch, not this port). Empty: nothing may."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.metrics_cidrs : can(cidrhost(c, 0))])
    error_message = "metrics_cidrs must be CIDRs, for example 10.0.0.0/24."
  }
}

variable "allowed_egress_cidrs" {
  description = "CIDRs the browser may reach on 80 and 443: the customer's portals, or 0.0.0.0/0. Security groups have no exceptions, so 0.0.0.0/0 includes the VPC's own services on 80/443. Empty: no site."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.allowed_egress_cidrs : can(cidrhost(c, 0))])
    error_message = "allowed_egress_cidrs must be CIDRs, for example 203.0.113.0/24."
  }
  validation {
    condition = alltrue([
      for c in var.allowed_egress_cidrs :
      !startswith(cidrhost(c, 0), "169.254.") && !startswith(lower(cidrhost(c, 0)), "fe80:") && !startswith(lower(cidrhost(c, 0)), "fd00:ec2:")
    ])
    error_message = "allowed_egress_cidrs must not list link-local or metadata ranges (169.254.0.0/16, fe80::/10, fd00:ec2::/32)."
  }
}

variable "platform_egress_cidrs" {
  description = "More CIDRs the task may reach on 443 for the platform: the image registry, Secrets Manager and CloudWatch Logs. On Fargate the task pulls its image, reads its secret and ships its logs through its own network interface, so this security group must allow them: list your VPC endpoint subnets here, or 0.0.0.0/0 for a NAT gateway, unless allowed_egress_cidrs already covers them. The browser can reach these too."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.platform_egress_cidrs : can(cidrhost(c, 0))])
    error_message = "platform_egress_cidrs must be CIDRs."
  }
}

variable "platform_egress_prefix_list_ids" {
  description = "Prefix lists the task may reach on 443, for example the S3 gateway endpoint's prefix list (ECR image layers come from S3)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for p in var.platform_egress_prefix_list_ids : can(regex("^pl-[0-9a-f]+$", p))])
    error_message = "platform_egress_prefix_list_ids must be prefix list IDs (pl-...)."
  }
}

variable "vpc_dns_cidrs" {
  description = "Where the browser sends DNS queries (TCP and UDP 53 to each). Null: the VPC's Route 53 Resolver, [\"<VPC CIDR base + 2>/32\"]. Set it for custom resolvers."
  type        = list(string)
  default     = null

  validation {
    condition     = var.vpc_dns_cidrs == null ? true : length(var.vpc_dns_cidrs) > 0 && alltrue([for c in var.vpc_dns_cidrs : can(cidrhost(c, 0))])
    error_message = "vpc_dns_cidrs must be null (the VPC resolver) or a non-empty list of CIDRs, for example [\"10.0.0.2/32\"]."
  }
}

variable "image" {
  description = "The rpa-browser image with a tag and/or a digest, for example ghcr.io/jb-n8n/rpa-browser:0.1.0."
  type        = string

  validation {
    condition = !can(regex("\\s", var.image)) && (
      can(regex("@sha256:[a-f0-9]{64}$", var.image)) ||
      can(regex(":[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", split("@", element(split("/", var.image), length(split("/", var.image)) - 1))[0]))
    )
    error_message = "image needs a tag (:0.1.0) or a digest (@sha256:<64 hex characters>)."
  }
}

variable "cpu" {
  description = "Task CPU units (2048 = 2 vCPU). Start at 2 vCPU for 4 sessions and measure."
  type        = number
  default     = 2048

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096, 8192, 16384], var.cpu)
    error_message = "cpu must be a Fargate CPU size: 256, 512, 1024, 2048, 4096, 8192 or 16384."
  }
}

variable "memory" {
  description = "Task memory in MiB. It must be a valid Fargate combination with cpu."
  type        = number
  default     = 4096

  validation {
    condition     = var.memory >= 512 && floor(var.memory) == var.memory
    error_message = "memory must be a whole number of MiB, at least 512."
  }
  # Fargate's task sizes (Amazon ECS task definition parameters, "Task size").
  validation {
    condition = var.launch_type != "FARGATE" || contains(lookup({
      "256"   = [512, 1024, 2048]
      "512"   = range(1024, 4097, 1024)
      "1024"  = range(2048, 8193, 1024)
      "2048"  = range(4096, 16385, 1024)
      "4096"  = range(8192, 30721, 1024)
      "8192"  = range(16384, 61441, 4096)
      "16384" = range(32768, 122881, 8192)
    }, tostring(var.cpu), []), var.memory)
    error_message = "On Fargate, memory must fit cpu: 256: 512, 1024 or 2048; 512: 1024-4096; 1024: 2048-8192; 2048: 4096-16384 (steps of 1024); 4096: 8192-30720 (1024); 8192: 16384-61440 (4096); 16384: 32768-122880 (8192)."
  }
}

variable "sessions_per_task" {
  description = "Browser sessions per task (1-64). The gate refuses the next one with 503 busy and the engine waits for a free session."
  type        = number
  default     = 4

  validation {
    condition     = var.sessions_per_task >= 1 && var.sessions_per_task <= 64 && floor(var.sessions_per_task) == var.sessions_per_task
    error_message = "sessions_per_task must be a whole number from 1 to 64."
  }
}

variable "min_tasks" {
  description = "Fewest tasks. Scaling never goes below it."
  type        = number
  default     = 1

  validation {
    condition     = var.min_tasks >= 1 && floor(var.min_tasks) == var.min_tasks
    error_message = "min_tasks must be a whole number of at least 1 (the scaling metric comes from running tasks)."
  }
}

variable "max_tasks" {
  description = "Most tasks."
  type        = number
  default     = 10

  validation {
    condition     = var.max_tasks >= var.min_tasks && floor(var.max_tasks) == var.max_tasks
    error_message = "max_tasks must be a whole number of at least min_tasks."
  }
}

variable "target_utilization_percent" {
  description = "Session utilisation target tracking holds: 100 * open sessions / session capacity, across tasks."
  type        = number
  default     = 70

  validation {
    condition     = var.target_utilization_percent >= 1 && var.target_utilization_percent <= 100
    error_message = "target_utilization_percent must be from 1 to 100."
  }
}

variable "max_run_seconds" {
  description = "The longest run. The gate drains this long, the load balancer drains a task for this plus 60 s (at most 3600), and the listener's idle timeout is this plus 60 s (60 to 6000)."
  type        = number
  default     = 600

  validation {
    condition     = var.max_run_seconds >= 1 && var.max_run_seconds <= 86400 && floor(var.max_run_seconds) == var.max_run_seconds
    error_message = "max_run_seconds must be a whole number from 1 to 86400 (the gate's drain limit)."
  }
}

variable "deregistration_delay_seconds" {
  description = "How long the load balancer drains a stopping task before ECS sends it SIGTERM (0-3600). Null: max_run_seconds + 60, at most 3600. Shorter scales in and deploys faster; task protection, not this delay, keeps busy tasks out of scale-in. The scale-in cooldown is max(300, this + 180)."
  type        = number
  default     = null

  validation {
    condition     = var.deregistration_delay_seconds == null ? true : var.deregistration_delay_seconds >= 0 && var.deregistration_delay_seconds <= 3600 && floor(var.deregistration_delay_seconds) == var.deregistration_delay_seconds
    error_message = "deregistration_delay_seconds must be null or a whole number from 0 to 3600."
  }
}

variable "existing_token_secret_arn" {
  description = "Full ARN (with its 6-character suffix) of an existing Secrets Manager secret whose whole SecretString is the gate token, 32 characters or more. Null: the module generates the token into a new secret."
  type        = string
  default     = null

  validation {
    condition     = var.existing_token_secret_arn == null || can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:.+-[A-Za-z0-9]{6}$", var.existing_token_secret_arn))
    error_message = "existing_token_secret_arn must be a full Secrets Manager secret ARN, ending in the 6-character suffix (...:secret:<name>-AbCdEf)."
  }
}

variable "token_kms_key_arn" {
  description = "ARN of the customer managed KMS key that encrypts the token secret, if any. The execution role gets kms:Decrypt on it. Null: the secret uses the aws/secretsmanager key, which needs no grant. Also used to encrypt the generated secret."
  type        = string
  default     = null

  validation {
    condition     = var.token_kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/.+$", var.token_kms_key_arn))
    error_message = "token_kms_key_arn must be a KMS key ARN (arn:aws:kms:<region>:<account>:key/<id>)."
  }
}

variable "launch_type" {
  description = "FARGATE (default) or EC2. On EC2 the browser shares the instance's network path to the instance metadata service unless the ECS agent runs with ECS_AWSVPC_BLOCK_IMDS=true; see the README."
  type        = string
  default     = "FARGATE"

  validation {
    condition     = contains(["FARGATE", "EC2"], var.launch_type)
    error_message = "launch_type must be FARGATE or EC2."
  }
}

variable "log_retention_days" {
  description = "Retention of the service's CloudWatch log group."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch Logs retention value (1, 3, 5, 7, 14, 30, 60, 90, ... 3653)."
  }
}

variable "tags" {
  description = "Tags for every resource the module creates."
  type        = map(string)
  default     = {}
}

variable "node_package_name" {
  description = "The RPA community node package n8n installs, for n8n_settings."
  type        = string
  default     = "n8n-nodes-rpa"
}

variable "n8n_url" {
  description = "n8n's base URL for configure_command. Null: a placeholder."
  type        = string
  default     = null

  validation {
    condition     = var.n8n_url == null || can(regex("^https?://[^\\s'\"]+$", var.n8n_url))
    error_message = "n8n_url must be an http(s) URL without spaces or quotes."
  }
}
