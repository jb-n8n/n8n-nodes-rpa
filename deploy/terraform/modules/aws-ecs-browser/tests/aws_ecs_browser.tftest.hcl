# terraform test for the aws-ecs-browser module: plan-only runs against a mocked AWS provider, so no AWS account is
# needed. The random provider is the real one: its ephemeral random_password needs no credentials or network, and it
# is never stored, so plan can't show it anyway.
#
# override_during = plan makes the overridden computed values (security group IDs, the secret's ARN, the NLB's DNS
# name) known at plan, so the assertions can compare rules, policies and outputs with real strings. The VPC lookup is
# overridden with a CIDR, so the default DNS resolver address (VPC base + 2) is predictable.

mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_vpc.this
    values = {
      cidr_block = "10.20.0.0/16"
    }
  }
  override_resource {
    target = aws_security_group.lb
    values = {
      id = "sg-0aaaaaaaaaaaaaaaa"
    }
  }
  override_resource {
    target = aws_security_group.task
    values = {
      id = "sg-0bbbbbbbbbbbbbbbb"
    }
  }
  override_resource {
    target = aws_secretsmanager_secret.token
    values = {
      arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:rpa-browser-token-AbCdEf"
    }
  }
  override_resource {
    target = aws_lb.this
    values = {
      arn      = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/net/rpa-browser/0123456789abcdef"
      dns_name = "rpa-browser-0123456789.elb.eu-west-1.amazonaws.com"
    }
  }
  # The provider checks ARN-typed arguments at plan, so the ARNs other resources consume must look like ARNs.
  override_resource {
    target = aws_lb_target_group.this
    values = {
      arn = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/rpa-browser/0123456789abcdef"
    }
  }
  override_resource {
    target = aws_ecs_task_definition.this
    values = {
      arn = "arn:aws:ecs:eu-west-1:123456789012:task-definition/rpa-browser:1"
    }
  }
  override_resource {
    target = aws_iam_role.execution
    values = {
      arn = "arn:aws:iam::123456789012:role/rpa-browser-execution"
    }
  }
  override_resource {
    target = aws_iam_role.task
    values = {
      arn = "arn:aws:iam::123456789012:role/rpa-browser-task"
    }
  }
}

variables {
  vpc_id                 = "vpc-0123456789abcdef0"
  subnet_ids             = ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"]
  cluster_arn            = "arn:aws:ecs:eu-west-1:123456789012:cluster/automation"
  n8n_security_group_ids = ["sg-0111111111111111a", "sg-0222222222222222b"]
  allowed_egress_cidrs   = ["203.0.113.0/24", "198.51.100.10/32"]
  image                  = "ghcr.io/example/rpa-browser:1.63.0"
}

run "ingress_on_3000_only_from_the_n8n_security_groups" {
  command = plan

  variables {
    metrics_cidrs = ["10.20.30.0/24"]
  }

  # n8n reaches the tasks through the internal NLB. With IP targets and client IP preservation off, the tasks see the
  # NLB's own addresses, so: n8n SGs -> NLB SG on 3000, NLB SG -> task SG on 3000 (traffic and health checks).
  assert {
    condition     = { for k, r in aws_vpc_security_group_ingress_rule.lb_from_n8n : k => r.referenced_security_group_id } == { "0" = "sg-0111111111111111a", "1" = "sg-0222222222222222b" }
    error_message = "The NLB admits exactly the n8n security groups, keyed by position so IDs unknown at plan work."
  }
  assert {
    condition = alltrue([
      for r in aws_vpc_security_group_ingress_rule.lb_from_n8n :
      r.security_group_id == "sg-0aaaaaaaaaaaaaaaa" && r.from_port == 3000 && r.to_port == 3000 && r.ip_protocol == "tcp" && r.cidr_ipv4 == null && r.cidr_ipv6 == null
    ])
    error_message = "NLB ingress is TCP 3000 from a security group, never from a CIDR."
  }
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.task_from_lb.security_group_id == "sg-0bbbbbbbbbbbbbbbb" &&
      aws_vpc_security_group_ingress_rule.task_from_lb.referenced_security_group_id == "sg-0aaaaaaaaaaaaaaaa" &&
      aws_vpc_security_group_ingress_rule.task_from_lb.from_port == 3000 && aws_vpc_security_group_ingress_rule.task_from_lb.to_port == 3000 &&
      aws_vpc_security_group_ingress_rule.task_from_lb.ip_protocol == "tcp"
    )
    error_message = "The tasks admit 3000 only from the NLB's security group."
  }
  assert {
    condition = (
      aws_vpc_security_group_egress_rule.lb_to_task.security_group_id == "sg-0aaaaaaaaaaaaaaaa" &&
      aws_vpc_security_group_egress_rule.lb_to_task.referenced_security_group_id == "sg-0bbbbbbbbbbbbbbbb" &&
      aws_vpc_security_group_egress_rule.lb_to_task.from_port == 3000 && aws_vpc_security_group_egress_rule.lb_to_task.to_port == 3000
    )
    error_message = "The NLB may only send to the tasks on 3000."
  }
  assert {
    condition = (
      toset([for r in aws_vpc_security_group_ingress_rule.task_metrics : r.cidr_ipv4]) == toset(["10.20.30.0/24"]) &&
      alltrue([for r in aws_vpc_security_group_ingress_rule.task_metrics : r.from_port == 9464 && r.to_port == 9464 && r.security_group_id == "sg-0bbbbbbbbbbbbbbbb"])
    )
    error_message = "9464 is open only to metrics_cidrs."
  }
  assert {
    condition     = aws_lb.this.internal == true && aws_lb.this.load_balancer_type == "network" && toset(aws_lb.this.security_groups) == toset(["sg-0aaaaaaaaaaaaaaaa"])
    error_message = "The NLB is internal and carries its own security group."
  }
  assert {
    condition     = aws_lb_target_group.this.target_type == "ip" && aws_lb_target_group.this.preserve_client_ip == "false" && aws_lb_target_group.this.port == 3000
    error_message = "IP targets on 3000 with client IP preservation off (the task SG then sees the NLB's addresses)."
  }
  assert {
    condition     = aws_ecs_service.this.network_configuration[0].assign_public_ip == false && toset(aws_ecs_service.this.network_configuration[0].security_groups) == toset(["sg-0bbbbbbbbbbbbbbbb"])
    error_message = "Tasks get no public IP and only the module's security group."
  }
  assert {
    # A structural guard: the only ingress rules the module can create are these three resources.
    condition     = toset([for m in regexall("resource \"aws_vpc_security_group_ingress_rule\" \"([a-z0-9_]+)\"", file("${path.module}/network.tf")) : m[0]]) == toset(["lb_from_n8n", "task_from_lb", "task_metrics"])
    error_message = "network.tf may declare only the three ingress rule resources."
  }
}

run "no_metrics_cidrs_means_no_metrics_ingress" {
  command = plan

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.task_metrics) == 0
    error_message = "Without metrics_cidrs nothing reaches 9464."
  }
}

run "egress_only_to_the_allowed_cidrs_and_dns" {
  command = plan

  assert {
    condition     = toset(keys(aws_vpc_security_group_egress_rule.task_web)) == toset(["203.0.113.0/24 tcp 443", "203.0.113.0/24 tcp 80", "198.51.100.10/32 tcp 443", "198.51.100.10/32 tcp 80"])
    error_message = "Web egress is 80 and 443 to each allowed CIDR, nothing more."
  }
  assert {
    condition     = alltrue([for k, r in aws_vpc_security_group_egress_rule.task_web : r.security_group_id == "sg-0bbbbbbbbbbbbbbbb" && r.from_port == r.to_port && contains([80, 443], r.from_port) && r.ip_protocol == "tcp"])
    error_message = "Web egress rules are single TCP ports 80 or 443 on the task SG."
  }
  assert {
    condition = (
      toset(keys(aws_vpc_security_group_egress_rule.task_dns)) == toset(["10.20.0.2/32 tcp", "10.20.0.2/32 udp"]) &&
      alltrue([for k, r in aws_vpc_security_group_egress_rule.task_dns : r.cidr_ipv4 == "10.20.0.2/32" && r.from_port == 53 && r.to_port == 53 && endswith(k, " ${r.ip_protocol}")])
    )
    error_message = "DNS goes to the VPC resolver (VPC base + 2) on TCP and UDP 53."
  }
  assert {
    condition     = length(aws_vpc_security_group_egress_rule.task_platform) == 0 && length(aws_vpc_security_group_egress_rule.task_platform_prefix_list) == 0
    error_message = "No platform egress unless asked for."
  }
  assert {
    condition     = toset([for m in regexall("resource \"aws_vpc_security_group_egress_rule\" \"([a-z0-9_]+)\"", file("${path.module}/network.tf")) : m[0]]) == toset(["lb_to_task", "task_web", "task_platform", "task_platform_prefix_list", "task_dns"])
    error_message = "network.tf may declare only these egress rule resources."
  }
  assert {
    condition     = !can(regex("aws_security_group_rule|egress\\s*\\{|ingress\\s*\\{|ip_protocol\\s*=\\s*\"-1\"", join("\n", [for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")])))
    error_message = "No inline or legacy security group rules and no all-protocol rule anywhere."
  }
}

run "dns_resolver_and_platform_egress_can_be_set" {
  command = plan

  variables {
    vpc_dns_cidrs                   = ["10.20.5.10/32", "10.20.6.10/32"]
    platform_egress_cidrs           = ["10.20.100.0/24"]
    platform_egress_prefix_list_ids = ["pl-6da54004"]
    allowed_egress_cidrs            = ["2001:db8::/32"]
  }

  assert {
    condition     = toset([for r in aws_vpc_security_group_egress_rule.task_dns : "${r.cidr_ipv4} ${r.ip_protocol}"]) == toset(["10.20.5.10/32 tcp", "10.20.5.10/32 udp", "10.20.6.10/32 tcp", "10.20.6.10/32 udp"])
    error_message = "vpc_dns_cidrs replace the default resolver address, TCP and UDP 53 to each."
  }
  assert {
    condition     = toset([for r in aws_vpc_security_group_egress_rule.task_platform : "${r.cidr_ipv4} ${r.from_port}"]) == toset(["10.20.100.0/24 443"])
    error_message = "platform_egress_cidrs open 443 only."
  }
  assert {
    condition     = { for k, r in aws_vpc_security_group_egress_rule.task_platform_prefix_list : k => "${r.prefix_list_id} ${r.from_port}" } == { "0" = "pl-6da54004 443" }
    error_message = "platform_egress_prefix_list_ids open 443 only."
  }
  assert {
    condition     = alltrue([for r in aws_vpc_security_group_egress_rule.task_web : r.cidr_ipv6 == "2001:db8::/32" && r.cidr_ipv4 == null])
    error_message = "An IPv6 CIDR becomes an IPv6 rule."
  }
}

run "deregistration_delay_covers_the_run_time_and_live_connections_are_kept" {
  command = plan

  assert {
    condition     = tonumber(aws_lb_target_group.this.deregistration_delay) == 660
    error_message = "Deregistration delay is max_run_seconds + 60."
  }
  assert {
    condition     = aws_appautoscaling_policy.sessions.target_tracking_scaling_policy_configuration[0].scale_in_cooldown == 840
    error_message = "Scale-in cooldown is max(300, deregistration delay + 180): deregistering tasks still report capacity until SIGTERM."
  }
  assert {
    condition     = aws_lb_target_group.this.connection_termination == false
    error_message = "Connections are not cut at the end of deregistration."
  }
  assert {
    condition     = aws_lb_target_group.this.target_health_state[0].enable_unhealthy_connection_termination == false
    error_message = "A draining task answers /healthz with 503; its open sessions must survive that."
  }
  assert {
    condition = (
      aws_lb_target_group.this.health_check[0].protocol == "HTTP" && aws_lb_target_group.this.health_check[0].path == "/healthz" &&
      aws_lb_target_group.this.health_check[0].port == "traffic-port" && aws_lb_target_group.this.health_check[0].matcher == "200"
    )
    error_message = "Health check: HTTP GET /healthz on 3000, healthy only on 200."
  }
  assert {
    condition     = aws_lb_listener.this.port == 3000 && aws_lb_listener.this.protocol == "TCP" && aws_lb_listener.this.tcp_idle_timeout_seconds == 660
    error_message = "TCP listener on 3000 whose idle timeout outlasts a run."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].stopTimeout == 120
    error_message = "stopTimeout is Fargate's maximum, 120 s."
  }
  assert {
    condition     = contains(jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment, { name = "BROWSER_GATE_DRAIN_SECONDS", value = "600" })
    error_message = "The gate drains for max_run_seconds."
  }
  assert {
    condition     = contains(jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment, { name = "BROWSER_GATE_ECS_PROTECTION", value = "on" })
    error_message = "The gate protects its task while sessions are open."
  }
}

run "long_runs_hit_the_load_balancer_limits" {
  command = plan

  variables {
    max_run_seconds = 7200
  }

  assert {
    condition     = tonumber(aws_lb_target_group.this.deregistration_delay) == 3600 && aws_lb_listener.this.tcp_idle_timeout_seconds == 6000
    error_message = "Deregistration delay caps at 3600 and the idle timeout at 6000."
  }
  assert {
    condition     = aws_appautoscaling_policy.sessions.target_tracking_scaling_policy_configuration[0].scale_in_cooldown == 3780
    error_message = "The scale-in cooldown follows the capped delay: 3600 + 180."
  }
}

run "the_deregistration_delay_can_be_shortened_for_fast_scale_in" {
  command = plan

  variables {
    deregistration_delay_seconds = 0
  }

  assert {
    condition     = tonumber(aws_lb_target_group.this.deregistration_delay) == 0
    error_message = "deregistration_delay_seconds replaces max_run_seconds + 60."
  }
  assert {
    condition     = aws_appautoscaling_policy.sessions.target_tracking_scaling_policy_configuration[0].scale_in_cooldown == 300
    error_message = "The scale-in cooldown never drops below 300 s."
  }
  assert {
    condition     = aws_lb_listener.this.tcp_idle_timeout_seconds == 660 && contains(jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment, { name = "BROWSER_GATE_DRAIN_SECONDS", value = "600" })
    error_message = "The idle timeout and the gate's drain still follow max_run_seconds."
  }
}

run "a_set_deregistration_delay_drives_the_cooldown" {
  command = plan

  variables {
    deregistration_delay_seconds = 1200
  }

  assert {
    condition     = tonumber(aws_lb_target_group.this.deregistration_delay) == 1200 && aws_appautoscaling_policy.sessions.target_tracking_scaling_policy_configuration[0].scale_in_cooldown == 1380
    error_message = "Delay 1200 gives a 1380 s scale-in cooldown."
  }
}

run "refuses_a_deregistration_delay_beyond_3600" {
  command = plan
  variables {
    deregistration_delay_seconds = 3601
  }
  expect_failures = [var.deregistration_delay_seconds]
}

run "refuses_a_fargate_size_pair_that_does_not_exist" {
  command = plan
  variables {
    cpu    = 2048
    memory = 2048
  }
  expect_failures = [var.memory]
}

run "refuses_a_fargate_memory_off_the_step" {
  command = plan
  variables {
    cpu    = 8192
    memory = 18432
  }
  expect_failures = [var.memory]
}

run "accepts_the_documented_fargate_pairs" {
  command = plan
  variables {
    cpu    = 8192
    memory = 20480
  }
  assert {
    condition     = aws_ecs_task_definition.this.cpu == "8192" && aws_ecs_task_definition.this.memory == "20480"
    error_message = "8 vCPU with 20 GiB is a Fargate size."
  }
}

run "ec2_takes_other_memory_sizes" {
  command = plan
  variables {
    launch_type = "EC2"
    cpu         = 2048
    memory      = 3000
  }
  assert {
    condition     = aws_ecs_task_definition.this.memory == "3000" && aws_ecs_service.this.launch_type == "EC2"
    error_message = "The Fargate pair check applies only to FARGATE."
  }
}

run "refuses_an_empty_dns_list" {
  command = plan
  variables {
    vpc_dns_cidrs = []
  }
  expect_failures = [var.vpc_dns_cidrs]
}

run "short_runs_keep_the_idle_timeout_minimum" {
  command = plan

  variables {
    max_run_seconds = 1
  }

  assert {
    condition     = tonumber(aws_lb_target_group.this.deregistration_delay) == 61 && aws_lb_listener.this.tcp_idle_timeout_seconds == 61
    error_message = "max_run_seconds 1 gives 61 s for both (the idle timeout minimum is 60)."
  }
}

run "scaling_tracks_session_utilisation_at_the_target" {
  command = plan

  variables {
    min_tasks                  = 2
    max_tasks                  = 12
    target_utilization_percent = 65
  }

  assert {
    condition = (
      aws_appautoscaling_target.this.min_capacity == 2 && aws_appautoscaling_target.this.max_capacity == 12 &&
      aws_appautoscaling_target.this.resource_id == "service/automation/rpa-browser" &&
      aws_appautoscaling_target.this.scalable_dimension == "ecs:service:DesiredCount" && aws_appautoscaling_target.this.service_namespace == "ecs"
    )
    error_message = "The scalable target is the service's desired count, min_tasks to max_tasks."
  }
  assert {
    condition     = aws_appautoscaling_policy.sessions.policy_type == "TargetTrackingScaling" && aws_appautoscaling_policy.sessions.target_tracking_scaling_policy_configuration[0].target_value == 65
    error_message = "Target tracking holds target_utilization_percent."
  }
  assert {
    condition = {
      for m in aws_appautoscaling_policy.sessions.target_tracking_scaling_policy_configuration[0].customized_metric_specification[0].metrics :
      m.id => m.expression if m.expression != null && m.expression != ""
      } == {
      utilisation = "100 * active / capacity"
    }
    error_message = "One expression: 100 * active / capacity (both Sum over every task, so 100*SUM(active)/SUM(capacity))."
  }
  assert {
    condition = {
      for m in aws_appautoscaling_policy.sessions.target_tracking_scaling_policy_configuration[0].customized_metric_specification[0].metrics :
      m.id => {
        name      = m.metric_stat[0].metric[0].metric_name
        namespace = m.metric_stat[0].metric[0].namespace
        dims      = { for d in m.metric_stat[0].metric[0].dimensions : d.name => d.value }
        stat      = m.metric_stat[0].stat
        returned  = m.return_data
      } if length(m.metric_stat) > 0
      } == {
      active   = { name = "SessionsActive", namespace = "RPA/Browser", dims = { ServiceName = "automation/rpa-browser" }, stat = "Sum", returned = false }
      capacity = { name = "SessionsCapacity", namespace = "RPA/Browser", dims = { ServiceName = "automation/rpa-browser" }, stat = "Sum", returned = false }
    }
    error_message = "active and capacity are SessionsActive and SessionsCapacity in RPA/Browser by ServiceName, stat Sum, not returned."
  }
  assert {
    condition = alltrue([
      for m in aws_appautoscaling_policy.sessions.target_tracking_scaling_policy_configuration[0].customized_metric_specification[0].metrics :
      m.return_data == (m.id == "utilisation")
    ])
    error_message = "Only the expression returns data."
  }
  assert {
    condition = (
      contains(jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment, { name = "BROWSER_GATE_EMF", value = "on" }) &&
      contains(jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment, { name = "BROWSER_GATE_SERVICE_NAME", value = "automation/rpa-browser" })
    )
    error_message = "The gate writes EMF with the ServiceName the policy reads."
  }
  assert {
    condition     = aws_ecs_service.this.desired_count == 2
    error_message = "The service starts at min_tasks."
  }
}

run "the_token_is_written_write_only_and_appears_in_no_output" {
  command = plan

  assert {
    condition     = length(aws_secretsmanager_secret.token) == 1 && length(aws_secretsmanager_secret_version.token) == 1
    error_message = "Without existing_token_secret_arn the module creates the secret and its version."
  }
  assert {
    condition     = aws_secretsmanager_secret_version.token[0].secret_string_wo_version == 1 && aws_secretsmanager_secret_version.token[0].secret_string == null && aws_secretsmanager_secret_version.token[0].secret_binary == null
    error_message = "The version is written once (secret_string_wo_version = 1), never through secret_string or secret_binary."
  }
  assert {
    # Write-only values are null in plan and state, so the configuration itself is checked: the version's value comes
    # from the ephemeral password through secret_string_wo.
    condition     = can(regex("secret_string_wo\\s*=\\s*ephemeral\\.random_password\\.token\\[0\\]\\.result", file("${path.module}/secret.tf")))
    error_message = "secret_string_wo is fed by ephemeral.random_password.token."
  }
  assert {
    condition     = can(regex("ephemeral\\s+\"random_password\"\\s+\"token\"", file("${path.module}/secret.tf"))) && !can(regex("resource\\s+\"random_(password|string)\"", join("\n", [for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")])))
    error_message = "The token is generated only by an ephemeral random_password, never by a stored random resource."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].secrets == [{ name = "BROWSER_GATE_TOKEN", valueFrom = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:rpa-browser-token-AbCdEf" }]
    error_message = "The task reads the token from the secret through secrets.valueFrom."
  }
  assert {
    condition     = !contains([for e in jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment : e.name], "BROWSER_GATE_TOKEN")
    error_message = "The token is never a plain environment variable."
  }
  assert {
    condition     = output.token_secret_arn == "arn:aws:secretsmanager:eu-west-1:123456789012:secret:rpa-browser-token-AbCdEf"
    error_message = "token_secret_arn is the secret's ARN."
  }
  assert {
    condition     = output.n8n_settings.rpa_browser_credential.token_secret == "arn:aws:secretsmanager:eu-west-1:123456789012:secret:rpa-browser-token-AbCdEf"
    error_message = "The credential settings name the secret, never its value."
  }
  assert {
    # Both secrets are exported in the shell beforehand (the notes show how); the command never names them, not even as
    # placeholders to fill in, so neither value ever lands on a command line or in shell history.
    condition     = !strcontains(output.configure_command, "N8N_API_KEY") && !strcontains(output.configure_command, "RPA_BROWSER_TOKEN") && startswith(output.configure_command, "node deploy/scripts/configure-n8n.mjs ")
    error_message = "configure_command assumes N8N_API_KEY and RPA_BROWSER_TOKEN are exported and never inlines them."
  }
  assert {
    condition = anytrue([
      for n in output.n8n_settings.notes :
      strcontains(n, "export RPA_BROWSER_TOKEN=\"$(aws secretsmanager get-secret-value --region eu-west-1 --secret-id 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:rpa-browser-token-AbCdEf' --query SecretString --output text)\"")
    ])
    error_message = "The notes give the shell recipe that exports RPA_BROWSER_TOKEN from Secrets Manager without pasting it."
  }
  assert {
    condition     = anytrue([for n in output.n8n_settings.notes : strcontains(n, "read -rs N8N_API_KEY && export N8N_API_KEY") && strcontains(n, "--project-id")])
    error_message = "The notes export the API key without echoing it and name the optional --project-id."
  }
  assert {
    condition = alltrue([
      for m in regexall("output \"([a-z0-9_]+)\"", file("${path.module}/outputs.tf")) :
      contains(["browser_endpoint", "token_secret_arn", "security_group_id", "load_balancer_security_group_id", "n8n_settings", "configure_command"], m[0])
    ])
    error_message = "Only the known outputs exist (none is a token)."
  }
  assert {
    condition     = !can(regex("random_password|sensitive\\s*=\\s*true|nonsensitive", file("${path.module}/outputs.tf")))
    error_message = "No output reads the password or needs to be sensitive."
  }
  assert {
    condition = alltrue([
      for m in regexall("variable \"([a-z0-9_]+)\"", file("${path.module}/variables.tf")) :
      !can(regex("token|password|api_key", m[0])) || contains(["existing_token_secret_arn", "token_kms_key_arn"], m[0])
    ])
    error_message = "No variable takes a token value; only the secret's ARN and its KMS key."
  }
}

run "an_existing_secret_skips_generation" {
  command = plan

  variables {
    existing_token_secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:team/rpa-browser-token-XyZ123"
  }

  assert {
    condition     = length(aws_secretsmanager_secret.token) == 0 && length(aws_secretsmanager_secret_version.token) == 0
    error_message = "With existing_token_secret_arn nothing is generated or written."
  }
  assert {
    condition     = output.token_secret_arn == "arn:aws:secretsmanager:eu-west-1:123456789012:secret:team/rpa-browser-token-XyZ123"
    error_message = "token_secret_arn is the existing secret."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].secrets == [{ name = "BROWSER_GATE_TOKEN", valueFrom = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:team/rpa-browser-token-XyZ123" }]
    error_message = "The task reads the existing secret."
  }
  assert {
    condition = [
      for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Resource if contains(flatten([s.Action]), "secretsmanager:GetSecretValue")
    ] == ["arn:aws:secretsmanager:eu-west-1:123456789012:secret:team/rpa-browser-token-XyZ123"]
    error_message = "The execution role reads only the existing secret."
  }
}

run "the_task_role_can_only_change_its_own_protection" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_role_policy.task.policy).Statement == [{
      Sid       = "TaskScaleInProtection"
      Effect    = "Allow"
      Action    = "ecs:UpdateTaskProtection"
      Resource  = "arn:aws:ecs:eu-west-1:123456789012:task/automation/*"
      Condition = { ArnEquals = { "ecs:cluster" = "arn:aws:ecs:eu-west-1:123456789012:cluster/automation" } }
    }]
    error_message = "The task role allows only ecs:UpdateTaskProtection, on tasks of this cluster."
  }
  assert {
    condition     = aws_ecs_task_definition.this.task_role_arn == aws_iam_role.task.arn && aws_ecs_task_definition.this.execution_role_arn == aws_iam_role.execution.arn
    error_message = "The task definition uses the module's two roles."
  }
  assert {
    condition     = !can(regex("aws_iam_role_policy_attachment|aws_iam_policy_attachment|managed_policy_arns", join("\n", [for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")])))
    error_message = "No managed policies are attached to either role."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.execution.policy).Statement :
      contains(["secretsmanager:GetSecretValue", "logs:CreateLogStream", "logs:PutLogEvents", "kms:Decrypt", "ecr:GetAuthorizationToken", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], flatten([s.Action])[0])
    ])
    error_message = "The execution role reads the secret, writes its logs and pulls from ECR, nothing else."
  }
  assert {
    condition = [
      for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Resource if contains(flatten([s.Action]), "secretsmanager:GetSecretValue")
    ] == ["arn:aws:secretsmanager:eu-west-1:123456789012:secret:rpa-browser-token-AbCdEf"]
    error_message = "The execution role reads only the generated secret."
  }
  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s if startswith(flatten([s.Action])[0], "ecr:")]) == 0
    error_message = "A GHCR image needs no ECR permissions."
  }
  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s if flatten([s.Action])[0] == "kms:Decrypt"]) == 0
    error_message = "No KMS permission without token_kms_key_arn (the aws/secretsmanager key needs none)."
  }
}

run "an_ecr_image_and_a_kms_key_add_only_their_permissions" {
  command = plan

  variables {
    image             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/rpa-browser:1.63.0"
    token_kms_key_arn = "arn:aws:kms:eu-west-1:123456789012:key/0f0e0d0c-0b0a-0908-0706-050403020100"
  }

  assert {
    condition = [
      for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Resource if contains(flatten([s.Action]), "kms:Decrypt")
    ] == ["arn:aws:kms:eu-west-1:123456789012:key/0f0e0d0c-0b0a-0908-0706-050403020100"]
    error_message = "kms:Decrypt only on token_kms_key_arn."
  }
  assert {
    condition = [
      for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Resource if contains(flatten([s.Action]), "ecr:BatchGetImage")
    ] == ["arn:aws:ecr:eu-west-1:123456789012:repository/rpa-browser"]
    error_message = "ECR pull only on the image's repository."
  }
}

run "the_task_is_hardened" {
  command = plan

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].linuxParameters.capabilities == { drop = ["ALL"] }
    error_message = "Every Linux capability is dropped."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].privileged == false
    error_message = "Never privileged."
  }
  assert {
    # The image's own tini is PID 1 (images/browser/Dockerfile); a second init from ECS would only add a hop.
    condition     = !can(jsondecode(aws_ecs_task_definition.this.container_definitions)[0].linuxParameters.initProcessEnabled)
    error_message = "initProcessEnabled stays unset: the image brings tini."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].readonlyRootFilesystem == true
    error_message = "The root filesystem is read-only, as in the Helm chart."
  }
  assert {
    # A task bind mount at /tmp: Fargate fills it from the image's VOLUME ["/tmp"], root-owned 1777, so pwuser can write.
    condition = (
      [for v in aws_ecs_task_definition.this.volume : v.name] == ["tmp"] &&
      alltrue([for v in aws_ecs_task_definition.this.volume : v.host_path == null && length(v.efs_volume_configuration) == 0 && length(v.docker_volume_configuration) == 0]) &&
      jsondecode(aws_ecs_task_definition.this.container_definitions)[0].mountPoints == [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    )
    error_message = "/tmp is a task bind mount named tmp, the only writable path."
  }
  assert {
    condition = (
      contains(jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment, { name = "XDG_CACHE_HOME", value = "/tmp/.cache" }) &&
      contains(jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment, { name = "XDG_CONFIG_HOME", value = "/tmp/.config" })
    )
    error_message = "fontconfig and other caches go to /tmp, as in the Helm chart."
  }
  assert {
    condition     = [for p in jsondecode(aws_ecs_task_definition.this.container_definitions)[0].portMappings : p.containerPort] == [3000, 9464]
    error_message = "The container exposes the gate (3000) and metrics (9464)."
  }
  assert {
    condition = (
      aws_ecs_task_definition.this.network_mode == "awsvpc" && aws_ecs_task_definition.this.requires_compatibilities == toset(["FARGATE"]) &&
      aws_ecs_task_definition.this.cpu == "2048" && aws_ecs_task_definition.this.memory == "4096"
    )
    error_message = "Fargate, awsvpc, 2 vCPU and 4 GiB by default."
  }
  assert {
    condition     = aws_ecs_service.this.deployment_circuit_breaker[0].enable == true && aws_ecs_service.this.deployment_circuit_breaker[0].rollback == true
    error_message = "The deployment circuit breaker is on, with rollback."
  }
  assert {
    condition     = aws_ecs_service.this.launch_type == "FARGATE" && toset(aws_ecs_service.this.network_configuration[0].subnets) == toset(["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"])
    error_message = "The service runs on Fargate in the given private subnets."
  }
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.this.container_definitions)[0].logConfiguration.logDriver == "awslogs" &&
      jsondecode(aws_ecs_task_definition.this.container_definitions)[0].logConfiguration.options["awslogs-group"] == aws_cloudwatch_log_group.this.name &&
      jsondecode(aws_ecs_task_definition.this.container_definitions)[0].logConfiguration.options["awslogs-region"] == "eu-west-1" &&
      jsondecode(aws_ecs_task_definition.this.container_definitions)[0].logConfiguration.options["mode"] == "non-blocking" &&
      jsondecode(aws_ecs_task_definition.this.container_definitions)[0].logConfiguration.options["max-buffer-size"] == "4m" &&
      aws_cloudwatch_log_group.this.retention_in_days == 30
    )
    error_message = "Logs (and the EMF lines) go to the module's log group through awslogs."
  }
  assert {
    condition     = contains(jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment, { name = "BROWSER_GATE_MAX_SESSIONS", value = "4" })
    error_message = "4 sessions per task by default."
  }
}

run "outputs_describe_the_service" {
  command = plan

  variables {
    n8n_url = "https://n8n.example.com"
  }

  assert {
    condition     = output.browser_endpoint == "ws://rpa-browser-0123456789.elb.eu-west-1.amazonaws.com:3000/"
    error_message = "The endpoint is the NLB's DNS name on 3000."
  }
  assert {
    condition     = output.security_group_id == "sg-0bbbbbbbbbbbbbbbb" && output.load_balancer_security_group_id == "sg-0aaaaaaaaaaaaaaaa"
    error_message = "The task and NLB security group IDs are outputs."
  }
  assert {
    condition = output.n8n_settings.rpa_browser_credential == {
      mode         = "playwright"
      endpoint     = "ws://rpa-browser-0123456789.elb.eu-west-1.amazonaws.com:3000/"
      token_secret = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:rpa-browser-token-AbCdEf"
    }
    error_message = "Credential settings: Browser Server mode (stored value playwright), the endpoint, the token's secret ARN."
  }
  assert {
    condition     = output.n8n_settings.executions_mode == "queue" && output.n8n_settings.node_package == "n8n-nodes-rpa" && length(output.n8n_settings.notes) > 0
    error_message = "Queue mode, the node package and notes."
  }
  assert {
    condition     = output.configure_command == "node deploy/scripts/configure-n8n.mjs --n8n-url 'https://n8n.example.com' --endpoint 'ws://rpa-browser-0123456789.elb.eu-west-1.amazonaws.com:3000/'"
    error_message = "configure_command runs configure-n8n.mjs with the n8n URL and the endpoint."
  }
}

run "refuses_an_image_without_tag_or_digest" {
  command = plan
  variables {
    image = "ghcr.io/example/rpa-browser"
  }
  expect_failures = [var.image]
}

run "refuses_a_cluster_that_is_not_an_ecs_cluster_arn" {
  command = plan
  variables {
    cluster_arn = "automation"
  }
  expect_failures = [var.cluster_arn]
}

run "refuses_a_drain_beyond_the_gate_limit" {
  command = plan
  variables {
    max_run_seconds = 86401
  }
  expect_failures = [var.max_run_seconds]
}

run "refuses_zero_sessions" {
  command = plan
  variables {
    sessions_per_task = 0
  }
  expect_failures = [var.sessions_per_task]
}

run "refuses_max_below_min" {
  command = plan
  variables {
    min_tasks = 3
    max_tasks = 2
  }
  expect_failures = [var.max_tasks]
}

run "refuses_the_metadata_range_as_egress" {
  command = plan
  variables {
    allowed_egress_cidrs = ["169.254.169.254/32"]
  }
  expect_failures = [var.allowed_egress_cidrs]
}

run "refuses_no_n8n_security_groups" {
  command = plan
  variables {
    n8n_security_group_ids = []
  }
  expect_failures = [var.n8n_security_group_ids]
}

run "refuses_a_secret_arn_that_is_not_one" {
  command = plan
  variables {
    existing_token_secret_arn = "rpa-browser-token"
  }
  expect_failures = [var.existing_token_secret_arn]
}
