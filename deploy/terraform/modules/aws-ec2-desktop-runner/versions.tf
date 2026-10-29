# Terraform 1.11 or later, the floor every root in deploy/ declares (CI runs 1.11.4 and a current release).
#
# AWS provider >= 6.0.0: data.aws_region's `region` attribute (6.0 deprecated `name`). Everything else is older:
# aws_vpc_security_group_ingress_rule / _egress_rule (v5.0.0), metadata_options.http_tokens, user_data_replace_on_change
# (v4.x). < 7.0.0: written and tested against the v6 schema; a new major can change any of them.
terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0.0, < 7.0.0"
    }
  }
}
