variable "aws_region" {
  description = "AWS region of the ECS cluster that runs n8n, for example eu-west-1."
  type        = string
}

variable "vpc_id" {
  description = "The VPC n8n runs in."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for the browser tasks and the internal load balancer, one per Availability Zone."
  type        = list(string)
}

variable "cluster_arn" {
  description = "ARN of the existing ECS cluster that runs n8n."
  type        = string
}

variable "n8n_security_group_ids" {
  description = "Security groups of the n8n tasks that open browser sessions: the workers in queue mode, and the main task too if you use the credential's Test button or run workflows manually on it."
  type        = list(string)
}

variable "image" {
  description = "The rpa-browser image with a tag and/or a digest, for example ghcr.io/jb-n8n/rpa-browser:<version>. Its run-server must match the node's playwright-core (README, Version matching)."
  type        = string
}

variable "allowed_egress_cidrs" {
  description = "CIDRs the browser may reach on 80 and 443: your sites, or [\"0.0.0.0/0\"] for the whole internet."
  type        = list(string)
}

variable "platform_egress_cidrs" {
  description = "Required, no default: CIDRs on 443 for the task's own traffic, the image pull, Secrets Manager and CloudWatch Logs. Through a NAT gateway that is [\"0.0.0.0/0\"]: pulling the image from GHCR (or any registry outside AWS) needs 443 to the internet. With VPC interface endpoints (and the image copied into ECR), list the endpoint subnets instead; ECR's layers come from S3, whose gateway endpoint needs the module's platform_egress_prefix_list_ids. This widens the browser's egress too (one network interface per task): 0.0.0.0/0 opens 443 to the whole internet whatever allowed_egress_cidrs says. [] only if allowed_egress_cidrs already covers these."
  type        = list(string)
}

variable "max_tasks" {
  description = "Most browser tasks. With 4 sessions a task, 10 tasks serve 40 runs at a time."
  type        = number
  default     = 10
}

variable "n8n_url" {
  description = "n8n's base URL, for configure_command. Null: a placeholder."
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags for every resource."
  type        = map(string)
  default     = {}
}
