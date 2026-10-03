# ============================================================
# FILE: infra/terraform/monitoring.tf
# CONSTRUCTION ORDER: #43
# HOW: touch infra/terraform/monitoring.tf
# WHY NOW: Written after compute.tf because the alarms reference resources
#          defined there (aws_lb.main, aws_db_instance.postgres).
# WHAT THIS FILE CREATES:
#   1. CloudWatch log group — where container logs are stored
#   2. ALB 5xx alarm — alerts when the backend returns too many errors
#   3. RDS CPU alarm — alerts when the database is under high load
# WHY MONITORING MATTERS:
#   Without alarms, you only learn about problems when users complain.
#   With alarms, you're notified immediately when something goes wrong.
# ============================================================

# CloudWatch Log Group — the destination for all container logs.
# Both backend and frontend containers write to this group (with different stream prefixes).
# The awslogs driver in compute.tf points to this group name.
resource "aws_cloudwatch_log_group" "app" {
  name = "/ecs/${var.project_name}-${var.environment}"
  # Example: /ecs/ops-erp-dev

  # retention_in_days: how long to keep logs before automatic deletion.
  # Older logs cost money to store. We keep more in production (audit trail)
  # and less in dev (save cost, logs are less critical).
  # Ternary: condition ? value_if_true : value_if_false
  retention_in_days = var.environment == "prod" ? 30 : 7
}

# ── ALB 5xx Error Alarm ────────────────────────────────────────────────────────
# Triggers when the ALB returns more than 10 HTTP 5xx errors in a minute.
# 5xx errors = server errors (500, 502, 503, 504) — something is broken.
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name = "${var.project_name}-alb-5xx-${var.environment}"
  # GreaterThanThreshold: alarm fires when metric value > threshold
  comparison_operator = "GreaterThanThreshold"
  # evaluation_periods: number of periods the condition must be true before alarming.
  # 2 periods × 60 second period = 2 minutes of sustained errors before alarm.
  # This prevents false alarms from brief transient errors.
  evaluation_periods = 2
  # The specific CloudWatch metric to monitor.
  metric_name = "HTTPCode_ELB_5XX_Count"
  namespace   = "AWS/ApplicationELB"
  period      = 60    # Evaluate over 60-second windows
  statistic   = "Sum" # Sum all 5xx errors in the period
  threshold   = 10    # Alert if > 10 errors per minute

  alarm_description = "ALB returning >10 5xx errors per minute"

  dimensions = {
    # Scope the alarm to THIS specific ALB (not all ALBs in the account).
    LoadBalancer = aws_lb.main.arn_suffix
  }
  # NOTE: No alarm_actions defined — add an SNS topic ARN here to send email/Slack notifications.
}

# ── RDS CPU Utilization Alarm ─────────────────────────────────────────────────
# Triggers when the database CPU usage exceeds 80% for 10 minutes.
# High CPU on RDS can indicate slow queries, missing indexes, or the need to scale up.
resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.project_name}-rds-cpu-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300 # 5-minute windows
  statistic           = "Average"
  threshold           = 80 # Alert if average CPU > 80%
  alarm_description   = "RDS CPU > 80% for 10 minutes"

  dimensions = {
    # Scope to THIS specific RDS instance.
    DBInstanceIdentifier = aws_db_instance.postgres.identifier
  }
}
