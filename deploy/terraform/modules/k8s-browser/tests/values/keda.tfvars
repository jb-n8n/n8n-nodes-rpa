# KEDA on session utilisation with Amazon Managed Prometheus style authentication, n8n in another namespace, a
# PodMonitor, all of the internet on 80/443 minus the cluster ranges, Cilium FQDNs and custom resources.
namespace         = "automation"
release_name      = "browsers"
token_secret_name = "rpa-browser-token"
token_secret_key  = "gate-token"
image = {
  repository = "ghcr.io/example/rpa-browser"
  tag        = "1.63.0"
  digest     = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
sessions_per_replica = 6
drain_seconds        = 900
autoscaling = {
  min                       = 2
  max                       = 12
  target                    = 0.6
  prometheus_server         = "https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-example"
  authentication_ref        = { name = "keda-amp", kind = "ClusterTriggerAuthentication" }
  prometheus_extra_metadata = { awsRegion = "eu-west-1" }
}
n8n_pod_selector       = { "app.kubernetes.io/name" = "n8n", "app.kubernetes.io/component" = "worker" }
n8n_namespace_selector = { "kubernetes.io/metadata.name" = "n8n" }
metrics_from = [{
  namespace_selector = { "kubernetes.io/metadata.name" = "monitoring" }
  pod_selector       = { "app.kubernetes.io/name" = "prometheus" }
}]
pod_monitor_enabled  = true
pod_monitor_labels   = { release = "kube-prometheus-stack" }
allowed_egress_cidrs = ["0.0.0.0/0"]
egress_except_cidrs  = ["10.0.0.0/8", "172.16.0.0/12"]
egress_fqdns         = ["portal.example.com", "*.example.org"]
dns_ip_blocks        = ["169.254.20.10/32"]
resources = {
  requests = { cpu = "1", memory = "2Gi" }
  limits   = { memory = "2Gi" }
}
extra_values = ["nodeSelector:\n  kubernetes.io/arch: amd64\n"]
