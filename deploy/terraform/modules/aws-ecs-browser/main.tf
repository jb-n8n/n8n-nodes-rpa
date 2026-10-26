# Attaches the RPA browser service to an existing ECS cluster next to n8n: one task definition running the rpa-browser
# image (Playwright's run-server behind the token gate), one service behind an internal NLB, scaled on session
# utilisation. The gate's ECS helpers are on: task scale-in protection while sessions are open and EMF
# metric lines on stdout for scaling.
#
# Drain on ECS: scale-in and deployments skip tasks the gate protects; that is what keeps busy tasks running. A task that
# does stop is first deregistered from the target group (no new connections; open ones are never cut, as
# connection_termination is off) and gets SIGTERM only after the deregistration delay. Then the gate refuses new
# sessions and Fargate allows 120 s (stopTimeout's maximum).

locals {
  container_name = "rpa-browser"
  # The EMF ServiceName dimension: cluster/service is unique in the account and region, so two services never share a
  # metric series. The scaling policy reads the same value.
  metric_service_name = "${local.cluster_name}/${var.name}"

  container = {
    name      = local.container_name
    image     = var.image
    essential = true

    portMappings = [
      { name = "gate", containerPort = 3000, protocol = "tcp" },
      { name = "metrics", containerPort = 9464, protocol = "tcp" },
    ]

    environment = [
      { name = "BROWSER_GATE_PORT", value = "3000" },
      { name = "BROWSER_GATE_METRICS_PORT", value = "9464" },
      { name = "BROWSER_GATE_MAX_SESSIONS", value = tostring(var.sessions_per_task) },
      { name = "BROWSER_GATE_DRAIN_SECONDS", value = tostring(var.max_run_seconds) },
      { name = "BROWSER_GATE_ECS_PROTECTION", value = "on" },
      { name = "BROWSER_GATE_EMF", value = "on" },
      { name = "BROWSER_GATE_SERVICE_NAME", value = local.metric_service_name },
      # The root filesystem is read-only: fontconfig and other caches go to /tmp (as in the Helm chart).
      { name = "XDG_CACHE_HOME", value = "/tmp/.cache" },
      { name = "XDG_CONFIG_HOME", value = "/tmp/.config" },
    ]

    # The token comes from Secrets Manager at task start; it is never in the task definition.
    secrets = [{ name = "BROWSER_GATE_TOKEN", valueFrom = local.token_secret_arn }]

    privileged = false
    # The image's tini is PID 1 (images/browser/Dockerfile: ENTRYPOINT /usr/bin/tini -- entrypoint.sh) and reaps the
    # browser's orphans, so initProcessEnabled stays unset: a second init would only add a signal hop and a tini warning.
    linuxParameters = {
      capabilities = { drop = ["ALL"] }
    }
    # Read-only root, as in the Helm chart. Chromium writes profiles, downloads and shared-memory files (Playwright passes
    # --disable-dev-shm-usage) to /tmp, the task's bind mount on ephemeral storage. The image declares VOLUME ["/tmp"]
    # (root-owned 1777), and Fargate copies a VOLUME path's contents, owner and mode into a bind mount at the same path,
    # so pwuser can write it; without the VOLUME it would be root-owned 0755.
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]

    # Fargate's maximum. Longer runs are covered by task protection and the load balancer's deregistration delay.
    stopTimeout = 120

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = local.region
        awslogs-stream-prefix = local.container_name
        # A slow CloudWatch Logs never blocks the gate's stdout (and with it the sessions); lines beyond the buffer
        # are dropped instead.
        mode            = "non-blocking"
        max-buffer-size = "4m"
      }
    }
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = [var.launch_type]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([local.container])
  tags                     = var.tags

  # The container's /tmp (see mountPoints): a bind mount on the task's ephemeral storage, removed with the task.
  volume {
    name = "tmp"
  }

  runtime_platform {
    operating_system_family = "LINUX"
  }
}

resource "aws_ecs_service" "this" {
  name            = var.name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  launch_type     = var.launch_type
  desired_count   = var.min_tasks

  # A new task gets a minute to start Chromium's run-server before failed health checks count.
  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  propagate_tags                     = "SERVICE"
  enable_ecs_managed_tags            = true
  tags                               = var.tags

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = local.container_name
    container_port   = 3000
  }

  # Application Auto Scaling owns the task count after the first apply.
  lifecycle {
    ignore_changes = [desired_count]
  }

  # The target group must be attached to the load balancer before a service can use it.
  depends_on = [aws_lb_listener.this]
}
