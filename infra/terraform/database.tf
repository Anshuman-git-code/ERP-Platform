resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db-subnet-${var.environment}"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${var.project_name}-db-subnet-group-${var.environment}" }
}

resource "aws_db_instance" "postgres" {
  identifier              = "${var.project_name}-db-${var.environment}"
  engine                  = "postgres"
  engine_version          = "15"
  instance_class          = var.db_instance_class
  db_name                 = var.db_name
  username                = var.db_username
  password                = var.db_password
  storage_type            = "gp2"
  allocated_storage       = 20
  storage_encrypted       = true
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  publicly_accessible     = false
  skip_final_snapshot     = true
  backup_retention_period = 0 # increase for prod

  tags = { Name = "${var.project_name}-postgres-${var.environment}" }
}
