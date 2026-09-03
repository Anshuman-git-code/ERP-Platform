output "alb_dns_name" {
  description = "Application Load Balancer DNS name (use as CORS_ORIGIN)"
  value       = aws_lb.main.dns_name
}

output "ecr_backend_url" {
  description = "ECR repository URL for backend"
  value       = aws_ecr_repository.backend.repository_url
}

output "ecr_frontend_url" {
  description = "ECR repository URL for frontend"
  value       = aws_ecr_repository.frontend.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_backend_service" {
  value = aws_ecs_service.backend.name
}

output "ecs_frontend_service" {
  value = aws_ecs_service.frontend.name
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = aws_db_instance.postgres.endpoint
  sensitive   = true
}

output "cloudwatch_log_group" {
  value = aws_cloudwatch_log_group.app.name
}

output "app_url" {
  description = "Application URL"
  value       = "http://${aws_lb.main.dns_name}"
}
