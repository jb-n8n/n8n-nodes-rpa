# n8n on EKS with n8n's own Terraform module (n8n-io/terraform-aws-n8n, registry address n8n-io/n8n/aws), plus the
# RPA browser service next to it (../../modules/k8s-browser). n8n runs in queue mode (the module always does) with a
# worker pool "rpa" for the projects that run RPA workflows; only that pool's workers may open browser sessions.
# Chromium never runs in an n8n pod. See README.md for the requirements (Enterprise feat:workerPools, the preview chart).
terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    # >= 3.2.1: kubernetes_secret_v1.data_wo (write-only since 2.36.0; 3.2.1 fixed "Missing Resource Identity After
    # Create" with it, GH-2859). n8n's module needs ~> 3.0.
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 3.2.1, < 4.0.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
    # >= 3.7.1: the ephemeral random_password.
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7.1, < 4.0.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# The kubernetes and helm providers talk to the cluster n8n's module creates, with short-lived tokens from the AWS CLI.
provider "kubernetes" {
  host                   = module.n8n.cluster_endpoint
  cluster_ca_certificate = base64decode(module.n8n.cluster_certificate_authority_data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.n8n.cluster_name, "--region", var.aws_region]
  }
}

provider "helm" {
  kubernetes = {
    host                   = module.n8n.cluster_endpoint
    cluster_ca_certificate = base64decode(module.n8n.cluster_certificate_authority_data)
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.n8n.cluster_name, "--region", var.aws_region]
    }
  }
}

locals {
  # Pod labels of the "rpa" pool's workers, from n8n's Helm chart 1.11.0-preview.workerpools.1 (release name "n8n",
  # fixed by n8n's module in n8n.tf): templates/_helpers.tpl n8n.podLabels sets app.kubernetes.io/name (the chart name,
  # n8n), app.kubernetes.io/instance (the release name) and app.kubernetes.io/component; templates/_worker.tpl sets the
  # component to "worker-group" for a queueMode.workerGroups entry and adds n8n.io/worker-pool = <poolName>.
  rpa_pool_selector = {
    "app.kubernetes.io/name"      = "n8n"
    "app.kubernetes.io/instance"  = "n8n"
    "app.kubernetes.io/component" = "worker-group"
    "n8n.io/worker-pool"          = local.rpa_pool_name
  }
  rpa_pool_name = "rpa"

  # EKS gives the service range 10.100.0.0/16 or 172.20.0.0/16 when none is set (n8n's module sets none); the VPC CNI
  # gives pods VPC addresses. Cutting all three out of the browser's egress keeps pages away from n8n, Redis, the
  # database and every in-cluster service.
  egress_except_cidrs = distinct([var.vpc_cidr_block, "10.100.0.0/16", "172.20.0.0/16"])
}

module "n8n" {
  source  = "n8n-io/n8n/aws"
  version = "0.5.0"

  aws_region      = var.aws_region
  cluster_name    = var.cluster_name
  n8n_domain      = var.n8n_domain
  route53_zone_id = var.route53_zone_id
  certificate_arn = var.certificate_arn
  vpc_id          = var.vpc_id
  private_subnets = var.private_subnet_ids
  public_subnets  = var.public_subnet_ids
  vpc_cidr_block  = var.vpc_cidr_block

  n8n_license_key = var.n8n_license_key
  n8n_image_tag   = var.n8n_image_tag

  # The browser pods share n8n's node group, and n8n's capacity check counts only n8n's own pods. See node_max.
  node_max = var.node_max

  # Worker pools need a chart that renders queueMode.workerGroups: no numbered chart release does yet, so this is
  # the official preview build (n8n's module accepts a prerelease version as that promise).
  n8n_chart_version = var.n8n_chart_version

  # EARLY ALPHA upstream (n8n's module and n8n itself). Assign the RPA projects to this pool in n8n: Project ->
  # Settings -> Worker Pools. Every worker gets the node package back after a restart through
  # n8n_reinstall_missing_packages.
  n8n_worker_pools = [{
    name         = local.rpa_pool_name
    min_replicas = var.rpa_pool_min_replicas
    max_replicas = var.rpa_pool_max_replicas
    concurrency  = var.rpa_pool_concurrency
    extra_env    = []
  }]

  # Community packages live on each pod's ephemeral disk; this reinstalls the RPA node on every pod that starts.
  n8n_reinstall_missing_packages = true

  # Every webhook pod runs the npm install at boot too. These are the minimums n8n's module checks for when
  # n8n_reinstall_missing_packages is on (check "webhook_resources_sized_for_reinstall_missing_packages" in
  # scaling.tf, from terraform-aws-n8n#52); its defaults (300m/800m CPU, 512Mi/1Gi memory) OOMKill and thrash.
  n8n_webhook_cpu_request    = "800m"
  n8n_webhook_cpu_limit      = "1500m"
  n8n_webhook_memory_request = "1Gi"
  n8n_webhook_memory_limit   = "2Gi"

  # Plain settings only: n8n_extra_env is stored in the Helm release and in Terraform state (variables.tf refuses
  # names that look like secrets).
  n8n_extra_env = concat(
    [{ name = "N8N_COMMUNITY_PACKAGES_ENABLED", value = "true" }],
    var.n8n_extra_env,
  )
}

# The VPC CNI's network policy agent. Without it EKS accepts the browser's NetworkPolicy and ignores it, and a page
# could reach Redis and the database. n8n's module leaves the CNI as EKS installed it; this adopts it as a managed add-on.
resource "aws_eks_addon" "vpc_cni" {
  count = var.manage_vpc_cni_network_policy ? 1 : 0

  cluster_name                = module.n8n.cluster_name
  addon_name                  = "vpc-cni"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"
  configuration_values        = jsonencode({ enableNetworkPolicy = "true" })
}

# The browser service gets a namespace of its own, away from n8n's Secrets.
resource "kubernetes_namespace_v1" "rpa_browser" {
  metadata {
    name = var.browser_namespace
  }

  depends_on = [module.n8n]
}

# The gate token: generated during plan and apply and written write-only, so it is never in the plan or the state.
# data_wo_revision is a literal; raise it to rotate the token, then restart the browser pods and update the credential.
ephemeral "random_password" "gate_token" {
  length  = 48
  special = false
}

resource "kubernetes_secret_v1" "gate_token" {
  metadata {
    name      = "rpa-browser-token"
    namespace = kubernetes_namespace_v1.rpa_browser.metadata[0].name
  }

  data_wo          = { token = ephemeral.random_password.gate_token.result }
  data_wo_revision = 1
}

module "browser" {
  source = "../../modules/k8s-browser"

  namespace         = kubernetes_namespace_v1.rpa_browser.metadata[0].name
  token_secret_name = kubernetes_secret_v1.gate_token.metadata[0].name
  image             = var.browser_image

  n8n_pod_selector       = var.n8n_pod_selector != null ? var.n8n_pod_selector : local.rpa_pool_selector
  n8n_namespace_selector = { "kubernetes.io/metadata.name" = module.n8n.namespace }

  allowed_egress_cidrs = var.browser_allowed_egress_cidrs
  egress_except_cidrs  = local.egress_except_cidrs

  # CPU scaling through the metrics-server n8n's module installs. With a Prometheus that scrapes port 9464, set
  # prometheus_server (and metrics_from) to scale on session use instead.
  autoscaling = {
    min = var.browser_min_replicas
    max = var.browser_max_replicas
  }

  n8n_url = module.n8n.n8n_url

  depends_on = [aws_eks_addon.vpc_cni]
}
