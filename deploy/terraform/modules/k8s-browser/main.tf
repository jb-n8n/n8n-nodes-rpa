# Installs the RPA browser service (the rpa-browser chart) next to an existing n8n on Kubernetes. One helm_release; the
# values go to the chart as one YAML document built with yamlencode, so they keep their types (numbers, maps, lists).
# The token never passes through here: the chart reads it from the existing Secret token_secret_name.

locals {
  # path.module, so the default works wherever the module is called from (a local path, git or registry source).
  local_chart_path = coalesce(var.chart_path, "${path.module}/../../../helm/rpa-browser")

  # A digest of the local chart's packaged files (names and contents; tests/ and the editor files in the chart's
  # .helmignore are skipped). helm_release only sees a chart change when its version or values change, so the digest
  # goes into the values: editing a template then shows up in plan and deploys. A repository chart is pinned by
  # chart_version instead.
  local_chart_files = var.chart_repository != null ? [] : sort([
    for f in fileset(local.local_chart_path, "**") : f
    if !startswith(f, "tests/") && !can(regex("(^|/)\\.DS_Store$|\\.(tmp|bak|orig)$|~$", f))
  ])
  local_chart_digest = sha1(join("\n", [for f in local.local_chart_files : "${f}:${filesha1("${local.local_chart_path}/${f}")}"]))

  # The mode the chart resolves an empty autoscaling.mode to (templates/_helpers.tpl, rpa-browser.autoscalingMode).
  autoscaling_mode = (
    var.autoscaling.mode != "" ? var.autoscaling.mode :
    var.autoscaling.prometheus_server != "" ? "keda" : "hpa-cpu"
  )

  chart_values = merge(
    {
      image = {
        repository = var.image.repository
        tag        = var.image.tag
        digest     = var.image.digest
      }
      sessionsPerReplica = var.sessions_per_replica
      drainSeconds       = var.drain_seconds
      # The chart reads replicas only with autoscaling.mode none: the fixed pod count is autoscaling.min.
      replicas = var.autoscaling.min
      autoscaling = {
        mode              = var.autoscaling.mode
        min               = var.autoscaling.min
        max               = var.autoscaling.max
        targetUtilization = var.autoscaling.target
        cpuTargetPercent  = var.autoscaling.cpu_target_percent
        prometheus = {
          serverAddress = var.autoscaling.prometheus_server
          authenticationRef = (
            var.autoscaling.authentication_ref == null ? tomap({}) :
            tomap({ name = var.autoscaling.authentication_ref.name, kind = var.autoscaling.authentication_ref.kind })
          )
          extraMetadata = var.autoscaling.prometheus_extra_metadata
        }
      }
      token = {
        existingSecret = var.token_secret_name
        key            = var.token_secret_key
      }
      n8n = {
        podSelector       = var.n8n_pod_selector
        namespaceSelector = var.n8n_namespace_selector
      }
      metrics = {
        from = [
          for peer in var.metrics_from : merge(
            peer.pod_selector == null ? {} : { podSelector = { matchLabels = peer.pod_selector } },
            peer.namespace_selector == null ? {} : { namespaceSelector = { matchLabels = peer.namespace_selector } },
          )
        ]
        podMonitor = {
          enabled = var.pod_monitor_enabled
          labels  = var.pod_monitor_labels
        }
      }
      networkPolicy = {
        enabled = var.network_policy_enabled
      }
      egress = {
        allowedCIDRs = var.allowed_egress_cidrs
        exceptCIDRs  = var.egress_except_cidrs
        fqdns        = var.egress_fqdns
        # Merged into the chart's egress.dns, so namespace and podSelector (kube-dns) keep their defaults.
        dns = {
          ipBlocks = var.dns_ip_blocks
        }
      }
    },
    var.resources == null ? {} : { resources = var.resources },
    var.chart_repository != null ? {} : { global = { rpaChartDigest = local.local_chart_digest } },
  )
}

resource "helm_release" "this" {
  name       = var.release_name
  namespace  = var.namespace
  chart      = var.chart_repository == null ? local.local_chart_path : "rpa-browser"
  repository = var.chart_repository
  version    = var.chart_repository == null ? null : var.chart_version

  values = concat([yamlencode(local.chart_values)], var.extra_values)

  wait    = true
  timeout = var.timeout_seconds

  lifecycle {
    precondition {
      condition     = var.chart_repository != null || fileexists("${local.local_chart_path}/Chart.yaml")
      error_message = "No chart at chart_path (${local.local_chart_path}): point chart_path at deploy/helm/rpa-browser or set chart_repository."
    }
  }
}
