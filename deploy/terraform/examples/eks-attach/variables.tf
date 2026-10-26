variable "aws_region" {
  description = "AWS region of the EKS cluster, for example eu-west-1."
  type        = string
}

variable "cluster_name" {
  description = "Name of the EKS cluster that runs n8n."
  type        = string
}

variable "namespace" {
  description = "Namespace for the browser service. It must exist and hold the token Secret. A namespace of its own keeps the browser away from n8n's Secrets."
  type        = string
  default     = "rpa-browser"
}

variable "n8n_namespace" {
  description = "Namespace n8n runs in."
  type        = string
  default     = "n8n"
}

variable "token_secret_name" {
  description = "Name of the existing Secret in namespace that holds the gate token under the key \"token\"."
  type        = string
  default     = "rpa-browser-token"
}

variable "image" {
  description = "The rpa-browser image: repository plus tag and/or digest. Its run-server must match the node's playwright-core (README, Version matching)."
  type = object({
    repository = string
    tag        = optional(string, "")
    digest     = optional(string, "")
  })
}

variable "n8n_pod_selector" {
  description = "matchLabels of the n8n pods that open browser sessions. The default matches the workers of n8n's Helm chart released as \"n8n\" (templates/_worker.tpl: app.kubernetes.io/component is worker, worker-group for worker pools). Use { \"app.kubernetes.io/instance\" = \"n8n\" } to admit every n8n pod, main included (the credential's Test button runs on main)."
  type        = map(string)
  default = {
    "app.kubernetes.io/name"      = "n8n"
    "app.kubernetes.io/instance"  = "n8n"
    "app.kubernetes.io/component" = "worker"
  }
}

variable "allowed_egress_cidrs" {
  description = "CIDRs the browser may reach on 80 and 443: your sites, or [\"0.0.0.0/0\"] for the whole internet."
  type        = list(string)
}

variable "vpc_cidrs" {
  description = "The VPC's CIDR blocks. They and the cluster's service range are cut out of allowed_egress_cidrs."
  type        = list(string)
}

variable "min_replicas" {
  description = "Fewest browser pods."
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "Most browser pods. With 4 sessions a pod, 10 pods serve 40 runs at a time."
  type        = number
  default     = 10
}

variable "n8n_url" {
  description = "n8n's base URL, for configure_command. Null: a placeholder."
  type        = string
  default     = null
}
