# Outputs of the aws-ecs-browser module. None holds the token: the credential settings give the secret's ARN, and
# configure_command reads the API key and the token from the environment (the notes show how to export them).

locals {
  browser_endpoint = "ws://${aws_lb.this.dns_name}:3000/"
  n8n_url          = coalesce(var.n8n_url, "<n8n URL>")
  open_egress      = contains(var.allowed_egress_cidrs, "0.0.0.0/0") || contains(var.allowed_egress_cidrs, "::/0")
}

output "browser_endpoint" {
  description = "The browser service's endpoint (the internal NLB), for the RPA Browser credential (Browser Server mode)."
  value       = local.browser_endpoint
}

output "token_secret_arn" {
  description = "ARN of the Secrets Manager secret that holds the gate token. Read the value yourself for n8n's credential; Terraform never does."
  value       = local.token_secret_arn
}

output "security_group_id" {
  description = "The tasks' security group."
  value       = aws_security_group.task.id
}

output "load_balancer_security_group_id" {
  description = "The load balancer's security group. If the n8n tasks' egress is restricted, allow TCP 3000 to it."
  value       = aws_security_group.lb.id
}

output "n8n_settings" {
  description = "What n8n needs: queue mode, the RPA Browser credential (mode, endpoint, token secret ARN), the node package, and notes."
  value = {
    executions_mode = "queue"
    rpa_browser_credential = {
      # The stored value of Browser Server mode in the RPA Browser credential.
      mode         = "playwright"
      endpoint     = local.browser_endpoint
      token_secret = local.token_secret_arn
    }
    node_package = var.node_package_name
    notes = compact([
      "Run n8n in queue mode (EXECUTIONS_MODE=queue) and install the community package ${var.node_package_name} on the main instance and the workers.",
      "RPA Browser credential: Browser Server mode, endpoint ${local.browser_endpoint}, token from Secrets Manager. Export it in your shell, never paste it: export RPA_BROWSER_TOKEN=\"$(aws secretsmanager get-secret-value --region ${local.region} --secret-id '${local.token_secret_arn}' --query SecretString --output text)\"",
      "configure_command creates that credential and imports the templates through n8n's public API. It reads both secrets from the environment: export the token as above and the API key with read -rs N8N_API_KEY && export N8N_API_KEY (paste it, then Enter; nothing is echoed). Add --project-id <id> to create them in a project rather than your personal one. Never put the token in Terraform.",
      "Only the security groups in n8n_security_group_ids reach the browser service. If their egress is restricted, allow TCP 3000 to ${aws_security_group.lb.id}.",
      length(var.allowed_egress_cidrs) == 0 ? "allowed_egress_cidrs is empty, so the browser can reach no site." : "",
      length(var.allowed_egress_cidrs) == 0 && length(var.platform_egress_cidrs) == 0 && length(var.platform_egress_prefix_list_ids) == 0 ? "No egress on 443 at all: the task can't pull its image, read its secret or write logs. Set platform_egress_cidrs (VPC endpoint subnets, or 0.0.0.0/0 behind a NAT gateway)." : "",
      local.open_egress ? "allowed_egress_cidrs includes the whole internet, and security groups have no exceptions: pages can also reach this VPC's own services on 80 and 443. Keep the engine's private-network block on, or narrow the list." : "",
      var.launch_type == "EC2" ? "EC2 launch type: start the ECS agent with ECS_AWSVPC_BLOCK_IMDS=true, or pages can reach the instance metadata service and the instance role." : "",
    ])
  }
}

output "configure_command" {
  description = "The configure-n8n.mjs invocation (run from the repository root) that creates the RPA Browser credential and imports the templates. Export N8N_API_KEY and RPA_BROWSER_TOKEN first (n8n_settings.notes); the command never carries them. Add --project-id <id> for a project."
  value       = "node deploy/scripts/configure-n8n.mjs --n8n-url '${local.n8n_url}' --endpoint '${local.browser_endpoint}'"
}
