# A Windows Server 2022 test bed for the RPA desktop runner on EC2: a VM in a small VPC of its own, open only to the
# CIDRs you list, with the user rpa-runner signed in on the console and the runner started at its logon.
#
# deploy/scripts/desktop-testbed.sh drives this example (up, stop, start, status, fingerprint, rdp-password,
# install-runner, down) and keeps its state in a directory you choose outside the repository. By hand: terraform init
# -backend-config=path=<state dir>/terraform.tfstate, then terraform apply -var 'allowed_cidrs=["<your IP>/32"]'.
#
# Cost: while running, the instance (t3.large with the Windows licence) and its public IPv4 address; while stopped,
# only the 50 GiB gp3 volume and the three secrets. Stop it when idle, destroy it when done.
terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0.0, < 7.0.0"
    }
  }

  # Local state at a path given at init (-backend-config=path=...), so a test bed's state never lands in a checkout.
  backend "local" {}
}

provider "aws" {
  region = var.aws_region
}

module "desktop_runner" {
  source = "../../modules/aws-ec2-desktop-runner"

  name          = var.name
  allowed_cidrs = var.allowed_cidrs
  instance_type = var.instance_type
  elastic_ip    = var.elastic_ip

  runner_artifact_url    = var.runner_artifact_url
  runner_artifact_sha256 = var.runner_artifact_sha256
}
