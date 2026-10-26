# Outputs of the k8s-browser module. None holds the token: the credential settings name the Secret, and
# configure_command reads the API key and the token from the environment (the notes show how to export them).

locals {
  browser_endpoint = "ws://${var.release_name}.${var.namespace}.svc.cluster.local:3000/"
  token_secret_ref = "${var.namespace}/${var.token_secret_name}"
  n8n_url          = coalesce(var.n8n_url, "<n8n URL>")
}

output "browser_endpoint" {
  description = "The browser service's in-cluster endpoint, for the RPA Browser credential (Browser Server mode)."
  value       = local.browser_endpoint
}

output "n8n_settings" {
  description = "What n8n needs: queue mode, the RPA Browser credential (mode, endpoint, token Secret reference), the node package, and notes."
  value = {
    executions_mode = "queue"
    rpa_browser_credential = {
      # The stored value of Browser Server mode in the RPA Browser credential.
      mode         = "playwright"
      endpoint     = local.browser_endpoint
      token_secret = local.token_secret_ref
    }
    node_package = var.node_package_name
    notes = compact([
      "Run n8n in queue mode (EXECUTIONS_MODE=queue) and install the community package ${var.node_package_name} on the main instance and the workers.",
      "RPA Browser credential: Browser Server mode, endpoint ${local.browser_endpoint}, token from the \"${var.token_secret_key}\" key of Secret ${local.token_secret_ref}.",
      "configure_command creates that credential and imports the templates through n8n's public API. It reads both secrets from the environment; export them rather than pasting them (shell history): export RPA_BROWSER_TOKEN=\"$(kubectl -n ${var.namespace} get secret ${var.token_secret_name} -o jsonpath='{.data.${replace(var.token_secret_key, ".", "\\.")}}' | base64 -d)\" and read -rs N8N_API_KEY && export N8N_API_KEY (paste the key, then Enter; nothing is echoed). Add --project-id <id> to create them in a project rather than your personal one. Never put the token in Terraform.",
      var.network_policy_enabled ? "The NetworkPolicy admits only pods matching n8n_pod_selector${length(var.n8n_namespace_selector) > 0 ? " in namespaces matching n8n_namespace_selector" : " in ${var.namespace}"}; it needs a CNI that enforces NetworkPolicy." : "",
      var.network_policy_enabled && length(var.allowed_egress_cidrs) == 0 && length(var.egress_fqdns) == 0 ? "allowed_egress_cidrs and egress_fqdns are empty, so the browser can reach no site." : "",
      var.network_policy_enabled && length(var.egress_except_cidrs) == 0 && length(var.allowed_egress_cidrs) > 0 ? "egress_except_cidrs is empty: list the VPC, pod and service ranges so a page can't reach in-cluster services on 80/443." : "",
      var.network_policy_enabled && length(var.metrics_from) == 0 && (local.autoscaling_mode == "keda" || var.pod_monitor_enabled) ? "metrics_from is empty, so Prometheus can't scrape port 9464 and KEDA sees no sessions." : "",
    ])
  }
}

output "configure_command" {
  description = "The configure-n8n.mjs invocation (run from the repository root) that creates the RPA Browser credential and imports the templates. Export N8N_API_KEY and RPA_BROWSER_TOKEN first (n8n_settings.notes); the command never carries them. Add --project-id <id> for a project."
  value       = "node deploy/scripts/configure-n8n.mjs --n8n-url '${local.n8n_url}' --endpoint '${local.browser_endpoint}'"
}

output "autoscaling_mode" {
  description = "The scaling mode the chart uses: keda, hpa-cpu or none."
  value       = local.autoscaling_mode
}
