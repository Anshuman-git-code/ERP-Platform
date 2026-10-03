# ============================================================
# FILE: infra/terraform/main.tf
# CONSTRUCTION ORDER: #41
# HOW: touch infra/terraform/main.tf
# WHY NOW: Written after database.tf and iam.tf because:
#   - database_url SSM parameter value uses aws_db_instance.postgres.endpoint (database.tf)
#   - Both SSM parameters' ARNs are referenced in iam.tf's ssm_read policy
#   Terraform resolves these dependencies automatically, but we write the files
#   in this logical order to understand the dependencies.
# WHAT THIS FILE DOES:
#   Creates the two AWS SSM Parameter Store entries that hold production secrets.
#   These are the bridge between Terraform (which knows the RDS endpoint) and
#   ECS (which needs the secrets to start containers).
# WHY SSM PARAMETER STORE (not hardcoded):
#   1. Secrets never appear in code, logs, or environment variable lists
#   2. ECS injects them at container startup — only the running container sees them
#   3. You can rotate secrets without redeploying (just update the SSM param)
#   4. IAM controls who/what can read each parameter
# ============================================================

# ── SSM SecureString Parameters ───────────────────────────────────────────────

# DATABASE_URL — the full PostgreSQL connection string.
# Constructed from the RDS instance attributes:
#   username: var.db_username (ops_user)
#   password: var.db_password (sensitive — not logged by Terraform)
#   host:     aws_db_instance.postgres.endpoint (e.g., ops-erp-db-dev.abc123.ap-south-1.rds.amazonaws.com:5432)
#   database: var.db_name (ops_erp)
resource "aws_ssm_parameter" "database_url" {
  # Name follows the convention: /project/environment/parameter_name
  # This hierarchy makes it easy to see all parameters for a project in SSM console.
  name = "/${var.project_name}/${var.environment}/database_url"

  # SecureString: the value is encrypted at rest using AWS KMS.
  # Plain String would store it unencrypted — never use String for secrets.
  type = "SecureString"

  value = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${var.db_name}?schema=public"
  # aws_db_instance.postgres.endpoint returns: hostname:port
  # e.g., ops-erp-db-dev.abc123xyz.ap-south-1.rds.amazonaws.com:5432

  # lifecycle { ignore_changes = [value] } — CRITICAL for secret rotation.
  # Without this: if someone rotates the DB password in SSM manually,
  # the next `terraform apply` would see the current value differs from what
  # Terraform expects and OVERWRITE it with the old password → breaking prod.
  # With ignore_changes: Terraform only writes this value on first creation.
  # Subsequent applies leave the value alone, even if it was manually updated.
  lifecycle {
    ignore_changes = [value]
  }
}

# JWT_SECRET — the signing key for JSON Web Tokens.
resource "aws_ssm_parameter" "jwt_secret" {
  name  = "/${var.project_name}/${var.environment}/jwt_secret"
  type  = "SecureString"
  value = var.jwt_secret

  # Same ignore_changes pattern — allows key rotation without Terraform interference.
  lifecycle {
    ignore_changes = [value]
  }
}
