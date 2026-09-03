# Deployment Guide — Mini Operations ERP

## Local (Docker Compose)

```bash
# 1. Start all services
docker compose up --build

# 2. Seed the database (first time only — run from repo root)
cd backend
DATABASE_URL="postgresql://ops_user:devpassword123@localhost:5444/ops_erp?schema=public" \
  npx ts-node --project tsconfig.seed.json prisma/seed.ts

# 3. App URLs
#   Frontend: http://localhost:3002
#   Backend:  http://localhost:4002
#   DB port:  localhost:5444
```

## AWS (Terraform + ECS Fargate)

### Prerequisites

- AWS CLI v2 configured (`aws configure`)
- Terraform >= 1.5.0
- Docker + ECR access
- GitLab CI/CD variables set (see below)

### Step 1 — Provision Infrastructure

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — fill in db_password, jwt_secret

terraform init
terraform plan    # review before applying
terraform apply

# Capture outputs needed for next steps:
terraform output alb_dns_name
terraform output ecr_backend_url
terraform output ecr_frontend_url
```

### Step 2 — Push Docker Images to ECR

```bash
# Authenticate
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin <ECR_REGISTRY>

# Build and push backend
docker build -t <ECR_REPO_BACKEND>:latest ./backend
docker push <ECR_REPO_BACKEND>:latest

# Build and push frontend
docker build -t <ECR_REPO_FRONTEND>:latest ./frontend
docker push <ECR_REPO_FRONTEND>:latest
```

### Step 3 — Update Terraform with Image URIs

```bash
# Edit terraform.tfvars
backend_image  = "<ECR_REGISTRY>/<ECR_REPO_BACKEND>:latest"
frontend_image = "<ECR_REGISTRY>/<ECR_REPO_FRONTEND>:latest"
cors_origin    = "http://<ALB_DNS>"

terraform apply
```

### Step 4 — Run Database Migrations

After the backend ECS task starts, run migrations. The backend CMD already runs
`prisma migrate deploy` at container startup — check CloudWatch logs to confirm.

To seed the production database, connect via a bastion host or ECS Exec:

```bash
aws ecs execute-command \
  --cluster ops-erp-cluster-dev \
  --task <TASK_ARN> \
  --container backend \
  --interactive \
  --command "node -e 'require(\"./dist/index.js\")'"
```

### Step 5 — Set GitLab CI/CD Variables

In GitLab → Settings → CI/CD → Variables (masked + protected):

| Variable | Description |
|----------|-------------|
| `AWS_ACCESS_KEY_ID` | CI deploy user access key |
| `AWS_SECRET_ACCESS_KEY` | CI deploy user secret key |
| `ECR_REGISTRY` | ECR registry URL |
| `ECR_REPO_BACKEND` | ECR repository name for backend |
| `ECR_REPO_FRONTEND` | ECR repository name for frontend |
| `ECS_CLUSTER` | ECS cluster name (from tf output) |
| `ECS_SERVICE_BACKEND` | Backend ECS service name |
| `ECS_SERVICE_FRONTEND` | Frontend ECS service name |

After that, merging to `main` will build, push, and deploy automatically (deploy stage is manual-gate).

## Environment Variables Reference

See `backend/.env.example` for the complete list. Critical ones for production:

| Variable | Source in Prod |
|----------|---------------|
| `DATABASE_URL` | AWS SSM SecureString |
| `JWT_SECRET` | AWS SSM SecureString |
| `CORS_ORIGIN` | Terraform var / ECS task def |
| `NODE_ENV` | Hardcoded `production` in task def |
