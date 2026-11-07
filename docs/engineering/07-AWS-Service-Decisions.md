# 07 — AWS Service Decisions

> This document justifies each AWS service used in the production deployment and notes what each one is responsible for. The system is a containerized monolith, not a serverless app, so the service set is the minimal "run a stateful web service well" set.

---

## Service Inventory

| Service | Used For | Why this service |
|---|---|---|
| ECS (Fargate) | Run backend + frontend containers | No OS to patch; long-lived process holds a stable Prisma connection pool; matches Compose dev shape |
| ALB | Single entry point + path routing | One DNS name; splits `/api/*` & `/health` to backend and SPA to frontend; native health checks |
| RDS (PostgreSQL 15) | Source of truth | `SELECT FOR UPDATE` + ACID transactions are the foundation of the concurrency design |
| SSM Parameter Store | `DATABASE_URL`, `JWT_SECRET` | Encrypted at rest; injected at task start; never in task-def JSON plaintext |
| ECR | Container images | Scan-on-push; lifecycle policy keeps the last 10 |
| VPC + subnets + NAT | Network isolation | Backend/RDS in private subnets; only ALB is public; NAT lets private tasks pull ECR |
| IAM | Execution/task roles + CI deploy user | Least privilege: execution role reads SSM, task role writes logs, CI user pushes images + updates services |
| CloudWatch | Logs + 2 alarms | `awslogs` driver; ALB 5xx and RDS CPU alarms |

---

## ECS Fargate

Two services, one task each, `awsvpc` networking in private subnets.

```
backend:  256 CPU / 512 MB, port 4000, CMD: prisma migrate deploy && node dist/index.js
frontend: 256 CPU / 512 MB, port 80, nginx serving the SPA + reverse proxy
```

**Why Fargate, not Lambda:** a long-lived Node process owns a single Prisma connection pool. A Lambda-per-request model would open and close pools constantly and fight the connection lifecycle. The transactional reservation path needs a stable connection to RDS, not a cold start.

**Why one task:** a case-study starting point. `desired_count = 1` is honest and cheap. The Terraform `lifecycle { ignore_changes = [desired_count] }` lets autoscaling (when added) manage count without Terraform fighting it.

**Why `ignore_changes = [task_definition]`:** the CI deploy stage calls `ecs UpdateService` with a new task definition ARN. Without this ignore, Terraform would try to revert the image on the next apply. CI owns the image tag; Terraform owns the infrastructure.

---

## Application Load Balancer

One ALB, one HTTP listener (port 80), two target groups.

```
listener default action           → frontend target group (/)
listener rule priority 10          → backend  target group  (path /api/*, /health)
```

**Why an ALB, not a single target:** one DNS name serves both the SPA and the API. The path rule keeps `/health` on the backend so the ALB's own target-group health check and any external monitor hit the real application health. CloudFront is not used because the SPA is served from nginx inside the same VPC as the API; a CDN adds latency and cost for no benefit at this scale.

**Why HTTP only (for now):** ACM + HTTPS is a documented production improvement, not a case-study requirement. The ALB is the natural place to add it later.

---

## RDS PostgreSQL 15

```
ops-erp-db-dev — db.t3.micro, postgres 15, gp2 20GB, storage encrypted,
private subnets, publicly_accessible=false, skip_final_snapshot, backup_retention=0
```

**Why Postgres:** `SELECT FOR UPDATE` under READ COMMITTED is the exact primitive the concurrency design needs. DynamoDB has no equivalent row lock; its transaction model would force an optimistic-concurrency-with-retry design that is more code and more failure modes.

**Why small + single-AZ:** case-study economics. `db.t3.micro` is the cheapest RDS that runs Postgres 15. `backup_retention_period = 0` and `skip_final_snapshot = true` avoid the costs and confirmations of snapshots — flagged as improvements for production.

**Why private + SG-restricted:** the RDS security group accepts 5432 only from the backend ECS security group. The database is not reachable from the internet or even from the ALB.

---

## SSM Parameter Store

```
/ops-erp/dev/database_url   (SecureString, lifecycle ignore_changes = [value])
/ops-erp/dev/jwt_secret      (SecureString, lifecycle ignore_changes = [value])
```

**Why SSM, not task-def env vars:** ECS task definition environment variables are visible in the AWS console and in `describe-task-definition`. SSM SecureString is encrypted at rest, IAM-controlled, and injected at task start via the `secrets` array — the values never appear in Terraform state or CI logs.

**Why `ignore_changes = [value]`:** once a secret is created and later rotated by an operator, Terraform must not overwrite it on the next `apply` with the value it has in tfvars. The parameter's existence is Terraform-managed; its value is operator-managed.

---

## ECR

```
ops-erp-backend-dev / ops-erp-frontend-dev — MUTABLE tags, scan-on-push, keep last 10 images
```

**Why MUTABLE tags:** the CI pipeline re-tags `:latest` (and commit-sha tags) on every deploy. Mutable tags keep the deploy story simple. For stricter environments, switch to IMMUTABLE and always tag by commit SHA.

**Why scan-on-push:** free vulnerability scanning on every push.

---

## Networking (VPC, subnets, NAT)

```
VPC 10.1.0.0/16
  2 public subnets  (10.1.1.0/24, 10.1.2.0/24) — ALB lives here
  2 private subnets (10.1.10.0/24, 10.1.11.0/24) — ECS tasks + RDS live here
  IGW → public route table
  NAT Gateway (public-1) → private route table
```

**Why a NAT Gateway:** private tasks (ECS) must pull images from ECR and reach SSM, which are public AWS endpoints. Without NAT, a private task cannot egress. The NAT is the single egress point for private workloads.

**Why 2 AZs:** ALB target groups need at least two subnets; spreading across `ap-south-1a` and `ap-south-1b` is the minimum for resilience even though `desired_count = 1` only lands in one.

---

## IAM

Three identities, least-privilege each:

```
ecs_task_execution  → AmazonECSTaskExecutionRolePolicy (pull images, write logs)
                     + ssm:GetParameters on the two SecureStrings
                     + kms:Decrypt
ecs_task            → logs:CreateLogStream/PutLogEvents on the log group
ci_deploy (user)    → ECR push actions + ecs:UpdateService/DescribeServices
                     + iam:PassRole on the two task roles
```

**Why a dedicated CI user:** the deploy stage runs from GitLab, not from an assumed role. A least-privilege IAM user with only the actions the deploy needs is safer than a broad key. `iam:PassRole` is scoped to the two task roles only.

---

## CloudWatch

```
log group /ecs/ops-erp-dev  (30d in prod, 7d otherwise)
alarm: ALB 5xx > 10/min (1 min period, 2 eval periods)
alarm: RDS CPU > 80%   (5 min period, 2 eval periods)
```

**Why these two alarms:** ALB 5xx means the backend is erroring or unavailable; RDS CPU sustained over 80% means the small instance is the bottleneck. Both are the cheapest "something is wrong" signals for this shape of service.

**What is missing:** no alarms on backend 4xx/latency, no RDS connection-count alarm, no dashboard. See [12 — Observability](12-Observability.md).


---

**Read next:** [08 — Infrastructure as Code →](08-Infrastructure-as-Code.md)

[← Back to documentation index](README.md)
