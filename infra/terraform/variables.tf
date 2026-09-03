variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Deployment environment (dev / staging / prod)"
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "project_name" {
  description = "Short project name used in resource naming"
  type        = string
  default     = "ops-erp"
}

# ── VPC ───────────────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  type    = string
  default = "10.1.0.0/16"
}

variable "availability_zones" {
  type    = list(string)
  default = ["ap-south-1a", "ap-south-1b"]
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.1.1.0/24", "10.1.2.0/24"]
}

variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.1.10.0/24", "10.1.11.0/24"]
}

# ── ECS ───────────────────────────────────────────────────────────────────────

variable "backend_cpu" {
  type    = number
  default = 256
}

variable "backend_memory" {
  type    = number
  default = 512
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
  type    = number
  default = 1
}

variable "backend_image" {
  description = "ECR image URI for the backend (set by CI/CD)"
  type        = string
  default     = "PLACEHOLDER_BACKEND_IMAGE"
}

variable "frontend_image" {
  description = "ECR image URI for the frontend (set by CI/CD)"
  type        = string
  default     = "PLACEHOLDER_FRONTEND_IMAGE"
}

# ── Database ──────────────────────────────────────────────────────────────────

variable "db_instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "db_name" {
  type    = string
  default = "ops_erp"
}

variable "db_username" {
  type    = string
  default = "ops_user"
}

variable "db_password" {
  description = "RDS master password — set via TF_VAR_db_password env var"
  type        = string
  sensitive   = true
}

# ── App ───────────────────────────────────────────────────────────────────────

variable "jwt_secret" {
  description = "JWT signing secret — set via TF_VAR_jwt_secret env var"
  type        = string
  sensitive   = true
}

variable "cors_origin" {
  description = "Allowed CORS origin (ALB DNS or custom domain)"
  type        = string
  default     = "http://PLACEHOLDER_ALB_DNS"
}
