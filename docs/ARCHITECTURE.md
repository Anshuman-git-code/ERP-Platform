# Architecture — Mini Operations ERP

## Local Development Stack

```
Browser (localhost:3000)
  │
  ▼
Vite Dev Server (:3000)
  │  /api/* → proxy
  ▼
Express API (:4000)
  │
  ▼
PostgreSQL 15 (:5432)
```

## Docker Compose Stack

```
Browser (localhost:3002)
  │
  ▼
nginx (ops_erp_frontend :80)
  │  /api/*  → proxy_pass BACKEND_URL/api/
  │  /health → proxy_pass BACKEND_URL/health
  │  /*      → SPA index.html fallback
  ▼
Express API (ops_erp_backend :4000)
  │  prisma migrate deploy on startup
  ▼
PostgreSQL 15 (ops_erp_postgres :5432)
```

## AWS Production Architecture

```
Internet
  │
  ▼
Application Load Balancer (public subnets)
  │  /api/* /health → Backend Target Group
  │  /*             → Frontend Target Group
  │
  ├──▶ ECS Fargate — Frontend Task (private subnet)
  │      nginx:1.27-alpine
  │      BACKEND_URL = http://<ALB_DNS>
  │
  └──▶ ECS Fargate — Backend Task (private subnet)
         node:20-alpine
         DATABASE_URL ←── AWS SSM SecureString
         JWT_SECRET   ←── AWS SSM SecureString
           │
           ▼
         RDS PostgreSQL 15 (private subnet, encrypted)
```

## Critical Transaction Flows

### 1. Stock Reservation (POST /api/orders/:id/confirm)

```
BEGIN TRANSACTION
  SELECT id, physicalQty, reservedQty FROM inventory
    WHERE id = ANY($inventoryIds)
    ORDER BY id          ← deterministic order prevents deadlock
    FOR UPDATE           ← row-level lock; concurrent request blocks here

  FOR each order item:
    availableQty = physicalQty - reservedQty
    IF availableQty < requested → collect into insufficientItems[]

  IF insufficientItems not empty:
    RAISE 422 → ROLLBACK (no stock change)

  FOR each order item:
    UPDATE inventory SET reservedQty += quantity

  UPDATE customer_orders SET status = 'CONFIRMED'
COMMIT
```

### 2. Transfer Dispatch (PATCH /api/transfers/:id/dispatch)

```
BEGIN TRANSACTION
  SELECT ... FROM inventory
    WHERE itemId = $itemId AND locationId = $sourceLocationId
    ORDER BY id FOR UPDATE

  totalAvailable = SUM(physicalQty - reservedQty)
  IF totalAvailable < transfer.quantity → RAISE 422 → ROLLBACK

  Deduct from source rows (FIFO)
  INSERT inventory_transaction (referenceKey = "dispatch-<id>-<invId>")

  UPDATE stock_transfers SET status = 'DISPATCHED'
COMMIT
```

### 3. Transfer Receipt (PATCH /api/transfers/:id/receive)

```
BEGIN TRANSACTION
  SELECT ... FROM stock_transfers WHERE id = $id FOR UPDATE
  IF status != 'DISPATCHED' → RAISE 400 (double-receipt guard)

  UPSERT inventory at destination (create if not exists)
  SELECT ... FROM inventory WHERE id = $destInvId FOR UPDATE
  UPDATE inventory SET physicalQty += transfer.quantity
  INSERT inventory_transaction (referenceKey = "receive-<id>")

  UPDATE stock_transfers SET status = 'RECEIVED'
COMMIT
```

## Security Controls

| Control | Implementation |
|---------|---------------|
| Authentication | JWT (HS256), 8h expiry, `JWT_SECRET` env var |
| Authorization | `authorize(...roles)` middleware, checked before every handler |
| Production secret guard | Server refuses to start if `JWT_SECRET` is the dev fallback |
| Secrets management (prod) | AWS SSM SecureString; never in task definition JSON |
| Non-root container | `appuser` in backend image |
| SQL injection | Prisma parameterized queries only |
| Input validation | express-validator on every route |
| CORS | Restricted to `CORS_ORIGIN` env var |

## Role Matrix

| Operation | ADMIN | OPERATIONS | SALES |
|-----------|-------|-----------|-------|
| Read all data | ✓ | ✓ | ✓ |
| Create locations | ✓ | — | — |
| Create/update items | ✓ | ✓ | — |
| Adjust inventory | ✓ | ✓ | — |
| Create work orders | ✓ | — | — |
| Advance work order status | ✓ | ✓ | — |
| Create transfers | ✓ | ✓ | — |
| Dispatch/receive transfers | ✓ | ✓ | — |
| Cancel transfers | ✓ | — | — |
| Create/confirm/cancel orders | ✓ | — | ✓ |
