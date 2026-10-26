output "browser_endpoint" {
  description = "The browser service's endpoint, for the RPA Browser credential (Browser Server mode)."
  value       = module.rpa_browser.browser_endpoint
}

output "token_secret_arn" {
  description = "ARN of the Secrets Manager secret that holds the gate token (never the token itself)."
  value       = module.rpa_browser.token_secret_arn
}

output "load_balancer_security_group_id" {
  description = "The load balancer's security group. If the n8n tasks' egress is restricted, allow TCP 3000 to it."
  value       = module.rpa_browser.load_balancer_security_group_id
}

output "n8n_settings" {
  description = "What n8n needs: queue mode, the RPA Browser credential settings, the node package, and the remaining steps."
  value       = module.rpa_browser.n8n_settings
}

output "configure_command" {
  description = "Creates the RPA Browser credential and imports the templates (run from the repository root after exporting N8N_API_KEY and RPA_BROWSER_TOKEN; n8n_settings.notes shows how)."
  value       = module.rpa_browser.configure_command
}
