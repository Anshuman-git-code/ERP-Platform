# ============================================================
# FILE: infra/terraform/iam.tf
# CONSTRUCTION ORDER: #40
# HOW: touch infra/terraform/iam.tf
# WHY NOW: Written after database.tf because:
#   - The SSM read policy references the SSM parameter ARNs (defined in main.tf)
#   - BUT main.tf references the IAM role ARNs (defined here)
#   - Terraform handles this circular-looking dependency by resolving them all
#     at plan time — it sees the full dependency graph and sequences correctly
# WHAT IAM IS:
#   IAM (Identity and Access Management) controls WHO can do WHAT in AWS.
#   Principle of Least Privilege: every role/user gets ONLY the permissions
#   they need — nothing more.
# THREE IAM RESOURCES CREATED HERE:
#   1. ECS task EXECUTION role — lets ECS pull images and read secrets
#   2. ECS task role — lets the running container write to CloudWatch
#   3. CI deploy user — lets GitLab CI deploy without full AWS access
# ============================================================

# ── Shared assume-role policy ─────────────────────────────────────────────────
# This policy document allows the ECS service to "assume" (use) IAM roles.
# Without this trust policy, an IAM role cannot be used by ECS tasks.
data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    actions = ["sts:AssumeRole"] # The permission to assume a role
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"] # ECS task runner service
    }
  }
}

# ── ECS Task EXECUTION Role ───────────────────────────────────────────────────
# This role is used by the ECS AGENT (the AWS infrastructure, not your app code)
# to: 1) Pull Docker images from ECR  2) Read secrets from SSM Parameter Store
# The application code itself uses the "task role" below.
resource "aws_iam_role" "ecs_task_execution" {
  name               = "${var.project_name}-ecs-exec-role-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

# Attach AWS's managed policy for standard ECS execution permissions.
# AmazonECSTaskExecutionRolePolicy grants:
#   - ecr:GetDownloadUrlForLayer, ecr:BatchGetImage (pull images from ECR)
#   - logs:CreateLogStream, logs:PutLogEvents (basic CloudWatch logging)
resource "aws_iam_role_policy_attachment" "ecs_exec_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Additional inline policy: allow reading the specific SSM parameters for
# DATABASE_URL and JWT_SECRET. These are passed to the ECS container as
# environment variables via the `secrets:` block in the task definition.
# Without this, ECS would fail to start the container because it can't
# fetch the secret values to inject.
resource "aws_iam_role_policy" "ssm_read" {
  name = "${var.project_name}-ssm-read-${var.environment}"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameters", # Batch get
          "ssm:GetParameter"   # Single get
        ]
        # Only allow reading THESE SPECIFIC parameters (not all SSM params).
        # This is least privilege — the role cannot read other projects' secrets.
        Resource = [
          aws_ssm_parameter.database_url.arn,
          aws_ssm_parameter.jwt_secret.arn,
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*" # Required to decrypt SecureString parameters
      }
    ]
  })
}

# ── ECS Task Role ─────────────────────────────────────────────────────────────
# This role is used by YOUR APPLICATION CODE running inside the container.
# Separate from the execution role — different permissions for the agent vs the app.
resource "aws_iam_role" "ecs_task" {
  name               = "${var.project_name}-ecs-task-role-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

# Allow the running container to write application logs to CloudWatch.
resource "aws_iam_role_policy" "cloudwatch_logs" {
  name = "${var.project_name}-cw-logs-${var.environment}"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream", # Create a new log stream (per container instance)
        "logs:PutLogEvents"     # Write log entries
      ]
      # Only allow writing to THIS project's log group.
      # ${aws_cloudwatch_log_group.app.arn}:* — the :* allows writing to any stream within it.
      Resource = "${aws_cloudwatch_log_group.app.arn}:*"
    }]
  })
}

# ── CI/CD Deploy User ─────────────────────────────────────────────────────────
# An IAM user (not a role) for the GitLab CI pipeline.
# The access key and secret key for this user are stored in GitLab CI variables:
#   AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
# Using a dedicated user (not a developer's personal credentials) follows
# least privilege and makes it easy to revoke CI access independently.
resource "aws_iam_user" "ci_deploy" {
  name = "${var.project_name}-ci-deploy-${var.environment}"
}

# Inline policy granting ONLY the permissions needed for deployment.
resource "aws_iam_user_policy" "ci_deploy" {
  name = "${var.project_name}-ci-deploy-policy-${var.environment}"
  user = aws_iam_user.ci_deploy.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # ECR: allow pushing Docker images.
        # GetAuthorizationToken: get credentials to authenticate to ECR.
        # The other actions are the standard image push workflow.
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage"
        ]
        Resource = "*" # All ECR repos (could be narrowed to specific repo ARNs)
      },
      {
        # ECS: allow updating the service and describing its state.
        # UpdateService: deploy a new task definition revision.
        # DescribeServices: check if the deployment is stable (used in CI wait).
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices",
          "ecs:RegisterTaskDefinition",
          "ecs:DescribeTaskDefinition",
          "ecs:ListTaskDefinitions"
        ]
        Resource = "*"
      },
      {
        # IAM PassRole: allow CI to "pass" the ECS roles to a new task definition.
        # Without this, ECS would reject the task definition because CI doesn't have
        # permission to assign IAM roles to AWS services.
        # The Resource is limited to EXACTLY the two ECS roles (not all IAM roles).
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [
          aws_iam_role.ecs_task_execution.arn,
          aws_iam_role.ecs_task.arn
        ]
      }
    ]
  })
}
