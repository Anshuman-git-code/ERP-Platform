# ============================================================
# FILE: infra/terraform/database.tf
# CONSTRUCTION ORDER: #39
# HOW: touch infra/terraform/database.tf
# WHY NOW: Written after networking.tf because:
#   - RDS needs the private subnets (aws_subnet.private) from networking.tf
#   - RDS needs the RDS security group (aws_security_group.rds) from networking.tf
# WHY BEFORE main.tf:
#   main.tf constructs the DATABASE_URL using the RDS endpoint.
#   The endpoint is only known after the RDS instance is created.
#   Terraform resolves this dependency: main.tf references aws_db_instance.postgres.endpoint
#   → Terraform knows it must create the RDS instance before creating the SSM parameter.
# ============================================================

# DB Subnet Group — tells RDS which subnets it can place the database instance in.
# RDS requires at least 2 subnets in different AZs (even for single-AZ deployments).
# This is an AWS requirement for Multi-AZ failover capability.
resource "aws_db_subnet_group" "main" {
  name = "${var.project_name}-db-subnet-${var.environment}"
  # aws_subnet.private[*].id — splat expression.
  # [*] accesses ALL instances of the resource (both private subnets).
  # Equivalent to [aws_subnet.private[0].id, aws_subnet.private[1].id]
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${var.project_name}-db-subnet-group-${var.environment}" }
}

# RDS PostgreSQL instance.
resource "aws_db_instance" "postgres" {
  identifier = "${var.project_name}-db-${var.environment}" # ops-erp-db-dev

  # Engine configuration
  engine         = "postgres"            # PostgreSQL (matches schema.prisma datasource provider)
  engine_version = "15"                  # PostgreSQL 15 (matches docker-compose.yml image version)
  instance_class = var.db_instance_class # db.t3.micro by default

  # Database and credentials
  db_name  = var.db_name     # "ops_erp" — the database to create inside PostgreSQL
  username = var.db_username # "ops_user"
  password = var.db_password # sensitive variable from variables.tf

  # Storage
  storage_type      = "gp2" # General Purpose SSD — good balance of price and performance
  allocated_storage = 20    # 20 GB initial storage

  # storage_encrypted: encrypts data at rest using AES-256.
  # This is the key security requirement for compliance (SOC2, HIPAA, etc.).
  # Data is encrypted transparently — the application doesn't know the difference.
  storage_encrypted = true

  # Network placement
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  # publicly_accessible: false — the RDS instance has no public IP.
  # It is reachable ONLY from within the VPC (specifically from the backend SG).
  publicly_accessible = false

  # skip_final_snapshot: true — when you destroy this instance with `terraform destroy`,
  # skip creating a final backup snapshot.
  # Set to false in production if you want a snapshot before destruction.
  skip_final_snapshot = true

  # backup_retention_period: 0 — disable automated backups.
  # In production, set to 7 (keep 7 days of backups).
  backup_retention_period = 0

  tags = { Name = "${var.project_name}-postgres-${var.environment}" }
}
