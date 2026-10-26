# Inputs of the k8s-browser module. Each maps to a value of the rpa-browser chart (deploy/helm/rpa-browser/values.yaml).
# The module never takes the gate token: token_secret_name names an existing Secret, so the token stays out of state.

variable "namespace" {
  description = "Namespace to install the browser service into. It must exist and hold the token Secret."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$", var.namespace))
    error_message = "namespace must be a Kubernetes namespace name (DNS label)."
  }
}

variable "release_name" {
  description = "Helm release name. Every object, including the Service, is named after it, so the endpoint is ws://<release_name>.<namespace>.svc.cluster.local:3000/."
  type        = string
  default     = "rpa-browser"

  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{0,51}[a-z0-9])?$", var.release_name))
    error_message = "release_name must be a DNS label of at most 53 characters starting with a letter (Helm and Service naming rules)."
  }
}

variable "chart_path" {
  description = "Local path of the rpa-browser chart. Null: the chart in this repository (deploy/helm/rpa-browser). Ignored when chart_repository is set."
  type        = string
  default     = null
}

variable "chart_repository" {
  description = "Chart repository to install rpa-browser from instead of a local path, for example oci://<registry>/charts. Needs chart_version."
  type        = string
  default     = null
}

variable "chart_version" {
  description = "Exact chart version to install from chart_repository."
  type        = string
  default     = null

  validation {
    condition     = var.chart_repository == null || var.chart_version != null
    error_message = "chart_version is required with chart_repository (pin the chart)."
  }
}

variable "image" {
  description = "The rpa-browser image: repository plus a tag and/or a digest (sha256:...). With both, the image is repository:tag@digest."
  type = object({
    repository = string
    tag        = optional(string, "")
    digest     = optional(string, "")
  })

  validation {
    condition     = length(var.image.repository) > 0
    error_message = "image.repository is required, for example ghcr.io/jb-n8n/rpa-browser."
  }
  validation {
    condition     = length(var.image.tag) > 0 || length(var.image.digest) > 0
    error_message = "image needs a tag or a digest."
  }
  validation {
    condition     = var.image.digest == "" || can(regex("^sha256:[a-f0-9]{64}$", var.image.digest))
    error_message = "image.digest must look like sha256:<64 hex characters>."
  }
}

variable "token_secret_name" {
  description = "Name of an existing Secret in namespace that holds the gate token (32 characters or more). The module never creates or reads it."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$", var.token_secret_name))
    error_message = "token_secret_name must be the name of an existing Secret (DNS subdomain)."
  }
}

variable "token_secret_key" {
  description = "Key in the token Secret that holds the token."
  type        = string
  default     = "token"

  validation {
    condition     = can(regex("^[-._a-zA-Z0-9]+$", var.token_secret_key))
    error_message = "token_secret_key must be a Secret key name."
  }
}

variable "sessions_per_replica" {
  description = "Browser sessions per pod (1-64). The gate refuses the next one with 503 busy and the engine waits for a free session."
  type        = number
  default     = 4

  validation {
    condition     = var.sessions_per_replica >= 1 && var.sessions_per_replica <= 64 && floor(var.sessions_per_replica) == var.sessions_per_replica
    error_message = "sessions_per_replica must be a whole number from 1 to 64."
  }
}

variable "drain_seconds" {
  description = "Drain time on scale-in in seconds (1-86400), at least the longest run. terminationGracePeriodSeconds is this plus 30; whatever evicts or scales in the pod (for example cluster-autoscaler's --max-graceful-termination-sec) must allow that long."
  type        = number
  default     = 600

  validation {
    condition     = var.drain_seconds >= 1 && var.drain_seconds <= 86400 && floor(var.drain_seconds) == var.drain_seconds
    error_message = "drain_seconds must be a whole number from 1 to 86400 (the gate refuses 0)."
  }
}

variable "autoscaling" {
  description = <<-EOT
    How the browser service scales.
    mode: keda (session utilisation from Prometheus), hpa-cpu, none, or "" (keda when prometheus_server is set, else hpa-cpu).
    min / max: pod range; with mode none, min is the fixed pod count.
    target: session utilisation KEDA holds (0-1). cpu_target_percent: the hpa-cpu target.
    prometheus_server: the Prometheus KEDA queries. authentication_ref: a KEDA TriggerAuthentication or
    ClusterTriggerAuthentication ({name, kind}), for example for Amazon Managed Prometheus.
    prometheus_extra_metadata: more KEDA Prometheus scaler metadata, for example awsRegion.
  EOT
  type = object({
    mode               = optional(string, "")
    min                = optional(number, 1)
    max                = optional(number, 10)
    target             = optional(number, 0.7)
    cpu_target_percent = optional(number, 70)
    prometheus_server  = optional(string, "")
    authentication_ref = optional(object({
      name = string
      kind = optional(string, "TriggerAuthentication")
    }))
    prometheus_extra_metadata = optional(map(string), {})
  })
  default = {}

  validation {
    condition     = contains(["", "keda", "hpa-cpu", "none"], var.autoscaling.mode)
    error_message = "autoscaling.mode must be keda, hpa-cpu, none or empty."
  }
  validation {
    condition     = var.autoscaling.mode != "keda" || var.autoscaling.prometheus_server != ""
    error_message = "autoscaling.mode keda needs autoscaling.prometheus_server."
  }
  validation {
    condition = (
      floor(var.autoscaling.min) == var.autoscaling.min && floor(var.autoscaling.max) == var.autoscaling.max &&
      floor(var.autoscaling.cpu_target_percent) == var.autoscaling.cpu_target_percent
    )
    error_message = "autoscaling.min, autoscaling.max and autoscaling.cpu_target_percent must be whole numbers."
  }
  validation {
    condition     = var.autoscaling.min >= 1 && var.autoscaling.max >= var.autoscaling.min
    error_message = "autoscaling needs 1 <= min <= max."
  }
  validation {
    condition     = var.autoscaling.target > 0 && var.autoscaling.target <= 1
    error_message = "autoscaling.target is a utilisation between 0 (exclusive) and 1."
  }
  validation {
    condition     = var.autoscaling.cpu_target_percent >= 1 && var.autoscaling.cpu_target_percent <= 100
    error_message = "autoscaling.cpu_target_percent must be from 1 to 100."
  }
  validation {
    condition = (
      var.autoscaling.authentication_ref == null ? true :
      contains(["TriggerAuthentication", "ClusterTriggerAuthentication"], var.autoscaling.authentication_ref.kind)
    )
    error_message = "autoscaling.authentication_ref.kind must be TriggerAuthentication or ClusterTriggerAuthentication."
  }
}

variable "network_policy_enabled" {
  description = "Render the NetworkPolicy: ingress on 3000 only from the n8n pods, egress only to DNS and allowed_egress_cidrs. Needs a CNI that enforces NetworkPolicy."
  type        = bool
  default     = true
}

variable "n8n_pod_selector" {
  description = "matchLabels of the n8n pods that open browser sessions (the workers in queue mode). Required while network_policy_enabled."
  type        = map(string)
  default     = {}

  validation {
    condition     = !var.network_policy_enabled || length(var.n8n_pod_selector) > 0
    error_message = "n8n_pod_selector is required while network_policy_enabled (an empty selector would mean every pod)."
  }
}

variable "n8n_namespace_selector" {
  description = "matchLabels of n8n's namespace when it is not namespace, for example { \"kubernetes.io/metadata.name\" = \"n8n\" }. Empty: this namespace only."
  type        = map(string)
  default     = {}
}

variable "metrics_from" {
  description = "Pods that may scrape the metrics port 9464 (your Prometheus), as pod and/or namespace matchLabels. Empty: nothing may, so set it with KEDA or a PodMonitor."
  type = list(object({
    pod_selector       = optional(map(string))
    namespace_selector = optional(map(string))
  }))
  default = []

  validation {
    condition     = alltrue([for p in var.metrics_from : p.pod_selector != null || p.namespace_selector != null])
    error_message = "Each metrics_from entry needs a pod_selector or a namespace_selector."
  }
  validation {
    condition = (
      !var.network_policy_enabled || length(var.metrics_from) > 0 ||
      !(var.autoscaling.mode == "keda" || (var.autoscaling.mode == "" && var.autoscaling.prometheus_server != ""))
    )
    error_message = "KEDA scaling behind the NetworkPolicy needs metrics_from (your Prometheus pods): otherwise Prometheus can't scrape port 9464 and KEDA sees no sessions. The chart refuses it too."
  }
}

variable "pod_monitor_enabled" {
  description = "Create a Prometheus Operator PodMonitor for port 9464 that writes the labels the KEDA query selects."
  type        = bool
  default     = false
}

variable "pod_monitor_labels" {
  description = "Labels your Prometheus selects PodMonitors by, for example { release = \"kube-prometheus-stack\" }."
  type        = map(string)
  default     = {}
}

variable "allowed_egress_cidrs" {
  description = "CIDRs the browser may reach on 80 and 443 (the customer's portals, or 0.0.0.0/0). The metadata address is always cut out. Empty: no site."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.allowed_egress_cidrs : can(cidrhost(c, 0))])
    error_message = "allowed_egress_cidrs must be CIDRs, for example 203.0.113.0/24."
  }
}

variable "egress_except_cidrs" {
  description = "Ranges cut out of every allowed CIDR that contains them. List the VPC, pod and service ranges so a page can't reach n8n, Redis or the database through 0.0.0.0/0."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.egress_except_cidrs : can(cidrhost(c, 0))])
    error_message = "egress_except_cidrs must be CIDRs, for example 10.0.0.0/8."
  }
}

variable "egress_fqdns" {
  description = "Domain names the browser may reach on 80/443 (Cilium only: renders a CiliumNetworkPolicy). \"*.example.com\" patterns are allowed."
  type        = list(string)
  default     = []

  validation {
    # The chart's values.schema.json pattern: lower case, one leading "*." at most, never "*", "*.*" or "*.<tld>".
    condition     = alltrue([for d in var.egress_fqdns : can(regex("^(\\*\\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", d))])
    error_message = "egress_fqdns entries are lower-case domain names, optionally with one leading \"*.\" (never \"*\", \"*.*\" or \"*.<tld>\")."
  }
}

variable "dns_ip_blocks" {
  description = "More DNS servers by CIDR, allowed on port 53 next to kube-dns. With NodeLocal DNSCache, list 169.254.20.10/32 (the only address inside a metadata range the chart accepts, and only here)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.dns_ip_blocks : can(cidrhost(c, 0))])
    error_message = "dns_ip_blocks must be CIDRs, for example 169.254.20.10/32."
  }
}

variable "resources" {
  description = "Container resources for the browser pods. Null: the chart's defaults (requests 2 CPU / 4Gi, memory limit 4Gi). hpa-cpu needs requests.cpu."
  type        = any
  default     = null
}

variable "extra_values" {
  description = "More chart values as YAML maps, merged after the module's own (for example nodeSelector, tolerations or podDisruptionBudget). They may not set fullnameOverride, nameOverride, token, n8n, networkPolicy or egress: those are module inputs, and the endpoint output depends on the names."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for v in var.extra_values : can(keys(yamldecode(v)))])
    error_message = "Each extra_values entry must be a YAML map of chart values."
  }
  validation {
    condition = alltrue([
      for v in var.extra_values : length(setintersection(
        toset(try(keys(yamldecode(v)), [])),
        toset(["fullnameOverride", "nameOverride", "token", "n8n", "networkPolicy", "egress"]),
      )) == 0
    ])
    error_message = "extra_values may not set fullnameOverride, nameOverride, token, n8n, networkPolicy or egress: use the module's inputs (the endpoint output and the NetworkPolicy follow them)."
  }
}

variable "timeout_seconds" {
  description = "How long Helm waits for the rollout."
  type        = number
  default     = 600
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
