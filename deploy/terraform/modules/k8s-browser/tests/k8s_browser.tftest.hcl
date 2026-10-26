# terraform test for the k8s-browser module: plan-only runs against a mocked Helm provider, so no cluster is needed.
# The module uses no other provider (it never reads the token Secret: a kubernetes_secret data source would copy the
# token into state), so only helm is mocked.
#
# Assertions read the release values by decoding helm_release.this.values[0], the YAML the module passes to the chart.
# The module builds that YAML with yamlencode, so plan knows it in full and the assertions can compare nested maps,
# lists and numbers with their real types. Helm provider 3 `set` entries would be a set of string name/value pairs,
# which mocks can plan too but which lose types and need escaping for selector keys with dots.

mock_provider "helm" {}

variables {
  namespace         = "automation"
  token_secret_name = "rpa-browser-token"
  image = {
    repository = "ghcr.io/example/rpa-browser"
    tag        = "1.63.0"
  }
  n8n_pod_selector = {
    "app.kubernetes.io/name"      = "n8n"
    "app.kubernetes.io/component" = "worker"
  }
  allowed_egress_cidrs = ["0.0.0.0/0"]
  egress_except_cidrs  = ["10.0.0.0/8", "172.16.0.0/12"]
}

run "renders_the_release_with_the_chart_values" {
  command = plan

  variables {
    sessions_per_replica = 6
    drain_seconds        = 900
    autoscaling = {
      mode              = "keda"
      min               = 2
      max               = 12
      target            = 0.6
      prometheus_server = "http://prometheus-operated.monitoring.svc:9090"
      authentication_ref = {
        name = "keda-amp"
        kind = "ClusterTriggerAuthentication"
      }
      prometheus_extra_metadata = { awsRegion = "eu-west-1" }
    }
    n8n_namespace_selector = { "kubernetes.io/metadata.name" = "n8n" }
    metrics_from = [{
      namespace_selector = { "kubernetes.io/metadata.name" = "monitoring" }
      pod_selector       = { "app.kubernetes.io/name" = "prometheus" }
    }]
    pod_monitor_enabled = true
    pod_monitor_labels  = { release = "kube-prometheus-stack" }
    egress_fqdns        = ["portal.example.com", "*.example.org"]
    dns_ip_blocks       = ["169.254.20.10/32"]
  }

  assert {
    condition     = helm_release.this.name == "rpa-browser" && helm_release.this.namespace == "automation"
    error_message = "The release is rpa-browser in the given namespace."
  }
  assert {
    condition     = yamldecode(helm_release.this.values[0]).sessionsPerReplica == 6
    error_message = "sessions_per_replica maps to sessionsPerReplica."
  }
  assert {
    condition     = yamldecode(helm_release.this.values[0]).drainSeconds == 900
    error_message = "drain_seconds maps to drainSeconds."
  }
  assert {
    condition = yamldecode(helm_release.this.values[0]).autoscaling == {
      mode              = "keda"
      min               = 2
      max               = 12
      targetUtilization = 0.6
      cpuTargetPercent  = 70
      prometheus = {
        serverAddress     = "http://prometheus-operated.monitoring.svc:9090"
        authenticationRef = { name = "keda-amp", kind = "ClusterTriggerAuthentication" }
        extraMetadata     = { awsRegion = "eu-west-1" }
      }
    }
    error_message = "The autoscaling object maps to the chart's autoscaling values, authenticationRef as {name, kind}."
  }
  assert {
    condition = yamldecode(helm_release.this.values[0]).n8n == {
      podSelector       = { "app.kubernetes.io/name" = "n8n", "app.kubernetes.io/component" = "worker" }
      namespaceSelector = { "kubernetes.io/metadata.name" = "n8n" }
    }
    error_message = "The n8n selectors map to n8n.podSelector and n8n.namespaceSelector."
  }
  assert {
    condition = yamldecode(helm_release.this.values[0]).metrics == {
      from = [{
        namespaceSelector = { matchLabels = { "kubernetes.io/metadata.name" = "monitoring" } }
        podSelector       = { matchLabels = { "app.kubernetes.io/name" = "prometheus" } }
      }]
      podMonitor = { enabled = true, labels = { release = "kube-prometheus-stack" } }
    }
    error_message = "metrics_from becomes NetworkPolicy peers with matchLabels; the PodMonitor settings pass through."
  }
  assert {
    condition = yamldecode(helm_release.this.values[0]).egress == {
      allowedCIDRs = ["0.0.0.0/0"]
      exceptCIDRs  = ["10.0.0.0/8", "172.16.0.0/12"]
      fqdns        = ["portal.example.com", "*.example.org"]
      dns          = { ipBlocks = ["169.254.20.10/32"] }
    }
    error_message = "The egress lists map to egress.allowedCIDRs, egress.exceptCIDRs, egress.fqdns and egress.dns.ipBlocks."
  }
  assert {
    condition = yamldecode(helm_release.this.values[0]).image == {
      repository = "ghcr.io/example/rpa-browser"
      tag        = "1.63.0"
      digest     = ""
    }
    error_message = "The image maps to image.repository, image.tag and image.digest."
  }
  assert {
    condition     = yamldecode(helm_release.this.values[0]).networkPolicy == { enabled = true }
    error_message = "The NetworkPolicy is on by default."
  }
}

run "every_value_name_exists_in_the_chart" {
  command = plan

  variables {
    autoscaling = {
      prometheus_server  = "http://prometheus:9090"
      authentication_ref = { name = "keda-amp" }
    }
    metrics_from = [{ pod_selector = { "app.kubernetes.io/name" = "prometheus" } }]
    resources    = { requests = { cpu = "1", memory = "2Gi" } }
  }

  # The chart's schema refuses unknown keys, so a misspelt value name fails at apply. This catches it at plan: every key
  # the module writes, two levels deep (three under autoscaling.prometheus), is a property in values.schema.json.
  # Deeper keys (egress.dns.ipBlocks, metrics.podMonitor.*) are covered by tests/chart.sh, whose helm template applies
  # the whole schema.
  assert {
    condition = alltrue(flatten([
      for k, v in yamldecode(helm_release.this.values[0]) : concat(
        [contains(keys(jsondecode(file("${helm_release.this.chart}/values.schema.json")).properties), k)],
        [
          for sk in(can(keys(v)) ? keys(v) : []) :
          can(jsondecode(file("${helm_release.this.chart}/values.schema.json")).properties[k].properties)
          ? contains(keys(jsondecode(file("${helm_release.this.chart}/values.schema.json")).properties[k].properties), sk)
          : true
        ]
      )
    ]))
    error_message = "A value name the module writes is not in the chart's values.schema.json."
  }
  assert {
    condition = alltrue([
      for k in keys(yamldecode(helm_release.this.values[0]).autoscaling.prometheus) :
      contains(keys(jsondecode(file("${helm_release.this.chart}/values.schema.json")).properties.autoscaling.properties.prometheus.properties), k)
    ])
    error_message = "An autoscaling.prometheus key the module writes is not in the chart's schema."
  }
  assert {
    condition = yamldecode(helm_release.this.values[0]).autoscaling.prometheus.authenticationRef == {
      name = "keda-amp"
      kind = "TriggerAuthentication"
    }
    error_message = "authentication_ref.kind defaults to TriggerAuthentication."
  }
  assert {
    condition     = yamldecode(helm_release.this.values[0]).resources == { requests = { cpu = "1", memory = "2Gi" } }
    error_message = "resources pass through to the chart."
  }
}

run "defaults_follow_the_plan" {
  command = plan

  assert {
    condition     = yamldecode(helm_release.this.values[0]).sessionsPerReplica == 4 && yamldecode(helm_release.this.values[0]).drainSeconds == 600
    error_message = "4 sessions per replica and 600 s of drain by default."
  }
  assert {
    condition = yamldecode(helm_release.this.values[0]).autoscaling == {
      mode              = ""
      min               = 1
      max               = 10
      targetUtilization = 0.7
      cpuTargetPercent  = 70
      prometheus        = { serverAddress = "", authenticationRef = {}, extraMetadata = {} }
    }
    error_message = "Autoscaling defaults: the chart picks the mode, 1-10 pods, utilisation 0.7."
  }
  assert {
    condition     = !contains(keys(yamldecode(helm_release.this.values[0])), "resources")
    error_message = "Without resources the chart's own defaults apply (hpa-cpu needs its CPU request)."
  }
  assert {
    condition     = endswith(helm_release.this.chart, "/helm/rpa-browser") && fileexists("${helm_release.this.chart}/Chart.yaml")
    error_message = "The chart defaults to the in-repo deploy/helm/rpa-browser."
  }
  assert {
    # version is provider-computed when unset, so plan can't compare it; the module passes null (see main.tf).
    condition     = helm_release.this.repository == null
    error_message = "The in-repo chart needs no repository."
  }
  assert {
    condition     = can(regex("^[0-9a-f]{40}$", yamldecode(helm_release.this.values[0]).global.rpaChartDigest))
    error_message = "A local chart puts its content digest in global.rpaChartDigest, so a chart change is a values change and deploys."
  }
  assert {
    condition     = helm_release.this.wait == true && helm_release.this.timeout == 600
    error_message = "The release waits for the rollout, 600 s by default."
  }
  assert {
    condition     = output.autoscaling_mode == "hpa-cpu"
    error_message = "Without a Prometheus address the chart scales on CPU."
  }
}

run "mode_none_runs_min_replicas" {
  command = plan

  variables {
    autoscaling            = { mode = "none", min = 3 }
    network_policy_enabled = false
    n8n_pod_selector       = {}
  }

  assert {
    condition     = yamldecode(helm_release.this.values[0]).replicas == 3 && yamldecode(helm_release.this.values[0]).autoscaling.mode == "none"
    error_message = "With mode none the chart runs autoscaling.min pods."
  }
  assert {
    condition     = yamldecode(helm_release.this.values[0]).networkPolicy == { enabled = false }
    error_message = "network_policy_enabled = false turns the NetworkPolicy off."
  }
}

run "a_chart_repository_replaces_the_path" {
  command = plan

  variables {
    chart_repository = "oci://ghcr.io/example/charts"
    chart_version    = "0.1.0"
    image = {
      repository = "ghcr.io/example/rpa-browser"
      digest     = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  }

  assert {
    condition     = helm_release.this.chart == "rpa-browser" && helm_release.this.repository == "oci://ghcr.io/example/charts" && helm_release.this.version == "0.1.0"
    error_message = "With chart_repository the release installs rpa-browser at chart_version from it."
  }
  assert {
    condition     = !contains(keys(yamldecode(helm_release.this.values[0])), "global")
    error_message = "A repository chart is pinned by chart_version, so no content digest is written."
  }
  assert {
    condition     = yamldecode(helm_release.this.values[0]).image.digest == "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" && yamldecode(helm_release.this.values[0]).image.tag == ""
    error_message = "A digest without a tag passes through."
  }
}

run "the_endpoint_output_uses_the_service_dns_name" {
  command = plan

  variables {
    release_name = "browsers"
  }

  assert {
    condition     = output.browser_endpoint == "ws://browsers.automation.svc.cluster.local:3000/"
    error_message = "The endpoint is the Service DNS name, ws://<release>.<namespace>.svc.cluster.local:3000/."
  }
  assert {
    condition = output.n8n_settings.rpa_browser_credential == {
      mode         = "playwright"
      endpoint     = "ws://browsers.automation.svc.cluster.local:3000/"
      token_secret = "automation/rpa-browser-token"
    }
    error_message = "The RPA Browser credential settings: Browser Server mode (stored value playwright), the endpoint, and the token's Secret reference."
  }
  assert {
    condition     = output.n8n_settings.executions_mode == "queue" && output.n8n_settings.node_package == "n8n-nodes-rpa"
    error_message = "n8n runs in queue mode with the n8n-nodes-rpa package."
  }
  assert {
    condition     = length(output.n8n_settings.notes) > 0
    error_message = "n8n_settings carries notes."
  }
  assert {
    condition     = output.configure_command == "node deploy/scripts/configure-n8n.mjs --n8n-url '<n8n URL>' --endpoint 'ws://browsers.automation.svc.cluster.local:3000/'"
    error_message = "configure_command runs configure-n8n.mjs with the endpoint."
  }
}

run "node_package_and_n8n_url_overrides" {
  command = plan

  variables {
    node_package_name = "@acme/n8n-nodes-rpa"
    n8n_url           = "https://n8n.example.com"
  }

  assert {
    condition     = output.n8n_settings.node_package == "@acme/n8n-nodes-rpa"
    error_message = "node_package_name overrides the package name."
  }
  assert {
    condition     = output.configure_command == "node deploy/scripts/configure-n8n.mjs --n8n-url 'https://n8n.example.com' --endpoint 'ws://rpa-browser.automation.svc.cluster.local:3000/'"
    error_message = "n8n_url goes into configure_command."
  }
}

run "no_output_contains_a_token_value" {
  command = plan

  # The module never takes the token, so there is no value to leak: these checks pin that shape.
  assert {
    condition     = yamldecode(helm_release.this.values[0]).token == { existingSecret = "rpa-browser-token", key = "token" }
    error_message = "The chart gets only the Secret's name and key, never a token."
  }
  assert {
    condition     = try(length(helm_release.this.set_sensitive), 0) == 0 && try(length(helm_release.this.set), 0) == 0
    error_message = "No set or set_sensitive entries: nothing outside the values YAML reaches the chart."
  }
  assert {
    condition     = output.n8n_settings.rpa_browser_credential.token_secret == "automation/rpa-browser-token"
    error_message = "The credential output names the Secret, never its content."
  }
  assert {
    # Both secrets are exported in the shell beforehand (the notes show how); the command never names them, not even as
    # placeholders to fill in, so neither value ever lands on a command line or in shell history.
    condition     = !strcontains(output.configure_command, "N8N_API_KEY") && !strcontains(output.configure_command, "RPA_BROWSER_TOKEN") && startswith(output.configure_command, "node deploy/scripts/configure-n8n.mjs ")
    error_message = "configure_command assumes N8N_API_KEY and RPA_BROWSER_TOKEN are exported and never inlines them."
  }
  assert {
    condition     = anytrue([for n in output.n8n_settings.notes : strcontains(n, "read -rs N8N_API_KEY && export N8N_API_KEY") && strcontains(n, "--project-id")])
    error_message = "The notes export the API key without echoing it and name the optional --project-id."
  }
  assert {
    condition = alltrue([
      for m in regexall("variable \"([a-z0-9_]+)\"", file("${path.module}/variables.tf")) :
      !can(regex("token|password|secret|api_key", m[0])) || contains(["token_secret_name", "token_secret_key"], m[0])
    ])
    error_message = "No variable may carry a token, password, secret or API key value; only token_secret_name and token_secret_key name the Secret."
  }
  assert {
    condition     = !can(regex("kubernetes_secret|random_password|random_string|ephemeral", file("${path.module}/main.tf")))
    error_message = "The module neither reads nor creates the token Secret."
  }
}

run "refuses_an_image_without_tag_or_digest" {
  command = plan
  variables {
    image = { repository = "ghcr.io/example/rpa-browser" }
  }
  expect_failures = [var.image]
}

run "refuses_an_empty_token_secret_name" {
  command = plan
  variables {
    token_secret_name = ""
  }
  expect_failures = [var.token_secret_name]
}

run "refuses_an_empty_n8n_selector_with_the_network_policy_on" {
  command = plan
  variables {
    n8n_pod_selector = {}
  }
  expect_failures = [var.n8n_pod_selector]
}

run "refuses_keda_without_a_prometheus_server" {
  command = plan
  variables {
    autoscaling = { mode = "keda" }
  }
  expect_failures = [var.autoscaling]
}

run "refuses_a_malformed_cidr" {
  command = plan
  variables {
    allowed_egress_cidrs = ["10.0.0.0/33"]
  }
  expect_failures = [var.allowed_egress_cidrs]
}

run "refuses_a_repository_without_a_chart_version" {
  command = plan
  variables {
    chart_repository = "oci://ghcr.io/example/charts"
  }
  expect_failures = [var.chart_version]
}

run "refuses_a_release_name_that_is_not_a_dns_label" {
  command = plan
  variables {
    release_name = "RPA_Browser"
  }
  expect_failures = [var.release_name]
}

run "refuses_a_zero_drain" {
  command = plan
  variables {
    drain_seconds = 0
  }
  expect_failures = [var.drain_seconds]
}

run "refuses_keda_without_metrics_peers_behind_the_network_policy" {
  command = plan
  variables {
    autoscaling = { prometheus_server = "http://prometheus:9090" }
  }
  expect_failures = [var.metrics_from]
}

run "keda_without_the_network_policy_needs_no_metrics_peers" {
  command = plan
  variables {
    autoscaling            = { prometheus_server = "http://prometheus:9090" }
    network_policy_enabled = false
  }
  assert {
    condition     = output.autoscaling_mode == "keda" && yamldecode(helm_release.this.values[0]).metrics.from == []
    error_message = "Without the NetworkPolicy, KEDA needs no metrics peers."
  }
}

run "refuses_min_above_max" {
  command = plan
  variables {
    autoscaling = { min = 5, max = 2 }
  }
  expect_failures = [var.autoscaling]
}

run "refuses_a_malformed_dns_ip_block" {
  command = plan
  variables {
    dns_ip_blocks = ["169.254.20.10"]
  }
  expect_failures = [var.dns_ip_blocks]
}

run "refuses_an_fqdn_the_chart_refuses" {
  command = plan
  variables {
    egress_fqdns = ["*.com"]
  }
  expect_failures = [var.egress_fqdns]
}

run "the_chart_digest_follows_the_chart_content" {
  command = plan
  variables {
    chart_path = "./tests/fixtures/chart-a"
  }
  assert {
    condition     = yamldecode(helm_release.this.values[0]).global.rpaChartDigest == sha1(join("\n", ["Chart.yaml:${filesha1("./tests/fixtures/chart-a/Chart.yaml")}", "templates/a.yaml:${filesha1("./tests/fixtures/chart-a/templates/a.yaml")}"]))
    error_message = "The digest covers every packaged file by name and content, and skips tests/ (the chart's .helmignore)."
  }
}

run "the_token_recipe_escapes_dots_in_the_key" {
  command = plan
  variables {
    token_secret_key = "gate.token"
  }
  assert {
    condition     = anytrue([for n in output.n8n_settings.notes : strcontains(n, "jsonpath='{.data.gate\\.token}'")])
    error_message = "kubectl's jsonpath needs the dots in the key escaped."
  }
  assert {
    condition     = anytrue([for n in output.n8n_settings.notes : strcontains(n, "export RPA_BROWSER_TOKEN=\"$(kubectl -n automation get secret rpa-browser-token")])
    error_message = "The notes export the token from the Secret instead of having it pasted."
  }
}

run "refuses_extra_values_that_override_module_inputs" {
  command = plan
  variables {
    extra_values = ["nodeSelector:\n  kubernetes.io/arch: amd64\n", "egress:\n  allowedCIDRs: [10.0.0.0/8]\n"]
  }
  expect_failures = [var.extra_values]
}

run "refuses_extra_values_that_rename_the_release" {
  command = plan
  variables {
    extra_values = ["fullnameOverride: other\n"]
  }
  expect_failures = [var.extra_values]
}

run "refuses_extra_values_that_are_not_a_map" {
  command = plan
  variables {
    extra_values = ["- a\n- b\n"]
  }
  expect_failures = [var.extra_values]
}

run "refuses_fractional_replica_counts" {
  command = plan
  variables {
    autoscaling = { min = 1.5 }
  }
  expect_failures = [var.autoscaling]
}

run "refuses_a_fractional_cpu_target" {
  command = plan
  variables {
    autoscaling = { cpu_target_percent = 70.5 }
  }
  expect_failures = [var.autoscaling]
}
