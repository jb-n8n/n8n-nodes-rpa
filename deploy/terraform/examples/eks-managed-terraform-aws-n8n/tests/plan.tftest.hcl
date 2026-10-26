# A plan of the whole example (n8n's module at its pinned version and the browser module) against mocked AWS,
# Kubernetes, Helm and time providers. The random provider is real: mocks don't support the ephemeral password.
# terraform test fails a run on a failed check block, so this also proves that n8n's module's plan-time checks pass:
# webhook_resources_sized_for_reinstall_missing_packages (the webhook sizing) and
# autoscaling_maxima_fit_node_group_capacity (node_max).
mock_provider "aws" {}
mock_provider "kubernetes" {}
mock_provider "helm" {}
mock_provider "time" {}

variables {
  aws_region                   = "eu-west-1"
  n8n_domain                   = "n8n.example.com"
  route53_zone_id              = "Z0123456789ABCDEFGHIJ"
  vpc_id                       = "vpc-0123456789abcdef0"
  vpc_cidr_block               = "10.0.0.0/16"
  private_subnet_ids           = ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"]
  public_subnet_ids            = ["subnet-0bbbbbbbbbbbbbbb1", "subnet-0bbbbbbbbbbbbbbb2"]
  browser_image                = { repository = "ghcr.io/example/rpa-browser", tag = "1.63.0" }
  browser_allowed_egress_cidrs = ["0.0.0.0/0"]
  n8n_license_key              = "test-license-key"
}

run "plans_with_n8n_module_checks_passing" {
  command = plan

  assert {
    condition     = output.browser_endpoint == "ws://rpa-browser.rpa-browser.svc.cluster.local:3000/"
    error_message = "The browser endpoint is the Service in the example's own namespace."
  }
  assert {
    condition     = startswith(output.browser_token_command, "export RPA_BROWSER_TOKEN=")
    error_message = "browser_token_command must export the token, so the configure script (a child process) sees it."
  }
  assert {
    condition     = output.n8n_settings.rpa_browser_credential.mode == "playwright"
    error_message = "Browser Server mode is stored as playwright."
  }
}

run "refuses_a_secret_in_n8n_extra_env" {
  command = plan

  variables {
    n8n_extra_env = [{ name = "N8N_SMTP_PASS", value = "x" }]
  }

  expect_failures = [var.n8n_extra_env]
}
