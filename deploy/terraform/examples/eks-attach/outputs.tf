output "browser_endpoint" {
  description = "The browser service's in-cluster endpoint, for the RPA Browser credential (Browser Server mode)."
  value       = module.rpa_browser.browser_endpoint
}

output "autoscaling_mode" {
  description = "How the browser service scales: hpa-cpu here (it needs metrics-server), or keda with a Prometheus."
  value       = module.rpa_browser.autoscaling_mode
}

output "n8n_settings" {
  description = "What n8n needs: queue mode, the RPA Browser credential settings, the node package, and the remaining steps."
  value       = module.rpa_browser.n8n_settings
}

output "configure_command" {
  description = "Creates the RPA Browser credential and imports the templates (run from the repository root after exporting N8N_API_KEY and RPA_BROWSER_TOKEN; n8n_settings.notes shows how)."
  value       = module.rpa_browser.configure_command
}
