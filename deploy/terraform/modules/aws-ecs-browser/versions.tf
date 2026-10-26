# Terraform 1.11 or later: write-only arguments (secret_string_wo) need 1.11, ephemeral resources 1.10, and the tests'
# override_during = plan needs 1.11.
#
# AWS provider >= 5.89.0: the newest feature this module needs is aws_secretsmanager_secret_version.secret_string_wo
# with secret_string_wo_version, added in v5.88.0 (#41371); v5.89.0 added the RequiredWith validation that pairs the
# two (#41562), so a missing version is refused at plan. Everything else is older: tcp_idle_timeout_seconds on
# aws_lb_listener (v5.73.0, #39585), target_health_state on aws_lb_target_group (#34070), security groups on Network
# Load Balancers, and metric math (`metrics`) in
# aws_appautoscaling_policy customized_metric_specification (v4.66.0, #30172). Sources and URLs: README.md.
# < 7.0.0: written and tested against the v5 and v6 schemas; a new major can change any of them.
#
# random >= 3.7.1: the ephemeral random_password (#625). The changelog lists it under v3.7.0 too, but the registry has
# no 3.7.0 release (3.7.0-alpha1, then 3.7.1).
terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.89.0, < 7.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7.1, < 4.0.0"
    }
  }
}
