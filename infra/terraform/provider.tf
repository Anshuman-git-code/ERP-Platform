# ============================================================
# FILE: infra/terraform/provider.tf
# CONSTRUCTION ORDER: #36 — First Terraform file
# HOW: mkdir -p infra/terraform && touch infra/terraform/provider.tf
#      Then run: terraform init
#      (Downloads the AWS provider plugin, creates .terraform/ directory)
# WHY FIRST: provider.tf must exist before any other .tf file because:
#   1. It declares which cloud provider Terraform uses (AWS)
#   2. It specifies the provider version to pin
#   3. `terraform init` reads this file to download the provider plugin
#   4. All resource blocks in other files (aws_vpc, aws_ecs_cluster, etc.)
#      are provided by the AWS provider defined here
# WHAT TERRAFORM IS:
#   Infrastructure-as-Code (IaC) tool. Instead of clicking through the AWS console,
#   you declare what infrastructure you want in .tf files.
#   Terraform reads these files, computes the difference between what exists and
#   what you declared, and applies the changes (creates/updates/deletes resources).
# ============================================================

# terraform block — configures Terraform itself (not a cloud provider).
terraform {
  # required_version — minimum Terraform version this config is compatible with.
  # >= 1.5.0 means "1.5.0 or higher."
  required_version = ">= 1.5.0"

  # required_providers — pins the provider versions.
  # Without pinning, `terraform init` might download a newer provider version
  # that has breaking changes, causing unexpected failures.
  required_providers {
    aws = {
      source  = "hashicorp/aws" # Official HashiCorp AWS provider registry
      version = "~> 5.55"       # ~> 5.55 means: >=5.55.0 AND <6.0.0 (minor updates OK)
    }
  }

  # OPTIONAL: S3 backend for remote state storage.
  # Uncomment this in a team setting to store terraform.tfstate in S3
  # instead of locally. S3 state allows multiple team members to work
  # on the same infrastructure without state file conflicts.
  # WHY COMMENTED OUT: For a single-developer project, local state is fine.
  # backend "s3" {
  #   bucket = "ops-erp-terraform-state"
  #   key    = "ops-erp/terraform.tfstate"
  #   region = "ap-south-1"
  # }
}

# provider block — configures the AWS provider.
# Terraform uses this to authenticate with AWS and know which region to use.
provider "aws" {
  # region — AWS region where all resources are created.
  # var.aws_region reads from variables.tf (default: "ap-south-1" = Mumbai).
  region = var.aws_region

  # default_tags — AWS tags applied to EVERY resource created by this config.
  # Tags are key-value metadata that appear in the AWS console and billing reports.
  # WHY TAGS: Allows filtering resources by project, environment, or tool.
  # Example: you can filter Cost Explorer by tag Project=ops-erp to see just this project's costs.
  # Without default_tags, you'd have to add these three tags to every resource individually.
  default_tags {
    tags = {
      Project     = var.project_name # "ops-erp"
      Environment = var.environment  # "dev", "staging", or "prod"
      ManagedBy   = "terraform"      # Identifies resources managed by Terraform (not manual)
    }
  }
}
