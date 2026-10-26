output "n8n_url" {
  description = "n8n's URL."
  value       = module.n8n.n8n_url
}

output "kubectl_config_command" {
  description = "Configures kubectl for the cluster."
  value       = module.n8n.kubectl_config_command
}

output "browser_endpoint" {
  description = "The browser service's in-cluster endpoint, for the RPA Browser credential (Browser Server mode)."
  value       = module.browser.browser_endpoint
}

output "browser_token_command" {
  description = "Reads the gate token from the cluster and exports it as RPA_BROWSER_TOKEN for configure-n8n.mjs, without putting it in your shell history. Terraform never has it."
  value       = "export RPA_BROWSER_TOKEN=\"$(kubectl -n ${kubernetes_namespace_v1.rpa_browser.metadata[0].name} get secret ${kubernetes_secret_v1.gate_token.metadata[0].name} -o jsonpath='{.data.token}' | base64 -d)\""
}

output "n8n_settings" {
  description = "What n8n needs: queue mode, the RPA Browser credential settings, the node package, and the remaining steps."
  value       = module.browser.n8n_settings
}

output "configure_command" {
  description = "Creates the RPA Browser credential and imports the templates (run from the repository root after exporting N8N_API_KEY and RPA_BROWSER_TOKEN; see browser_token_command)."
  value       = module.browser.configure_command
}
