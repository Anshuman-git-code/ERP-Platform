# ─── SSM SecureString Parameters ─────────────────────────────────────────────
# Secrets are stored in SSM and injected into ECS task definitions at runtime.
# lifecycle ignore_changes prevents Terraform from overwriting rotated secrets.

resource "aws_ssm_parameter" "database_url" {
  name  = "/${var.project_name}/${var.environment}/database_url"
  type  = "SecureString"
  value = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${var.db_name}?schema=public"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "jwt_secret" {
  name  = "/${var.project_name}/${var.environment}/jwt_secret"
  type  = "SecureString"
  value = var.jwt_secret

  lifecycle {
    ignore_changes = [value]
  }
}
