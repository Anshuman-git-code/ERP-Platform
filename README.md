# Mini Operations ERP

**Fundsroom Infotech — Full-Stack Developer Technical Case Study 2**

A production-oriented Operations ERP covering the flow:

> Inventory → Work Order → Stock Check → Internal Transfer / Shortage → Customer Reservation

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
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
|------|------------|
| **ADMIN** | Full access; creates work orders, locations; can dispatch/receive/cancel transfers |
| **OPERATIONS** | Manages inventory, creates transfers, dispatches and receives transfers, advances work order status |
| **SALES** | Creates and confirms/cancels customer orders (stock reservation) |

---

## Database Schema

```
User
Location
Item            ← item catalogue (SKU, category, unit price)
Inventory       ← physicalQty, reservedQty per (item, location, batch)
                   availableQty = physicalQty - reservedQty (computed, never stored)
InventoryTransaction  ← audit log; referenceKey @unique for idempotency
WorkOrder       ← item required at location; shortageQty computed live
StockTransfer   ← REQUESTED → DISPATCHED → RECEIVED
CustomerOrder   ← PENDING → CONFIRMED → CANCELLED
OrderItem       ← references specific Inventory row
```

---

## Assignment Compliance

| Requirement | Status |
|-------------|--------|
| Authentication + RBAC | ✅ JWT + role middleware on every endpoint |
| Inventory (item, category, location, batch, physicalQty, reservedQty, availableQty) | ✅ |
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
| Test 1: Cannot reserve > available | ✅ orders.test.ts |
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

## Project Setup

### Prerequisites

- Node.js ≥ 20
- Docker + Docker Compose

### Quick Start (Docker Compose)

```bash
# 1. Clone and enter the repo
git clone <repo-url>
cd ops-erp

# 2. Start all services (postgres + backend + frontend)
docker compose up --build

# 3. Seed the database (first time only)
cd backend
DATABASE_URL="postgresql://ops_user:devpassword123@localhost:5444/ops_erp?schema=public" \
  npx ts-node --project tsconfig.seed.json prisma/seed.ts

# 4. Open the app
open http://localhost:3002
```

### Manual (local dev)

```bash
# Terminal 1 — start PostgreSQL (reuse CS1 container or start a new one)
docker run -d --name ops-postgres \
  -e POSTGRES_DB=ops_erp -e POSTGRES_USER=ops_user -e POSTGRES_PASSWORD=devpassword123 \
  -p 5432:5432 postgres:15-alpine

# Terminal 2 — backend
cd backend
cp .env.example .env          # edit DATABASE_URL if needed
npm install
npm run db:migrate            # applies migrations
npm run db:seed               # loads seed data
npm run dev                   # starts on :4000

# Terminal 3 — frontend
cd frontend
npm install
npm run dev                   # starts on :3000, proxies /api → :4000
```

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Default | Required |
|----------|---------|---------|
| `DATABASE_URL` | — | Yes |
| `JWT_SECRET` | dev fallback | Yes (prod refuses insecure default) |
| `JWT_EXPIRES_IN` | `8h` | No |
| `PORT` | `4000` | No |
| `NODE_ENV` | `development` | No |
| `CORS_ORIGIN` | `http://localhost:3000` | No |
| `LOG_LEVEL` | `info` | No |

### Frontend (build-time)

| Variable | Default |
|----------|---------|
| `VITE_API_BASE_URL` | `/api` |

---

## How to Run Tests

```bash
cd backend

# Ensure the test database exists and is migrated
# (replace port/credentials if different)
DATABASE_URL="postgresql://ops_user:devpassword123@localhost:5432/ops_erp_test?schema=public" \
  npx prisma migrate deploy

# Run all tests
npm test

# With coverage
npm run test:coverage
```

### Test Results (74/74 pass)

```
Test Suites: 5 passed
Tests:       74 passed
Time:        ~6s
```

| File | Tests | PDF Mandatory Tests |
|------|-------|-------------------|
| auth.test.ts | 11 | — |
| rbac.test.ts | 18 | Test 5 (unauthorized) |
| transfers.test.ts | 13 | Tests 2, 3, 4 |
| orders.test.ts | 14 | Test 1 (incl. concurrency) |
| inventory.test.ts | 18 | — |

---

## Test Credentials (seed data)

| Email | Password | Role |
|-------|----------|------|
| admin@opserp.dev | Password123! | ADMIN |
| ops@opserp.dev | Password123! | OPERATIONS |
| sales@opserp.dev | Password123! | SALES |

---

## API Documentation

See [docs/API.md](docs/API.md) for full endpoint reference with request/response examples.

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for transaction flow diagrams, AWS architecture, and role matrix.

## Engineering Decisions

See [docs/DECISIONS.md](docs/DECISIONS.md) for ADRs on concurrency, idempotency, and schema design.

## Known Limitations

See [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).

---

## CI/CD

GitLab CI pipeline (`.gitlab-ci.yml`):

```
validate  → lint + typecheck (backend + frontend)
test      → 74 integration tests against PostgreSQL service container
build     → tsc compile + vite build
package   → Docker images → GitLab Container Registry (main/develop)
deploy    → Retag → ECR → ECS update-service (main only, MANUAL gate)
```

## Terraform (AWS)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with real secrets and image URIs

terraform init
terraform plan
terraform apply
```

Resources: VPC, 2 public + 2 private subnets, NAT Gateway, ALB, ECS Fargate cluster (backend + frontend), RDS PostgreSQL 15, SSM SecureString parameters, CloudWatch log group + alarms, IAM roles, ECR repositories.
