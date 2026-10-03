# ============================================================
# FILE: infra/terraform/outputs.tf
# CONSTRUCTION ORDER: #44 — Last Terraform file
# HOW: touch infra/terraform/outputs.tf
# WHY LAST: Outputs reference resources from ALL other .tf files.
#           They can only be written once all resources are defined.
# WHAT OUTPUTS ARE:
#   After `terraform apply`, Terraform prints these values to the terminal.
#   They tell you the URLs, ARNs, and names of everything just created.
#   You use them to:
#     1. Update CI/CD variables (ECR URLs for pushing images)
#     2. Configure the frontend's API base URL (ALB DNS)
#     3. Copy RDS endpoint into SSM (if updating manually)
#     4. Verify the deployment worked
# HOW TO SEE OUTPUTS:
#   terraform output               — all outputs
#   terraform output alb_dns_name  — specific output
# ============================================================

output "alb_dns_name" {
  description = "Application Load Balancer DNS name — use as the app URL and CORS_ORIGIN"
  # aws_lb.main.dns_name is the auto-generated DNS hostname for the ALB.
  # Example: ops-erp-alb-dev-1234567890.ap-south-1.elb.amazonaws.com
  value = aws_lb.main.dns_name
}

output "ecr_backend_url" {
  description = "ECR repository URL for backend — use in CI/CD docker push command"
  # Example: 123456789012.dkr.ecr.ap-south-1.amazonaws.com/ops-erp-backend-dev
  value = aws_ecr_repository.backend.repository_url
}

output "ecr_frontend_url" {
  description = "ECR repository URL for frontend — use in CI/CD docker push command"
  value       = aws_ecr_repository.frontend.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name — needed for aws ecs update-service commands"
  value       = aws_ecs_cluster.main.name
}

output "ecs_backend_service" {
  description = "ECS backend service name — used in CI/CD deploy commands"
  value       = aws_ecs_service.backend.name
}

output "ecs_frontend_service" {
  description = "ECS frontend service name — used in CI/CD deploy commands"
  value       = aws_ecs_service.frontend.name
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint (host:port) — used to construct DATABASE_URL"
  value       = aws_db_instance.postgres.endpoint
  # sensitive = true — Terraform won't print this value in plan/apply output.
  # It's not technically secret (it's just a hostname), but database endpoints
  # should be kept private to reduce attack surface.
  sensitive = true
}

output "cloudwatch_log_group" {
  description = "CloudWatch log group name — use to find container logs"
  value       = aws_cloudwatch_log_group.app.name
  # Example: /ecs/ops-erp-dev
}

output "app_url" {
  description = "Full application URL — open this in a browser after deployment"
  # Constructs: http://ops-erp-alb-dev-1234567890.ap-south-1.elb.amazonaws.com
  value = "http://${aws_lb.main.dns_name}"
}
