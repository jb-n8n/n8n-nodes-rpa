# ── n8n (passed to n8n's module; its variables.tf documents each one) ─────────

variable "aws_region" {
  description = "AWS region to deploy into, for example eu-west-1."
  type        = string
}

variable "cluster_name" {
  description = "Name of the EKS cluster n8n's module creates (14 characters or fewer: it derives the ElastiCache ID from it)."
  type        = string
  default     = "n8n-cluster"
}

variable "n8n_domain" {
  description = "n8n's domain name, for example n8n.example.com."
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 zone of the parent domain: n8n's module issues the certificate and the DNS record. Set this or certificate_arn."
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "ARN of an issued ACM certificate for n8n_domain, when the DNS is not in Route 53. Set this or route53_zone_id."
  type        = string
  default     = null
}

variable "vpc_id" {
  description = "VPC with public and private subnets in at least two Availability Zones, tagged for EKS and the load balancer controller."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets, one per Availability Zone: EKS nodes, the database, Redis and the browser pods."
  type        = list(string)
}

variable "public_subnet_ids" {
  description = "Public subnets, one per Availability Zone, for n8n's load balancer."
  type        = list(string)
}

variable "vpc_cidr_block" {
  description = "The VPC's CIDR block. It is also cut out of the browser's egress."
  type        = string
}

variable "n8n_license_key" {
  description = "n8n license activation key: Enterprise, with feat:workerPools for the pool (and feat:multipleMainInstances for n8n's default multi-main topology). n8n's module writes it into a Kubernetes Secret, so it is in Terraform state; n8n's module also takes n8n_license_key_secret_ref instead."
  type        = string
  sensitive   = true
}

variable "n8n_image_tag" {
  description = "n8n version to run: 2.41.0 or later (the RPA node's minimum; worker pools need 2.39 or later)."
  type        = string
  default     = "2.41.0"
}

variable "n8n_chart_version" {
  description = "n8n Helm chart version. Pools need a chart that renders queueMode.workerGroups; until a numbered release does, that is the official preview build."
  type        = string
  default     = "1.11.0-preview.workerpools.1"
}

variable "rpa_pool_min_replicas" {
  description = "Fewest workers in the rpa pool. Keep at least 1: n8n offers a pool for project assignment only while one of its workers runs."
  type        = number
  default     = 1
}

variable "rpa_pool_max_replicas" {
  description = "Most workers in the rpa pool. Pool workers times concurrency should not exceed the browser sessions (browser_max_replicas times 4)."
  type        = number
  default     = 3
}

variable "rpa_pool_concurrency" {
  description = "RPA executions each pool worker runs at once. Each open run holds one browser session."
  type        = number
  default     = 4
}

variable "node_max" {
  description = "Most nodes in the EKS node group (t3.xlarge by default, about 3.6 vCPU schedulable each). At their maxima, n8n's pods with the rpa pool and this example's webhook sizing request about 22.7 vCPU, and 10 browser pods 20 vCPU more (2 each), so 12 nodes. Lower it together with browser_max_replicas and the pool's maxima."
  type        = number
  default     = 12
}

variable "n8n_extra_env" {
  description = "More environment variables for every n8n pod. No secrets: they are stored in the Helm release and in Terraform state."
  type = list(object({
    name  = string
    value = string
  }))
  default = []

  validation {
    # A *_FILE name holds a path to a mounted Secret, not the secret.
    condition     = alltrue([for e in var.n8n_extra_env : endswith(e.name, "_FILE") || !can(regex("(?i)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|_PASS($|_)|CREDENTIAL)", e.name))])
    error_message = "n8n_extra_env must not carry secrets (a name with KEY, TOKEN, SECRET, PASSWORD, PASSWD, _PASS or CREDENTIAL, such as N8N_SMTP_PASS): they would be stored in plaintext in the Helm release and Terraform state. Use the *_FILE form with a mounted Secret, or n8n credentials."
  }
}

# ── The browser service ──────────────────────────────────────────────────────

variable "browser_image" {
  description = "The rpa-browser image: repository plus tag and/or digest, for example { repository = \"ghcr.io/jb-n8n/rpa-browser\", tag = \"<version>\" }. Its run-server must match the node's playwright-core (README, Version matching)."
  type = object({
    repository = string
    tag        = optional(string, "")
    digest     = optional(string, "")
  })
}

variable "browser_namespace" {
  description = "Namespace this example creates for the browser service."
  type        = string
  default     = "rpa-browser"
}

variable "browser_allowed_egress_cidrs" {
  description = "CIDRs the browser may reach on 80 and 443: your sites, or [\"0.0.0.0/0\"] for the whole internet (the VPC and the service range are always cut out)."
  type        = list(string)
}

variable "browser_min_replicas" {
  description = "Fewest browser pods."
  type        = number
  default     = 1
}

variable "browser_max_replicas" {
  description = "Most browser pods (4 sessions each)."
  type        = number
  default     = 10
}

variable "n8n_pod_selector" {
  description = "matchLabels of the n8n pods that may open browser sessions. Null: the rpa pool's workers only. { \"app.kubernetes.io/instance\" = \"n8n\" } admits every n8n pod, which the credential's Test button (it runs on main) and manual runs outside the pool need."
  type        = map(string)
  default     = null
}

variable "manage_vpc_cni_network_policy" {
  description = "Adopt the VPC CNI as a managed add-on with its network policy agent on, so the browser's NetworkPolicy is enforced. Set false if you already manage the vpc-cni add-on (then turn enableNetworkPolicy on yourself)."
  type        = bool
  default     = true
}
