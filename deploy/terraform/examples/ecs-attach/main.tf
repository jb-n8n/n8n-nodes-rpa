# Attaches the RPA browser service to an n8n that already runs on Amazon ECS (queue mode, in a VPC with private
# subnets). Fill in the variables (a terraform.tfvars file, or -var), then terraform init and apply. After the apply,
# run the configure_command output to create the RPA Browser credential and import the templates.
terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.89.0, < 7.0.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

module "rpa_browser" {
  source = "../../modules/aws-ecs-browser"

  vpc_id      = var.vpc_id
  subnet_ids  = var.private_subnet_ids
  cluster_arn = var.cluster_arn
  image       = var.image

  # Only these tasks reach the browser service's load balancer on port 3000.
  n8n_security_group_ids = var.n8n_security_group_ids

  allowed_egress_cidrs  = var.allowed_egress_cidrs
  platform_egress_cidrs = var.platform_egress_cidrs
  max_tasks             = var.max_tasks

  n8n_url = var.n8n_url
  tags    = var.tags
}
