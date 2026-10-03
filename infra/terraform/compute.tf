# ============================================================
# FILE: infra/terraform/compute.tf
# CONSTRUCTION ORDER: #42 — The largest Terraform file
# HOW: touch infra/terraform/compute.tf
# WHY NOW: Written last among infrastructure resource files because it depends on:
#   - networking.tf: VPC, subnets, security groups, ALB
#   - iam.tf: ECS roles (execution and task)
#   - main.tf: SSM parameter ARNs for secrets injection
#   - monitoring.tf: CloudWatch log group name (actually monitoring.tf references
#     compute resources, so there's a subtle circular dependency — Terraform
#     resolves it from the full dependency graph)
# WHAT THIS FILE CREATES:
#   ECR repositories → ECS cluster → ALB → Target groups → Listener rules
#   → ECS task definitions → ECS services
#   This is the entire compute layer that runs the application.
# ============================================================

# ── ECR Repositories ──────────────────────────────────────────────────────────
# ECR (Elastic Container Registry) — AWS's private Docker image registry.
# CI/CD pushes images here; ECS pulls images from here.
# Using ECR (not Docker Hub) means: no rate limits, no external dependency,
# images stay within the AWS network (no egress costs for ECS pulls).

resource "aws_ecr_repository" "backend" {
  name                 = "${var.project_name}-backend-${var.environment}"
  image_tag_mutability = "MUTABLE" # Allows pushing the same tag again (e.g., `latest`)
  image_scanning_configuration {
    # scan_on_push: AWS scans every pushed image for known CVEs.
    # Security findings appear in the ECR console.
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "frontend" {
  name                 = "${var.project_name}-frontend-${var.environment}"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

# ECR lifecycle policies — automatically delete old images to save storage costs.
resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name
  # jsonencode() converts a Terraform object to a JSON string.
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any" # Match any image (tagged or untagged)
        countType   = "imageCountMoreThan"
        countNumber = 10 # Keep at most 10 images
      }
      action = { type = "expire" } # Delete images exceeding the limit
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "frontend" {
  repository = aws_ecr_repository.frontend.name
  policy = jsonencode({
    rules = [{ rulePriority = 1, description = "Keep last 10 images",
      selection = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 },
    action = { type = "expire" } }]
  })
}

# ── ECS Cluster ───────────────────────────────────────────────────────────────
# ECS cluster — a logical grouping of ECS tasks and services.
# With Fargate (serverless), AWS manages the underlying EC2 instances.
# You only define what CPU/memory you need; AWS handles the rest.
resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster-${var.environment}"
  setting {
    name = "containerInsights"
    # Container Insights: enables detailed metrics (CPU, memory, network) in CloudWatch.
    # More visibility than basic ECS metrics, at extra cost.
    value = "enabled"
  }
}

# ── Application Load Balancer ─────────────────────────────────────────────────
# ALB — the single entry point for all HTTP traffic.
# Routes requests to either the backend (for /api/* paths) or frontend (everything else).
resource "aws_lb" "main" {
  name               = "${var.project_name}-alb-${var.environment}"
  internal           = false         # internet-facing (not private)
  load_balancer_type = "application" # HTTP/HTTPS (not network/gateway)
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id # ALB spans BOTH public subnets
  # enable_deletion_protection: prevent accidental terraform destroy in production.
  enable_deletion_protection = var.environment == "prod"
}

# Target group for the backend — where ALB sends /api/* requests.
resource "aws_lb_target_group" "backend" {
  name     = "${var.project_name}-be-tg-${var.environment}"
  port     = 4000 # The port the backend container listens on
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id
  # target_type = "ip": required for Fargate — ECS tasks get IP addresses, not instance IDs.
  target_type = "ip"

  health_check {
    path                = "/health" # The Express /health endpoint (checks DB connectivity)
    healthy_threshold   = 2         # 2 consecutive successes → healthy
    unhealthy_threshold = 3         # 3 consecutive failures → unhealthy
    timeout             = 5         # Each check must complete in 5 seconds
    interval            = 30        # Check every 30 seconds
    matcher             = "200"     # Only HTTP 200 counts as healthy
  }
}

# Target group for the frontend.
resource "aws_lb_target_group" "frontend" {
  name        = "${var.project_name}-fe-tg-${var.environment}"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }
}

# HTTP listener — receives all requests on port 80 and routes them.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  # Default action: send to frontend (everything that doesn't match a rule).
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

# Listener rule: route /api/* and /health to the backend target group.
# Priority 10 — rules are evaluated in priority order (lower number = higher priority).
# The default action (frontend) is the fallback when no rule matches.
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }

  condition {
    path_pattern {
      # values: list of path patterns.
      # /api/* — all API routes
      # /health — health check endpoint (used by ALB itself for backend checks)
      values = ["/api/*", "/health"]
    }
  }
}

# ── ECS Task Definition: Backend ──────────────────────────────────────────────
# Task definition: describes what container to run and how.
# Think of it as a recipe — ECS uses it to start containers.
resource "aws_ecs_task_definition" "backend" {
  family = "${var.project_name}-backend-${var.environment}"
  # FARGATE: serverless — AWS manages the underlying VM.
  requires_compatibilities = ["FARGATE"]
  # awsvpc: each task gets its own network interface (required for Fargate).
  network_mode       = "awsvpc"
  cpu                = var.backend_cpu                     # 256 = 0.25 vCPU
  memory             = var.backend_memory                  # 512 MiB
  execution_role_arn = aws_iam_role.ecs_task_execution.arn # Pulls images + reads secrets
  task_role_arn      = aws_iam_role.ecs_task.arn           # CloudWatch logs

  # container_definitions: JSON array describing the containers in this task.
  container_definitions = jsonencode([{
    name      = "backend"
    image     = var.backend_image # ECR image URI set by CI/CD
    essential = true              # If this container stops, the whole task stops

    portMappings = [{ containerPort = 4000, protocol = "tcp" }]

    # environment: non-secret environment variables (visible in task definition).
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "4000" },
      { name = "CORS_ORIGIN", value = var.cors_origin },
      { name = "JWT_EXPIRES_IN", value = "8h" },
      { name = "AWS_REGION", value = var.aws_region },
    ]

    # secrets: environment variables fetched from SSM at container startup.
    # These are NEVER visible in the task definition — only the SSM parameter ARNs.
    # The ECS agent fetches the values using the execution role's SSM permissions
    # and injects them as environment variables before the container starts.
    # The application code reads them as process.env.DATABASE_URL etc.
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
      { name = "JWT_SECRET", valueFrom = aws_ssm_parameter.jwt_secret.arn },
    ]

    # logConfiguration: sends container stdout/stderr to CloudWatch Logs.
    # The awslogs driver captures all output and sends it to the log group.
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "backend" # Each container gets its own log stream prefix
      }
    }

    # Container-level health check (ECS checks this, separate from ALB health check).
    # Uses wget because Alpine doesn't have curl by default.
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:4000/health || exit 1"]
      interval    = 30 # Check every 30 seconds
      timeout     = 5
      retries     = 3
      startPeriod = 60 # Give 60 seconds for startup before counting failures
      # (prisma migrate deploy can take up to 30 seconds on first run)
    }
  }])
}

# Frontend task definition — similar pattern, simpler (nginx serving static files).
resource "aws_ecs_task_definition" "frontend" {
  family                   = "${var.project_name}-frontend-${var.environment}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.frontend_cpu
  memory                   = var.frontend_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name         = "frontend"
    image        = var.frontend_image
    essential    = true
    portMappings = [{ containerPort = 80, protocol = "tcp" }]
    environment = [
      { name = "BACKEND_URL", value = "http://${aws_lb.main.dns_name}" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "frontend"
      }
    }
  }])
}

# ── ECS Services ──────────────────────────────────────────────────────────────
# ECS Service: keeps `desired_count` tasks running at all times.
# If a task crashes, the service automatically starts a replacement.
# Services also manage deployments (rolling updates when task definition changes).

resource "aws_ecs_service" "backend" {
  name            = "${var.project_name}-backend-${var.environment}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = var.desired_count # 1 by default
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id # Tasks run in private subnets
    security_groups  = [aws_security_group.backend.id]
    assign_public_ip = false # Private subnet — no public IP needed
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = 4000
  }

  # lifecycle { ignore_changes = [...] } — CRITICAL for CI/CD coexistence.
  # Terraform manages the service configuration.
  # CI/CD manages the task_definition (updates the image URI).
  # If Terraform tracks task_definition, it would REVERT CI/CD deployments
  # on the next `terraform apply`.
  # ignore_changes = [task_definition, desired_count] means:
  #   - CI can update the task definition → Terraform won't revert it
  #   - Ops can manually scale desired_count → Terraform won't revert it
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

resource "aws_ecs_service" "frontend" {
  name            = "${var.project_name}-frontend-${var.environment}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.frontend.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.frontend.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = 80
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
