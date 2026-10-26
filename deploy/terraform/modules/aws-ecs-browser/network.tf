# Network: an internal Network Load Balancer in front of the tasks, and two security groups.
#
# Path: n8n tasks -> NLB (TCP 3000) -> task IPs (3000). The target group uses IP targets with client IP preservation
# off, so a task sees connections (and health checks) from the NLB's own private addresses, not from n8n. The NLB
# therefore carries a security group that admits 3000 only from the n8n security groups, and the task security group
# admits 3000 only from the NLB's security group.
#
# Terraform removes the default allow-all outbound rule from the security groups it creates, so the rules below are
# all there is. Security groups cannot block some link-local traffic: DNS to the Route 53 Resolver, and on Fargate the
# task metadata endpoint 169.254.170.2 (README, Security notes).

data "aws_vpc" "this" {
  id = var.vpc_id
}

locals {
  vpc_dns_cidrs = var.vpc_dns_cidrs != null ? var.vpc_dns_cidrs : ["${cidrhost(data.aws_vpc.this.cidr_block, 2)}/32"]
  dns_egress = {
    for pair in setproduct(local.vpc_dns_cidrs, ["tcp", "udp"]) : "${pair[0]} ${pair[1]}" => {
      cidr     = pair[0]
      protocol = pair[1]
    }
  }

  # Drain on the load balancer: ECS deregisters a stopping task first and sends SIGTERM only after the deregistration
  # delay (by default max_run_seconds + 60; the target group allows at most 3600). With connection_termination off the
  # delay never cuts a live connection; it only postpones SIGTERM. What keeps a busy task out of scale-in is the gate's
  # task protection. Each deployment or rollback also takes about this long per batch of old tasks. The listener's idle
  # timeout must outlast a quiet stretch of a run (60 to 6000).
  deregistration_delay = coalesce(var.deregistration_delay_seconds, min(var.max_run_seconds + 60, 3600))
  tcp_idle_timeout     = min(max(var.max_run_seconds + 60, 60), 6000)

  web_egress = {
    for pair in setproduct(var.allowed_egress_cidrs, [80, 443]) : "${pair[0]} tcp ${pair[1]}" => {
      cidr = pair[0]
      port = pair[1]
    }
  }
}

resource "aws_security_group" "lb" {
  name        = "${var.name}-lb"
  description = "RPA browser load balancer: TCP 3000 from n8n only"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-lb" })
}

resource "aws_security_group" "task" {
  name        = "${var.name}-task"
  description = "RPA browser tasks: 3000 from the load balancer, web and DNS out"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-task" })
}

resource "aws_vpc_security_group_ingress_rule" "lb_from_n8n" {
  # Keyed by position, so security group IDs that are only known after apply (created in the same root) work.
  for_each = { for i, id in var.n8n_security_group_ids : tostring(i) => id }

  security_group_id            = aws_security_group.lb.id
  description                  = "Browser sessions from n8n"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  tags                         = var.tags
}

resource "aws_vpc_security_group_egress_rule" "lb_to_task" {
  security_group_id            = aws_security_group.lb.id
  description                  = "Sessions and health checks to the tasks"
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  tags                         = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "task_from_lb" {
  security_group_id            = aws_security_group.task.id
  description                  = "Sessions and health checks from the load balancer"
  referenced_security_group_id = aws_security_group.lb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  tags                         = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "task_metrics" {
  for_each = toset(var.metrics_cidrs)

  security_group_id = aws_security_group.task.id
  description       = "Prometheus metrics"
  cidr_ipv4         = strcontains(each.value, ":") ? null : each.value
  cidr_ipv6         = strcontains(each.value, ":") ? each.value : null
  ip_protocol       = "tcp"
  from_port         = 9464
  to_port           = 9464
  tags              = var.tags
}

resource "aws_vpc_security_group_egress_rule" "task_web" {
  for_each = local.web_egress

  security_group_id = aws_security_group.task.id
  description       = "Browser to allowed sites"
  cidr_ipv4         = strcontains(each.value.cidr, ":") ? null : each.value.cidr
  cidr_ipv6         = strcontains(each.value.cidr, ":") ? each.value.cidr : null
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  tags              = var.tags
}

resource "aws_vpc_security_group_egress_rule" "task_platform" {
  for_each = toset(var.platform_egress_cidrs)

  security_group_id = aws_security_group.task.id
  description       = "Image registry, Secrets Manager and CloudWatch Logs"
  cidr_ipv4         = strcontains(each.value, ":") ? null : each.value
  cidr_ipv6         = strcontains(each.value, ":") ? each.value : null
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  tags              = var.tags
}

resource "aws_vpc_security_group_egress_rule" "task_platform_prefix_list" {
  for_each = { for i, id in var.platform_egress_prefix_list_ids : tostring(i) => id }

  security_group_id = aws_security_group.task.id
  description       = "Image layers and other platform endpoints"
  prefix_list_id    = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  tags              = var.tags
}

resource "aws_vpc_security_group_egress_rule" "task_dns" {
  for_each = local.dns_egress

  security_group_id = aws_security_group.task.id
  description       = "DNS to the VPC resolver"
  cidr_ipv4         = strcontains(each.value.cidr, ":") ? null : each.value.cidr
  cidr_ipv6         = strcontains(each.value.cidr, ":") ? each.value.cidr : null
  ip_protocol       = each.value.protocol
  from_port         = 53
  to_port           = 53
  tags              = var.tags
}

resource "aws_lb" "this" {
  name                             = var.name
  internal                         = true
  load_balancer_type               = "network"
  subnets                          = var.subnet_ids
  security_groups                  = [aws_security_group.lb.id]
  enable_cross_zone_load_balancing = true
  tags                             = var.tags
}

resource "aws_lb_target_group" "this" {
  name                 = var.name
  vpc_id               = var.vpc_id
  port                 = 3000
  protocol             = "TCP"
  target_type          = "ip"
  preserve_client_ip   = "false"
  deregistration_delay = local.deregistration_delay
  # Keep connections at the end of the delay too: the gate ends them itself (its drain), and ECS sends SIGTERM only
  # after the delay.
  connection_termination = false
  tags                   = var.tags

  # The gate answers /healthz with 503 while it drains; the open sessions on it must not be cut for that.
  target_health_state {
    enable_unhealthy_connection_termination = false
  }

  health_check {
    protocol            = "HTTP"
    port                = "traffic-port"
    path                = "/healthz"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "this" {
  load_balancer_arn        = aws_lb.this.arn
  port                     = 3000
  protocol                 = "TCP"
  tcp_idle_timeout_seconds = local.tcp_idle_timeout
  tags                     = var.tags

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}
