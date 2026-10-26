# Terraform 1.11 or later (the supported floor; this module itself needs cross-variable validation, 1.9+).
# Helm provider 3.x: written against the v3.3.0 docs
# (https://registry.terraform.io/providers/hashicorp/helm/3.3.0/docs/resources/release). The module passes values only
# through `values` (a list of YAML strings, unchanged in v3), never through `set`, whose syntax v3 changed from blocks
# to a list of objects. The caller configures the provider (v3: `kubernetes = { ... }` as an attribute).
terraform {
  required_version = ">= 1.11"

  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
  }
}
