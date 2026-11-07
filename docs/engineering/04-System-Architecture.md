# 04 — System Architecture

---

## 1. Logical Architecture

The system is organized into five logical layers, each with a clear responsibility boundary:

```
┌─────────────────────────────────────────────────────┐
│                  PRESENTATION LAYER                  │
│      React SPA (nginx) — 5 role-aware screens        │
└──────────────────────┬──────────────────────────────┘
                       │ HTTPS (HTTP today) /api/* calls
┌──────────────────────▼──────────────────────────────┐
│                   EDGE / ROUTING LAYER               │
│   ALB → path rules: /api/* & /health → backend;      │
│   everything else → frontend target group             │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                  API LAYER (Express)                 │
│   authenticate → authorize(...roles) → validate      │
│   8 route modules mounted under /api/*               │
└──────────────────────┬──────────────────────────────┘
                       │ Prisma Client (singleton)
┌──────────────────────▼──────────────────────────────┐
│                  DATA ACCESS LAYER                   │
│   Prisma ORM — typed queries + $transaction +        │
│   $queryRaw for SELECT ... FOR UPDATE                │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                  PERSISTENCE LAYER                   │
│   PostgreSQL 15 (RDS) — 9 tables, 5 enums,           │
│   unique constraints, indexes, row-level locking     │
└─────────────────────────────────────────────────────┘
```

---

## 2. Physical Architecture (AWS)

All resources reside in `ap-south-1` (Mumbai).

```
AWS Account (ap-south-1)
│
├── VPC: ops-erp-vpc-dev (10.1.0.0/16)
│   ├── 2 public subnets  (10.1.1.0/24, 10.1.2.0/24) — AZ a/b
│   ├── 2 private subnets (10.1.10.0/24, 10.1.11.0/24) — AZ a/b
│   ├── IGW + public route table
│   └── NAT Gateway (in public-1) + private route table
│
├── ALB: ops-erp-alb-dev (public subnets, HTTP:80)
│   ├── Listener default action → frontend target group
│   └── Listener rule (priority 10): /api/*, /health → backend target group
│
├── Target Groups
│   ├── ops-erp-be-tg-dev (4000, health /health → 200)
│   └── ops-erp-fe-tg-dev (80,   health / → 200)
│
├── ECS Cluster: ops-erp-cluster-dev (containerInsights enabled)
│   ├── Service: ops-erp-backend-dev  (Fargate, 256 CPU / 512 MB, desired 1, private subnet)
│   │   └── Task: backend (node:20-alpine, port 4000)
│   │         ENV: NODE_ENV=production, PORT=4000, CORS_ORIGIN, JWT_EXPIRES_IN=8h
│   │         SECRETS (from SSM): DATABASE_URL, JWT_SECRET
│   │         CMD: prisma migrate deploy && node dist/index.js
│   │
│   └── Service: ops-erp-frontend-dev (Fargate, 256 CPU / 512 MB, desired 1, private subnet)
│       └── Task: frontend (nginx:1.27-alpine, port 80)
│             ENV: BACKEND_URL = http://<ALB_DNS>  (envsubst at start)
│
├── RDS: ops-erp-db-dev (PostgreSQL 15, db.t3.micro)
│   private subnets, storage encrypted, publicly_accessible=false,
│   SG: 5432 from backend SG only
│
├── SSM SecureString
│   ├── /ops-erp/dev/database_url   (lifecycle ignore_changes)
│   └── /ops-erp/dev/jwt_secret      (lifecycle ignore_changes)
│
├── ECR
│   ├── ops-erp-backend-dev  (MUTABLE, scan-on-push, keep last 10)
│   └── ops-erp-frontend-dev (MUTABLE, scan-on-push, keep last 10)
│
├── IAM
│   ├── ecs_task_execution role (AmazonECSTaskExecutionRolePolicy + SSM read + KMS decrypt)
│   ├── ecs_task role (CloudWatch Logs on the log group)
│   └── ci_deploy user (ECR push + ecs:UpdateService/DescribeServices + iam:PassRole)
│
└── CloudWatch
    ├── Log group /ecs/ops-erp-dev (30d prod / 7d otherwise)
    ├── Alarm: ALB 5xx > 10/min
    └── Alarm: RDS CPU > 80% (10 min)
```

Three deployment shapes share one codebase:

```
Local dev:     Vite (:3000) ─proxy→ Express (:4000) → PostgreSQL (:5432)
Docker Compose: nginx (:3002) ─proxy→ Express (:4000) → PostgreSQL (:5432)   [host ports 3002/4002/5444]
AWS prod:      ALB → { nginx (frontend task), Express (backend task) } → RDS PostgreSQL 15
```

---

## 3. Component Responsibilities

### Frontend (React SPA on nginx)
- Five screens: Login, Inventory, Work Orders, Transfers, Orders, plus a dashboard
- Lazy-loaded page chunks via `React.lazy` + `Suspense`
- `AuthContext` rehydrates `token`/`user` from `localStorage` on mount
- Axios `apiClient` injects the Bearer token on every request and clears credentials + redirects to `/login` on a 401
- `ProtectedRoute` redirects unauthenticated users to `/login` and shows an "Access Denied" page for the wrong role
- `Layout` filters navigation by role and renders a role badge
- nginx serves the built SPA, proxies `/api/*` and `/health` to the backend (via `BACKEND_URL` envsubst), adds security headers, and falls back to `index.html` for client-side routes

### ALB
- Single HTTP listener on port 80
- Default action forwards to the frontend target group; a path rule forwards `/api/*` and `/health` to the backend target group
- Health checks gate traffic: backend `/health` → 200, frontend `/` → 200

### Express API (backend)
- `app.ts` wires global middleware (trust proxy, CORS, morgan logging, JSON body parsing, health route), mounts 8 route modules under `/api`, and installs the central error handler last
- `index.ts` is the process entry: loads `.env`, enforces the production JWT-secret guard, connects Prisma, listens on the port, and wires graceful shutdown on SIGTERM/SIGINT
- Each route module applies `authenticate` (router-level) then `authorize(...roles)` per handler, validates input with express-validator, and performs business logic with Prisma
- The `/health` endpoint (unauthenticated) runs `SELECT 1` and reports DB status + latency

### Middleware
| Middleware | Responsibility |
|---|---|
| `authenticate` | Verifies the Bearer JWT, attaches `req.user` (`userId`, `email`, `role`); 401 on missing/expired/invalid |
| `authorize(...roles)` | Higher-order: rejects if `req.user.role` not in the allowed set; 403 |
| `validate` | Reads express-validator results; 422 on any validation failure |
| `errorHandler` | Maps `AppError` to its status; Prisma `P2002`→409, `P2025`→404; unexpected→500 |

### Prisma (data access)
- Singleton client (reused via `globalThis` in dev to survive hot-reloads)
- Typed queries for all CRUD; `prisma.$transaction(async (tx) => …)` is the atomicity boundary for stock movements
- `tx.$queryRaw` drops to raw SQL exactly where `SELECT ... FOR UPDATE` is required

### PostgreSQL (RDS)
- Source of truth: 9 tables (`users`, `locations`, `items`, `inventory`, `inventory_transactions`, `work_orders`, `stock_transfers`, `customer_orders`, `order_items`) and 5 enums
- Enforces unique constraints (e.g., `inventory(itemId, locationId, batchNumber)`, `referenceKey`) and foreign keys
- Provides the row-level locking that makes concurrent reservation safe

### SSM
- Stores `DATABASE_URL` and `JWT_SECRET` as SecureString; the ECS execution role reads them at task start and injects them into the container as environment variables

### ECR
- Holds the backend and frontend images; lifecycle policy keeps the last 10

### IAM
- Execution role (pull images, read SSM, decrypt KMS), task role (write CloudWatch Logs), and a least-privilege `ci_deploy` user for the GitLab deploy stage

### CloudWatch
- Log group `/ecs/ops-erp-dev` for both tasks; two alarms (ALB 5xx, RDS CPU)

---

## 4. Request Lifecycle — Synchronous Read

```
1. Browser makes an API call; Axios attaches Authorization: Bearer <JWT>
2. ALB receives it; path matches /api/* → forwards to the backend target group
3. ECS backend task receives the request
4. express.json() parses the body; morgan logs the request via winston
5. router.use(authenticate) verifies the JWT and sets req.user
6. authorize(...roles) checks the role for this handler
7. validate runs the express-validator chain (422 on failure)
8. Handler calls Prisma (typed query) → PostgreSQL
9. Handler returns { success: true, data, meta? }
10. ALB forwards the response to the browser
```

---

## 5. Request Lifecycle — Atomic Reservation (the critical path)

```
1. SALES user clicks "Confirm" on a PENDING order
   PATCH /api/orders/:id/confirm  (Authorization: Bearer <JWT>)

2. authenticate + authorize(ADMIN, SALES) + validate

3. prisma.$transaction(async (tx) => {
     a. Read the order with its items; assert status === PENDING (else 400)
     b. Collect distinct inventoryIds, sort ascending
     c. tx.$queryRaw`SELECT id, "physicalQty", "reservedQty"
                    FROM inventory WHERE id = ANY($ids) ORDER BY id FOR UPDATE`
        ← rows locked; a concurrent confirm blocks here
     d. For each order item: available = physical − reserved;
        collect insufficient items where available < requested
     e. If any insufficient: throw AppError(422, ..., { insufficientItems })
        ← transaction rolls back; no reservation applied
     f. For each item: UPDATE inventory SET reservedQty += quantity
     g. UPDATE customer_orders SET status = CONFIRMED, confirmedAt = now()
   })  ← COMMIT releases all locks

4. Return 200 { success: true, data: confirmedOrder }
5. The blocked concurrent request now unblocks, re-reads the higher
   reservedQty, and fails with 422 if it would exceed availability
```

---

## 6. Dependency Graph

```
ALB
  └── depends on → VPC, public subnets, ALB security group

ECS Services (backend, frontend)
  └── depends on → ECS cluster, task definitions, target groups, private subnets, task SGs

Backend task
  └── depends on → ECR image, SSM parameters (secrets), execution role, task role, log group
  └── runtime depends on → RDS (DATABASE_URL)

Frontend task
  └── depends on → ECR image, execution role, log group
  └── runtime depends on → ALB DNS (BACKEND_URL)

RDS
  └── depends on → DB subnet group (private subnets), RDS security group

SSM parameters
  └── depend on → RDS endpoint (database_url value references it)

ci_deploy user
  └── depends on → ECR repos, ECS services, task roles (iam:PassRole)
```

Terraform resolves these via output references (e.g., `aws_lb.main.dns_name` is passed into the frontend task's `BACKEND_URL`).

---

## 7. Trust Boundaries

```
┌─────────────────────────────────┐
│         PUBLIC INTERNET          │
│  - GET /health (no auth)         │
│  - POST /api/auth/login          │
│  - everything else: 401          │
└───────────────┬─────────────────┘
                │ ALB + JWT validation at backend
┌───────────────▼─────────────────┐
│   AUTHENTICATED BOUNDARY         │
│   req.user populated            │
└───────────────┬─────────────────┘
                │ authorize(...roles) per route
┌───────────────▼─────────────────┐
│   AUTHORIZED BOUNDARY            │
│   role allowed for this action   │
└───────────────┬─────────────────┘
                │ Prisma → DB with least-privilege IAM
┌───────────────▼─────────────────┐
│   DATA BOUNDARY                  │
│   backend SG → RDS SG (5432)     │
│   row locks serialize mutations  │
└─────────────────────────────────┘
```

Network-level: only the ALB is internet-facing (port 80 from `0.0.0.0/0`). The backend accepts 4000 only from the ALB SG; the frontend accepts 80 only from the ALB SG; RDS accepts 5432 only from the backend SG. No resource is publicly reachable except the ALB. The backend enforces authorization on every route, so a forged or stolen token is still role-checked before any mutation reaches the database.


---

**Read next:** [05 — Business Flows →](05-Business-Flows.md)

[← Back to documentation index](README.md)
