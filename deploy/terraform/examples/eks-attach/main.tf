# Attaches the RPA browser service to an n8n that already runs on Amazon EKS in queue mode (for example one installed
# with n8n's Helm chart). Before the apply, create the namespace and the token Secret (see the k8s-browser README, "The
# token"); Terraform never sees the token. After the apply, run the configure_command output to create the RPA Browser
# credential and import the templates.
terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.89.0, < 7.0.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_eks_cluster" "this" {
  name = var.cluster_name
}

# Short-lived credentials from the AWS CLI at every plan and apply; nothing is stored.
provider "helm" {
  kubernetes = {
    host                   = data.aws_eks_cluster.this.endpoint
    cluster_ca_certificate = base64decode(data.aws_eks_cluster.this.certificate_authority[0].data)
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", var.cluster_name, "--region", var.aws_region]
    }
  }
}

module "rpa_browser" {
  source = "../../modules/k8s-browser"

  namespace         = var.namespace
  token_secret_name = var.token_secret_name
  image             = var.image

  # Only n8n's pods that match this open sessions (the NetworkPolicy needs the VPC CNI's network policy agent on).
  n8n_pod_selector       = var.n8n_pod_selector
  n8n_namespace_selector = var.n8n_namespace == var.namespace ? {} : { "kubernetes.io/metadata.name" = var.n8n_namespace }

  allowed_egress_cidrs = var.allowed_egress_cidrs
  # The VPC (node and pod addresses with the VPC CNI) and the cluster's service range, so a page can't reach in-cluster
  # services through 0.0.0.0/0.
  egress_except_cidrs = distinct(compact(concat(
    [data.aws_eks_cluster.this.kubernetes_network_config[0].service_ipv4_cidr],
    var.vpc_cidrs,
  )))

  autoscaling = {
    min = var.min_replicas
    max = var.max_replicas
  }

  n8n_url = var.n8n_url
}
