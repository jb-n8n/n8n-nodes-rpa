# Scaling on session utilisation: target tracking holds 100 * SUM(active) / SUM(capacity) at
# target_utilization_percent, from the gate's EMF metrics (namespace RPA/Browser, dimension ServiceName only).
#
# How the sum across tasks is made: every task writes one EMF line a minute with both SessionsActive and
# SessionsCapacity under the same single dimension, so each metric is one series shared by all tasks. The statistic
# Sum over the policy's 1-minute period then adds up every task's datapoints, and the expression divides the two sums.
# The metric math SUM() function is not used for this: on a single series it returns one scalar for the whole query
# window, not a series (CloudWatch metric math). Because both values come from the same line, a task whose line falls
# twice or not at all into a minute moves both sums together, so the ratio stays a true utilisation.
#
# Stopping tasks: ECS deregisters a task from the load balancer and sends SIGTERM only after the deregistration delay.
# Until SIGTERM the gate doesn't know it is leaving, so its SessionsCapacity still counts while it gets no new sessions.
# For that window utilisation reads low: a second scale-in could overshoot, and scale-out lags a little. Hence the
# scale-in cooldown of max(300, deregistration delay + 180): the delay, plus a few minutes for the metric to catch up.
# After SIGTERM the gate reports 0 and 0 while it drains, so it drops out of both sums. When every task is draining,
# capacity sums to 0 and the division drops the datapoint (CloudWatch: a division by zero drops the point); target
# tracking then sees missing data and neither scales in nor out until a serving task reports again.

resource "aws_appautoscaling_target" "this" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${local.cluster_name}/${aws_ecs_service.this.name}"
  min_capacity       = var.min_tasks
  max_capacity       = var.max_tasks
  tags               = var.tags
}

resource "aws_appautoscaling_policy" "sessions" {
  name               = "${var.name}-session-utilisation"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  resource_id        = aws_appautoscaling_target.this.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.target_utilization_percent
    scale_out_cooldown = 60
    scale_in_cooldown  = max(300, local.deregistration_delay + 180)

    customized_metric_specification {
      metrics {
        id          = "active"
        label       = "Open browser sessions, all tasks"
        return_data = false

        metric_stat {
          stat = "Sum"

          metric {
            namespace   = "RPA/Browser"
            metric_name = "SessionsActive"

            dimensions {
              name  = "ServiceName"
              value = local.metric_service_name
            }
          }
        }
      }

      metrics {
        id          = "capacity"
        label       = "Browser session capacity, all serving tasks"
        return_data = false

        metric_stat {
          stat = "Sum"

          metric {
            namespace   = "RPA/Browser"
            metric_name = "SessionsCapacity"

            dimensions {
              name  = "ServiceName"
              value = local.metric_service_name
            }
          }
        }
      }

      metrics {
        id          = "utilisation"
        label       = "Session utilisation (%)"
        expression  = "100 * active / capacity"
        return_data = true
      }
    }
  }
}
