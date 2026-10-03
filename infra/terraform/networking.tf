# ============================================================
# FILE: infra/terraform/networking.tf
# CONSTRUCTION ORDER: #38
# HOW: touch infra/terraform/networking.tf
# WHY NOW: Written after variables.tf (needs var.*) and before compute.tf and database.tf
#          (both need the VPC, subnets, and security groups defined here).
# WHAT THIS FILE CREATES:
#   The entire network perimeter: VPC → Subnets → Gateways → Route Tables → Security Groups
# KEY SECURITY DESIGN (defense in depth):
#   Internet → ALB (public subnet, port 80)
#            → Backend ECS (private subnet, port 4000, ALB-only)
#            → RDS (private subnet, port 5432, backend-only)
#   Nothing in the private subnets is reachable from the internet directly.
# ============================================================

# ── VPC ────────────────────────────────────────────────────────────────────────
# VPC (Virtual Private Cloud) — an isolated network environment in AWS.
# All resources (ECS tasks, RDS) run inside this VPC.
resource "aws_vpc" "main" {
  # cidr_block: the IP address range for this entire VPC.
  # 10.1.0.0/16 = 65,536 available IP addresses.
  cidr_block = var.vpc_cidr

  # enable_dns_hostnames: allows AWS resources to get DNS hostnames.
  # Required for RDS to have a hostname (not just an IP).
  enable_dns_hostnames = true
  # enable_dns_support: enables DNS resolution within the VPC.
  enable_dns_support = true

  tags = { Name = "${var.project_name}-vpc-${var.environment}" }
  # "${var.project_name}-vpc-${var.environment}" = "ops-erp-vpc-dev"
  # Template strings in Terraform use ${} syntax.
}

# Internet Gateway — the bridge between the VPC and the public internet.
# Without this, traffic cannot enter or leave the VPC.
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id # Attach to our VPC
  # aws_vpc.main.id references the `id` attribute of the aws_vpc resource named "main".
  # Terraform resolves this dependency automatically — creates the VPC first.
  tags = { Name = "${var.project_name}-igw-${var.environment}" }
}

# ── Subnets ────────────────────────────────────────────────────────────────────

# Public subnets — where the ALB lives (internet-facing).
# count = length(var.availability_zones) creates ONE subnet PER AZ (2 subnets total).
# This is a "for loop" in Terraform — repeats the block `count` times.
resource "aws_subnet" "public" {
  count = length(var.availability_zones) # = 2 (ap-south-1a and ap-south-1b)

  vpc_id = aws_vpc.main.id
  # count.index is 0 for the first iteration, 1 for the second.
  # var.public_subnet_cidrs[0] = "10.1.1.0/24", [1] = "10.1.2.0/24"
  cidr_block        = var.public_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  # map_public_ip_on_launch: resources launched in this subnet automatically get
  # a public IP address. Required for the ALB to be internet-accessible.
  map_public_ip_on_launch = true

  tags = { Name = "${var.project_name}-public-${count.index + 1}-${var.environment}" }
  # Names: ops-erp-public-1-dev, ops-erp-public-2-dev
}

# Private subnets — where ECS tasks and RDS live (NOT internet-accessible).
# Resources here have no direct path to/from the internet.
# They can still make outbound calls (ECR image pulls) via the NAT Gateway.
resource "aws_subnet" "private" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]
  # map_public_ip_on_launch is false by default — private subnet resources
  # do NOT get public IPs.

  tags = { Name = "${var.project_name}-private-${count.index + 1}-${var.environment}" }
}

# ── NAT Gateway ────────────────────────────────────────────────────────────────
# NAT Gateway allows resources in PRIVATE subnets to make OUTBOUND internet requests
# (e.g., ECS tasks pulling Docker images from ECR, calling AWS APIs).
# Traffic flows: private subnet → NAT Gateway (public subnet) → Internet Gateway → internet
# Inbound traffic from the internet CANNOT reach private resources this way.

# Elastic IP — a static public IP address for the NAT Gateway.
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.project_name}-nat-eip-${var.environment}" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id          # The static IP assigned to this NAT Gateway
  subnet_id     = aws_subnet.public[0].id # NAT Gateway lives in a PUBLIC subnet
  tags          = { Name = "${var.project_name}-nat-${var.environment}" }
  # depends_on: NAT Gateway needs the Internet Gateway to exist first.
  # Without the IGW, the NAT Gateway has no path to the internet.
  depends_on = [aws_internet_gateway.main]
}

# ── Route Tables ───────────────────────────────────────────────────────────────
# Route tables define where traffic is sent based on destination IP.

# Public route table — directs internet-bound traffic to the Internet Gateway.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"                  # All traffic (any destination)
    gateway_id = aws_internet_gateway.main.id # → send to Internet Gateway
  }
  tags = { Name = "${var.project_name}-public-rt-${var.environment}" }
}

# Associate each public subnet with the public route table.
resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private route table — directs internet-bound traffic to the NAT Gateway.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id # → send to NAT Gateway (not IGW)
  }
  tags = { Name = "${var.project_name}-private-rt-${var.environment}" }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ── Security Groups ────────────────────────────────────────────────────────────
# Security groups are stateful firewalls that control inbound/outbound traffic.
# The chain of security groups creates a layered perimeter:
#   Internet → [ALB SG] → ALB → [Backend SG] → ECS → [RDS SG] → RDS

# ALB Security Group — allows HTTP from anywhere on the internet.
resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb-sg-${var.environment}"
  description = "Allow inbound HTTP from the internet"
  vpc_id      = aws_vpc.main.id

  ingress {          # INBOUND rules
    from_port   = 80 # Allow port 80 (HTTP)
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"] # From any IP address (the whole internet)
  }

  egress {          # OUTBOUND rules
    from_port   = 0 # Allow ALL outbound traffic
    to_port     = 0
    protocol    = "-1" # -1 means all protocols
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-alb-sg-${var.environment}" }
}

# Backend Security Group — allows port 4000 ONLY from the ALB security group.
# NOT from the internet. Internet traffic must go through the ALB first.
resource "aws_security_group" "backend" {
  name        = "${var.project_name}-backend-sg-${var.environment}"
  description = "Allow inbound from ALB only"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port = 4000
    to_port   = 4000
    protocol  = "tcp"
    # security_groups: allow traffic from resources in the ALB security group.
    # This is MORE SECURE than an IP range — it allows EXACTLY the ALB, nothing else.
    # Even if the ALB gets a new IP, this rule still works automatically.
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"] # Allow all outbound (for ECR pulls, SSM, CloudWatch)
  }

  tags = { Name = "${var.project_name}-backend-sg-${var.environment}" }
}

# Frontend Security Group — same pattern as backend but for port 80 (nginx).
resource "aws_security_group" "frontend" {
  name        = "${var.project_name}-frontend-sg-${var.environment}"
  description = "Allow inbound from ALB only"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-frontend-sg-${var.environment}" }
}

# RDS Security Group — allows PostgreSQL (port 5432) ONLY from backend ECS tasks.
# The database is COMPLETELY unreachable from the internet.
# Even an attacker inside the VPC (not in the backend SG) can't reach it.
resource "aws_security_group" "rds" {
  name        = "${var.project_name}-rds-sg-${var.environment}"
  description = "Allow inbound from backend ECS tasks only"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port = 5432 # PostgreSQL's default port
    to_port   = 5432
    protocol  = "tcp"
    # ONLY the backend security group can reach the database.
    # The frontend, the ALB, and the internet cannot reach the DB at all.
    security_groups = [aws_security_group.backend.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-rds-sg-${var.environment}" }
}
