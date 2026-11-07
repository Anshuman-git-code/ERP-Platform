# 08 — Infrastructure as Code

> All AWS infrastructure is defined in Terraform under `infra/terraform/`. There are no manual console resources. This document explains the repository shape, what each file provisions, how the resources depend on each other, and how a deploy applies them.

---

## 1. Repository Shape

Operation-ERP uses a **flat** Terraform layout (one file per concern), not the module-based layout some projects use. For a single environment and a small resource count, flat files are easier to read and grep; the cognitive cost of modules is not yet justified.

```
infra/terraform/
├── provider.tf        ← AWS provider, region, required version, default tags, (commented) S3 backend
├── variables.tf       ← every configurable input (region, env, name, CIDRs, ECS sizing, DB, secrets, images)
├── networking.tf      ← VPC, 2 public + 2 private subnets, IGW, NAT, route tables, 4 security groups
├── database.tf        ← RDS subnet group + Postgres 15 instance
├── iam.tf             ← execution role, task role, CI deploy user + policies
├── main.tf            ← SSM SecureString parameters (DATABASE_URL, JWT_SECRET)
├── compute.tf         ← ECR repos + lifecycle, ECS cluster, ALB + target groups + listener + rule, task defs, services
├── monitoring.tf      ← CloudWatch log group + ALB 5xx and RDS CPU alarms
├── outputs.tf         ← ALB DNS, ECR URLs, ECS names, RDS endpoint, log group, app URL
├── terraform.tfvars.example  ← template for secrets/images
└── terraform.tfvars          ← actual values (gitignored)
```

---

## 2. Provider & Defaults

`provider.tf` pins Terraform `>= 1.5.0` and the AWS provider `~> 5.55`, targets `ap-south-1`, and applies `default_tags { Project, Environment, ManagedBy = "terraform" }` to every resource. The S3 remote-state backend is present but commented out — local state is used for the case study; the comment block is the recipe for team use.

---

## 3. Variables

Everything tunable is a variable with a sensible default. Secrets (`db_password`, `jwt_secret`) are `sensitive = true` and are set via `TF_VAR_db_password` / `TF_VAR_jwt_secret` environment variables, not committed. Image URIs (`backend_image`, `frontend_image`) default to placeholders and are overridden by CI per deploy. The `environment` variable (default `dev`) is validated to be one of `dev|staging|prod` and threads through every resource name (e.g., `ops-erp-backend-dev`).

---

## 4. Networking

`networking.tf` builds the VPC (10.1.0.0/16), an IGW, two public and two private subnets across `ap-south-1a/b`, a NAT Gateway with an EIP in public-1, and two route tables (public → IGW, private → NAT).

Four security groups form the network trust chain:

```
alb      : ingress 80 from 0.0.0.0/0        egress all
backend  : ingress 4000 from alb SG          egress all
frontend : ingress 80   from alb SG          egress all
rds      : ingress 5432 from backend SG      egress all
```

Only the ALB is internet-facing. Backend, frontend, and RDS are reachable only from explicitly-allowed sources.

---

## 5. Database

`database.tf` creates a DB subnet group over the private subnets and a `db.t3.micro` Postgres 15 instance (`ops-erp-db-<env>`), encrypted storage, private-only access, `skip_final_snapshot`, `backup_retention_period = 0`. The instance ARN and identifier feed the SSM parameter and the RDS CPU alarm.

---

## 6. IAM

`iam.tf` defines three identities:

- **ecs_task_execution** — assumes `ecs-tasks.amazonaws.com`; gets the managed `AmazonECSTaskExecutionRolePolicy` (pull images, write logs) plus an inline policy allowing `ssm:GetParameters`/`GetParameter` on the two SSM ARNs and `kms:Decrypt`.
- **ecs_task** — same trust; inline policy for `logs:CreateLogStream`/`PutLogEvents` on the log group ARN.
- **ci_deploy** (user) — ECR push actions + `ecs:UpdateService`/`DescribeServices` + `iam:PassRole` on the two task roles.

---

## 7. SSM Parameters

`main.tf` creates `/ops-erp/<env>/database_url` and `/ops-erp/<env>/jwt_secret` as `SecureString`. The `database_url` value is composed from the RDS endpoint and the DB variables. Both have `lifecycle { ignore_changes = [value] }` so operator rotations survive `terraform apply`.

---

## 8. Compute

`compute.tf` is the largest file. It creates:

- **ECR** repos (backend, frontend) with MUTABLE tags, scan-on-push, and a lifecycle policy keeping the last 10 images each.
- **ECS cluster** with `containerInsights` enabled.
- **ALB** (public subnets, deletion-protected in prod) with a backend target group (health `/health`) and a frontend target group (health `/`).
- **HTTP listener** (port 80): default action → frontend; a priority-10 path rule forwards `/api/*` and `/health` → backend.
- **Backend task definition** (Fargate, awsvpc, 256/512): container `backend` on 4000; environment `NODE_ENV=production`, `PORT=4000`, `CORS_ORIGIN`, `JWT_EXPIRES_IN=8h`, `AWS_REGION`; `secrets` from SSM for `DATABASE_URL` and `JWT_SECRET`; `awslogs` to the log group; container healthCheck against `/health`.
- **Frontend task definition** (Fargate, 256/512): container `frontend` on 80; environment `BACKEND_URL = http://<ALB DNS>`; `awslogs` to the log group.
- **ECS services** (backend, frontend): Fargate, private subnets, no public IP, attached to their target groups, with `lifecycle { ignore_changes = [task_definition, desired_count] }`.

The `BACKEND_URL` reference (`http://${aws_lb.main.dns_name}`) is what lets the frontend's nginx proxy `/api/*` back through the ALB to the backend — the frontend task never talks to the backend directly; it goes through the ALB.

---

## 9. Monitoring

`monitoring.tf` creates the log group `/ecs/ops-erp-<env>` (30-day retention in prod, 7 otherwise) and two metric alarms: ALB 5xx > 10/min and RDS CPU > 80% (10 min).

---

## 10. Outputs

`outputs.tf` exposes `alb_dns_name`, `ecr_backend_url`, `ecr_frontend_url`, `ecs_cluster_name`, `ecs_backend_service`, `ecs_frontend_service`, `rds_endpoint` (sensitive), `cloudwatch_log_group`, and `app_url`. These are what CI/CD and operators consume after an apply.

---

## 11. Dependency Order (what Terraform resolves)

```
networking.tf  ─┐
                ├─→ database.tf ──→ main.tf (SSM database_url uses RDS endpoint)
                │
                └─→ compute.tf depends on:
                      networking (subnets, SGs)
                      database  (for SSM references)
                      iam       (execution + task roles)
                      main.tf   (SSM ARNs for secrets)
                      monitoring (log group for awslogs)

iam.tf depends on: monitoring (log group ARN), main.tf (SSM ARNs)
```

Terraform infers this from output references; you never specify creation order by hand.

---

## 12. Apply Flow

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars        # fill db_password, jwt_secret
terraform init                                       # downloads AWS provider
terraform plan                                        # review ~30 resources
terraform apply                                       # creates the footprint
terraform output alb_dns_name                         # → set as CORS_ORIGIN
```

After the first apply, set `backend_image`/`frontend_image` (from ECR) and `cors_origin` (the ALB DNS) in tfvars and apply again. The CI deploy stage later calls `aws ecs update-service --force-new-deployment` to roll the new task definition — it does not run `terraform apply`.


---

**Read next:** [09 — Security Architecture →](09-Security-Architecture.md)

[← Back to documentation index](README.md)
