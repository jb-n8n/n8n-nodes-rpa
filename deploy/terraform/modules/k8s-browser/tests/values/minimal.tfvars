# The required inputs only: the chart's defaults pick hpa-cpu, and the NetworkPolicy admits the n8n workers.
namespace         = "n8n"
token_secret_name = "rpa-browser-token"
image             = { repository = "ghcr.io/example/rpa-browser", tag = "1.63.0" }
n8n_pod_selector  = { "app.kubernetes.io/component" = "worker" }
