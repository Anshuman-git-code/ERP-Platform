# Architecture — Mini Operations ERP

## Architecture Diagram

![Architecture](../assets/Mini%20Operations%20ERP%20Architecture%20and%20Transactions.png)

The diagram covers all three deployment modes and all three critical transaction flows.

---

## Local Development Stack

```
Browser (localhost:3000)
  │
  ▼
Vite Dev Server (:3000)
  │  /api/* → proxy
  ▼
Express API (:4000)  [Node 20, Prisma 5]
  │
  ▼
PostgreSQL 15 (:5432)
```

---

## Docker Compose Stack

```
Browser (localhost:3002)
  │
  ▼
nginx — ops_erp_frontend (:80)
  │  /api/*  → proxy_pass BACKEND_URL/api/
  │  /health → proxy_pass BACKEND_URL/health
  │  /*      → SPA index.html fallback
  ▼
Express API — ops_erp_backend (:4000)
  │  prisma migrate deploy on startup
  ▼
PostgreSQL 15 — ops_erp_postgres (:5432)
```

---

## AWS Production Architecture (LIVE — ap-south-1)

**Live URL:** http://ops-erp-alb-dev-330409874.ap-south-1.elb.amazonaws.com

```
Internet
  │
  ▼
ALB: ops-erp-alb-dev-330409874.ap-south-1.elb.amazonaws.com (public subnets)
  │  /api/* /health → Backend Target Group  (ops-erp-be-tg-dev)
  │  /*             → Frontend Target Group (ops-erp-fe-tg-dev)
  │
  ├──▶ ECS Fargate — ops-erp-frontend-dev (private subnet 10.1.10.97:80)
  │      nginx:1.27-alpine — Status: HEALTHY
  │      BACKEND_URL = http://<ALB_DNS>  [injected via envsubst at start]
  │
  └──▶ ECS Fargate — ops-erp-backend-dev (private subnet 10.1.10.134:4000)
         node:20-alpine — Status: HEALTHY
         DATABASE_URL ←── SSM SecureString /ops-erp/dev/database_url
         JWT_SECRET   ←── SSM SecureString /ops-erp/dev/jwt_secret
           │
           ▼
         RDS PostgreSQL 15 — ops-erp-db-dev
           private subnet, encrypted, not publicly accessible
```

---

## Critical Transaction Flows

### 1. Stock Reservation — `POST /api/orders/:id/confirm`

```
BEGIN TRANSACTION
  SELECT id, "physicalQty", "reservedQty"
  FROM inventory
  WHERE id = ANY($inventoryIds::text[])
  ORDER BY id          ← deterministic order prevents deadlock
  FOR UPDATE           ← explicit row lock; concurrent request blocks here

  FOR each order item:
    availableQty = physicalQty - reservedQty
    IF availableQty < requested → collect insufficientItems[]

  IF insufficientItems not empty:
    RAISE 422 → ROLLBACK  (no stock changed)

  FOR each order item (all passed):
    UPDATE inventory SET reservedQty += quantity

  UPDATE customer_orders SET status = 'CONFIRMED'
COMMIT
```

**Concurrency guarantee:** `SELECT FOR UPDATE` with `ORDER BY id` serialises competing requests at the database level. The second concurrent request blocks until the first commits, then re-reads the decremented `reservedQty` and correctly rejects if stock is exhausted.

### 2. Transfer Dispatch — `PATCH /api/transfers/:id/dispatch`

```
BEGIN TRANSACTION
  SELECT ... FROM inventory
    WHERE itemId = $itemId AND locationId = $sourceLocationId
    ORDER BY id FOR UPDATE

  totalAvailable = SUM(physicalQty - reservedQty)
  IF totalAvailable < transfer.quantity → RAISE 422 → ROLLBACK

  Deduct from source rows (FIFO order)
  INSERT inventory_transaction (referenceKey = "dispatch-<id>-<invId>")

  UPDATE stock_transfers SET status = 'DISPATCHED'
  ← destination inventory NOT touched
COMMIT
```

### 3. Transfer Receipt — `PATCH /api/transfers/:id/receive`

```
BEGIN TRANSACTION
  SELECT ... FROM stock_transfers WHERE id = $id FOR UPDATE
  ← Locks transfer row; serialises concurrent receive calls

  IF status != 'DISPATCHED' → RAISE 400
  ← Double-receipt guard: once RECEIVED, status != DISPATCHED → 400

  UPSERT inventory at destination (create if no record yet)
  SELECT ... FROM inventory WHERE id = $destId FOR UPDATE
  UPDATE inventory SET physicalQty += transfer.quantity

  INSERT inventory_transaction (referenceKey = "receive-<transferId>")
  UPDATE stock_transfers SET status = 'RECEIVED'
COMMIT
```

---

## Security Controls

| Control | Implementation |
|---|---|
| Authentication | JWT (HS256), 8h expiry, `JWT_SECRET` via SSM in production |
| Authorization | `authorize(...roles)` middleware on every route |
| Production secret guard | Server refuses to start if `JWT_SECRET` is the dev fallback |
| Secrets in production | AWS SSM SecureString — never in task definition JSON |
| Non-root container | `appuser` / `appgroup` in backend Docker image |
| SQL injection | Prisma parameterized queries only |
| Input validation | express-validator on every route, 422 on failure |
| CORS | Restricted to `CORS_ORIGIN` env var (ALB DNS in production) |

---

## Role Matrix

| Operation | ADMIN | OPERATIONS | SALES |
|---|---|---|---|
| Read all data | ✓ | ✓ | ✓ |
| Create locations | ✓ | — | — |
| Create / update items | ✓ | ✓ | — |
| Adjust inventory | ✓ | ✓ | — |
| Create work orders | ✓ | — | — |
| Advance work order status | ✓ | ✓ | — |
| Create transfers | ✓ | ✓ | — |
| Dispatch / receive transfers | ✓ | ✓ | — |
| Cancel transfers | ✓ | — | — |
| Create / confirm / cancel orders | ✓ | — | ✓ |
