# ============================================================
# FILE: infra/terraform/variables.tf
# CONSTRUCTION ORDER: #37
# HOW: touch infra/terraform/variables.tf
# WHY SECOND AMONG TERRAFORM FILES:
#   Every other .tf file uses variables (var.aws_region, var.environment, etc.).
#   Variables must be declared before they can be used.
#   Provider.tf uses var.aws_region and var.project_name — those are defined here.
# WHAT THIS FILE DOES:
#   Declares all input variables for the entire Terraform configuration.
#   Variables allow the same config to be reused for dev/staging/prod environments
#   by providing different values without changing the code.
# HOW VARIABLES ARE SET (in priority order, highest first):
#   1. Environment variable: TF_VAR_environment=prod terraform apply
#   2. terraform.tfvars file (in .gitignore — contains secrets)
#   3. default value in this file
# ============================================================

# ── General settings ──────────────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region where all resources are deployed"
  type        = string
  default     = "ap-south-1" # Asia Pacific (Mumbai) — closest region to the target users
}

variable "environment" {
  description = "Deployment environment — controls naming and some sizing decisions"
  type        = string
  default     = "dev"

  # validation block — enforces valid values at plan time.
  # If someone tries `terraform apply` with environment="production" (typo),
  # Terraform fails with the error_message before creating any resources.
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "project_name" {
  description = "Short project name used as a prefix in all resource names"
  type        = string
  default     = "ops-erp"
  # Used in names like: ops-erp-vpc-dev, ops-erp-alb-dev, ops-erp-backend-dev
}

# ── VPC / Networking ──────────────────────────────────────────────────────────

variable "vpc_cidr" {
  # CIDR (Classless Inter-Domain Routing) notation: IP_address/prefix_length
  # 10.1.0.0/16 = the 10.1.x.x range (65,536 IP addresses total)
  type    = string
  default = "10.1.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs to use — two AZs for high availability"
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b"]
  # Using two AZs means if one data center fails, the other keeps serving traffic.
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets (one per AZ)"
  type        = list(string)
  default     = ["10.1.1.0/24", "10.1.2.0/24"]
  # /24 = 256 IP addresses per subnet. ALB lives here.
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets (one per AZ)"
  type        = list(string)
  default     = ["10.1.10.0/24", "10.1.11.0/24"]
  # /24 = 256 IPs. ECS tasks and RDS live here — not reachable from internet.
}

# ── ECS (container sizing) ────────────────────────────────────────────────────

variable "backend_cpu" {
  description = "Fargate CPU units for backend container (256 = 0.25 vCPU)"
  type        = number
  default     = 256
  # Fargate CPU values: 256, 512, 1024, 2048, 4096
  # 256 is the minimum — sufficient for a low-traffic ERP application.
}

variable "backend_memory" {
  description = "Fargate memory in MiB for backend container"
  type        = number
  default     = 512
  # Minimum memory for 256 CPU is 512 MiB. Node.js comfortably fits in 512.
}

variable "frontend_cpu" {
  type    = number
  default = 256
}

variable "frontend_memory" {
  type    = number
  default = 512
}

variable "desired_count" {
  description = "Number of ECS tasks to run per service"
  type        = number
  default     = 1
  # 1 for dev/staging. Increase for production load or high availability.
  # lifecycle { ignore_changes = [desired_count] } in compute.tf means
  # manual scaling (via AWS console or CLI) won't be overridden by Terraform.
}

variable "backend_image" {
  description = "Full ECR image URI for backend — set by CI/CD pipeline at deploy time"
  type        = string
  default     = "PLACEHOLDER_BACKEND_IMAGE"
  # In CI: TF_VAR_backend_image="123456.dkr.ecr.ap-south-1.amazonaws.com/ops-erp-backend-dev:abc1234"
  # The ECS service ignores task definition changes due to lifecycle ignore_changes,
  # so this variable is mainly used when running terraform apply manually for initial setup.
}

variable "frontend_image" {
  description = "Full ECR image URI for frontend — set by CI/CD pipeline at deploy time"
  type        = string
  default     = "PLACEHOLDER_FRONTEND_IMAGE"
}

# ── Database ──────────────────────────────────────────────────────────────────

variable "db_instance_class" {
  description = "RDS instance class — controls CPU and memory for the database"
  type        = string
  default     = "db.t3.micro"
  # db.t3.micro: 2 vCPU (burstable), 1GB RAM — sufficient for dev/staging.
  # db.t3.small or db.t3.medium for higher-traffic production workloads.
}

variable "db_name" {
  type    = string
  default = "ops_erp" # Database name inside PostgreSQL
}

variable "db_username" {
  type    = string
  default = "ops_user" # PostgreSQL superuser for the application
}

variable "db_password" {
  description = "RDS master password — NEVER committed. Set via TF_VAR_db_password env var."
  type        = string
  # sensitive = true — Terraform hides this value in plan/apply output and state.
  sensitive = true
  # No default — MUST be provided. Terraform will error if not set.
}

# ── Application ───────────────────────────────────────────────────────────────

variable "jwt_secret" {
  description = "JWT signing secret — NEVER committed. Set via TF_VAR_jwt_secret env var."
  type        = string
  sensitive   = true
  # No default — MUST be provided.
  # This value is stored in SSM Parameter Store (main.tf) and injected into
  # ECS tasks at runtime. It never appears in the Dockerfile or task definition JSON.
}

variable "cors_origin" {
  description = "Allowed CORS origin — set to ALB DNS name or custom domain after first apply"
  type        = string
  default     = "http://PLACEHOLDER_ALB_DNS"
  # After first `terraform apply`, get the ALB DNS from outputs.tf and update this.
}
