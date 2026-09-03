# Mini Operations ERP

**Fundsroom Infotech — Full-Stack Developer Technical Case Study 2**

A production-oriented Operations ERP covering the flow:

> Inventory → Work Order → Stock Check → Internal Transfer / Shortage → Customer Reservation

---

## Live Deployment

| Resource | Value |
|---|---|
| **Live URL** | http://ops-erp-alb-dev-330409874.ap-south-1.elb.amazonaws.com |
| **Health URL** | http://ops-erp-alb-dev-330409874.ap-south-1.elb.amazonaws.com/health |
| **Region** | ap-south-1 (Mumbai) |
| **ECS Cluster** | ops-erp-cluster-dev |
| **Deployed Commit** | 989f045 |

---

## Repositories

| Platform | URL |
|---|---|
| GitHub | https://github.com/Anshuman-git-code/ERP-Platform |
| GitLab | https://gitlab.com/Anshuman-git-code/erp-platform |

---

## Architecture

![Architecture](assets/Mini%20Operations%20ERP%20Architecture%20and%20Transactions.png)

## GitLab CI/CD Pipeline

![CI/CD Pipeline Success](assets/CI-CD-Pipeline-Success.png)

## Application Screenshots

### Login
![Login](assets/login-page.png)

### Inventory — Physical, Reserved, Available Quantities
![Inventory](assets/inventory-page.png)

### Add Inventory Record (modal)
![Add Inventory Record](assets/Add-Inventory-Record.png)

### Work Orders — Shortage Calculation
![Work Orders](assets/Work%20Orders.png)

### Create New Work Order (modal)
![Create Work Order](assets/Create%20New%20Work%20Order.png)

### Internal Transfers — REQUESTED and DISPATCHED states
![Internal Transfers](assets/Internal%20Transfers%20Page.png)

### Request Stock Transfer (modal)
![Request Transfer](assets/Request%20Stock%20Transfer.png)

### Customer Orders — PENDING and CONFIRMED states
![Customer Orders](assets/Customer%20Orders%20Page.png)

### Create New Customer Order (modal — shows live availableQty)
![Create Customer Order](assets/Create%20New%20Customer%20Order.png)

---


The diagram covers:
- **Local Development Stack** — Vite dev server → Express → PostgreSQL
- **Docker Compose Stack** — nginx → backend → postgres containers
- **AWS Production** — ALB → ECS Fargate (frontend + backend) → RDS PostgreSQL 15, secrets via SSM
- **Critical Transaction Flows** — Stock Reservation (SELECT FOR UPDATE), Transfer Dispatch, Transfer Receipt (double-receipt guard)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full written architecture reference.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, React Router v6 |
| Backend | Node.js 20, Express 4, TypeScript |
| ORM | Prisma 5 |
| Database | PostgreSQL 15 |
| Auth | JWT (jsonwebtoken), bcryptjs |
| Validation | express-validator |
| Testing | Jest 29, ts-jest, Supertest |
| Containerisation | Docker, Docker Compose |
| CI/CD | GitLab CI (5-stage pipeline) |
| IaC | Terraform (AWS ECS Fargate, ALB, RDS, SSM) |

---

## Roles

| Role | Permissions |
|---|---|
| **ADMIN** | Full access; creates work orders, locations; manages transfers |
| **OPERATIONS** | Manages inventory, creates/dispatches/receives transfers, advances work order status |
| **SALES** | Creates and confirms/cancels customer orders (stock reservation) |

---

## Assignment Compliance

| Requirement | Status |
|---|---|
| Authentication + RBAC | ✅ JWT + role middleware on every endpoint |
| Inventory (item, category, location, batch, physicalQty, reservedQty, availableQty) | ✅ |
| availableQty = physicalQty − reservedQty (computed, never stored) | ✅ |
| Prevent negative stock | ✅ |
| Prevent reservation beyond available | ✅ SELECT FOR UPDATE |
| Prevent duplicate inventory transaction | ✅ referenceKey @unique |
| Work Order (ID, location, item, required qty, assigned user, status) | ✅ |
| Work Order statuses: ASSIGNED → IN_PROGRESS → COMPLETED | ✅ forward-only |
| Shortage auto-calculation | ✅ computed at read time |
| Transfer (ID, source, dest, item, qty, status) | ✅ |
| Dispatch reduces source; does NOT increase dest | ✅ |
| Receipt increases dest; prevents double-receipt | ✅ |
| Customer Order + reservation | ✅ |
| Concurrent reservation safety | ✅ SELECT FOR UPDATE + deterministic lock order |
| Test 1: Cannot reserve > available | ✅ orders.test.ts (incl. concurrency) |
| Test 2: Cannot transfer > available | ✅ transfers.test.ts |
| Test 3: Dest stock only after receipt | ✅ transfers.test.ts |
| Test 4: Same transfer not received twice | ✅ transfers.test.ts |
| Test 5: Unauthorized user blocked | ✅ rbac.test.ts |
| 5 frontend screens | ✅ Login, Inventory, Work Orders, Transfers, Orders |
| Docker + Compose | ✅ |
| API documentation | ✅ docs/API.md |
| Database schema | ✅ backend/prisma/schema.prisma |
| Git history | ✅ meaningful commits per phase |

---

## Database Schema

```
User            ← ADMIN / OPERATIONS / SALES
Location        ← unique name, address
Item            ← SKU, category, unitPrice
Inventory       ← physicalQty, reservedQty, @@unique(item+location+batch)
                   availableQty = physicalQty - reservedQty (computed, never stored)
InventoryTransaction ← audit log; referenceKey @unique (idempotency)
WorkOrder       ← item required at location; shortageQty computed live
StockTransfer   ← REQUESTED → DISPATCHED → RECEIVED
CustomerOrder   ← PENDING → CONFIRMED → CANCELLED
OrderItem       ← references specific Inventory row
```

---

## Quick Start — Docker Compose

```bash
git clone https://github.com/Anshuman-git-code/ERP-Platform.git
cd ERP-Platform

docker compose up --build

# Seed the database (first time, run from backend/)
cd backend
DATABASE_URL="postgresql://ops_user:devpassword123@localhost:5444/ops_erp?schema=public" \
  npx ts-node --project tsconfig.seed.json prisma/seed.ts

# Open: http://localhost:3002
```

---

## Quick Start — Local Development

```bash
# Terminal 1 — PostgreSQL
docker run -d --name ops-postgres \
  -e POSTGRES_DB=ops_erp -e POSTGRES_USER=ops_user -e POSTGRES_PASSWORD=devpassword123 \
  -p 5432:5432 postgres:15-alpine

# Terminal 2 — Backend
cd backend
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev          # :4000

# Terminal 3 — Frontend
cd frontend
npm install
npm run dev          # :3000
```

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Min 64 chars; production refuses insecure default |
| `JWT_EXPIRES_IN` | No | Default `8h` |
| `PORT` | No | Default `4000` |
| `CORS_ORIGIN` | No | Default `http://localhost:3000` |
| `LOG_LEVEL` | No | Default `info` |

---

## How to Run Tests

```bash
cd backend
npm test

# With coverage
npm run test:coverage
```

### Test Results (74/74 pass)

```
Test Suites: 5 passed
Tests:       74 passed
Time:        ~5-7s
```

| File | Tests | PDF Mandatory Tests |
|---|---|---|
| auth.test.ts | 11 | — |
| rbac.test.ts | 18 | Test 5 (unauthorized) |
| transfers.test.ts | 13 | Tests 2, 3, 4 |
| orders.test.ts | 14 | Test 1 (incl. concurrency) |
| inventory.test.ts | 18 | — |

---

## Test Credentials

| Email | Password | Role |
|---|---|---|
| admin@opserp.dev | Password123! | ADMIN |
| ops@opserp.dev | Password123! | OPERATIONS |
| sales@opserp.dev | Password123! | SALES |

---

## CI/CD Pipeline

GitLab CI pipeline (`.gitlab-ci.yml`) — 5 stages:

```
validate  → lint + typecheck (backend + frontend)
test      → 74 integration tests against PostgreSQL service container
### Pipeline Success

![CI/CD Pipeline Success](assets/CI-CD-Pipeline-Success.png)

<!-- CI_CD_SCREENSHOT_PLACEHOLDER -->
> **Note:** Add screenshot of successful GitLab CI/CD pipeline here.
> Place the screenshot at `assets/CI-CD-Pipeline-Success.png` and replace this block with:
> `![CI/CD Pipeline](assets/CI-CD-Pipeline-Success.png)`

### Required GitLab CI/CD Variables

Set these in GitLab → Settings → CI/CD → Variables (masked + protected):

| Variable | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM `ci_deploy` user access key |
| `AWS_SECRET_ACCESS_KEY` | IAM `ci_deploy` user secret key |
| `ECR_REGISTRY` | `690081480550.dkr.ecr.ap-south-1.amazonaws.com` |
| `ECR_REPO_BACKEND` | `ops-erp-backend-dev` |
| `ECR_REPO_FRONTEND` | `ops-erp-frontend-dev` |
| `ECS_CLUSTER` | `ops-erp-cluster-dev` |
| `ECS_SERVICE_BACKEND` | `ops-erp-backend-dev` |
| `ECS_SERVICE_FRONTEND` | `ops-erp-frontend-dev` |

---

## API Documentation

See [docs/API.md](docs/API.md) for the full endpoint reference with request/response examples.

---

## Architecture & Engineering Decisions

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — transaction flow diagrams, AWS architecture, role matrix
- [docs/DECISIONS.md](docs/DECISIONS.md) — ADRs: SELECT FOR UPDATE, availableQty, idempotency, batchNumber
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — local Docker + AWS Terraform/ECS deployment steps
- [docs/E2E_VERIFICATION.md](docs/E2E_VERIFICATION.md) — all 5 mandatory test results, live smoke test evidence
- [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) — no JWT refresh, no rate limiting, no frontend tests

---

## Terraform (AWS)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Fill in db_password, jwt_secret, image URIs

terraform init
terraform plan
terraform apply
```

Provisions: VPC, 2 public + 2 private subnets, NAT, ALB, ECS Fargate cluster (backend + frontend), RDS PostgreSQL 15, SSM SecureString params, CloudWatch, IAM roles, ECR repositories.
