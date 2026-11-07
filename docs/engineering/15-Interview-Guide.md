# 15 — Interview Guide

> Questions an interviewer might ask about this system, with concise, code-accurate answers. Grouped by theme. The goal is to demonstrate that every answer traces back to a real file and a real decision.

---

## Architecture & Stack

**Q: Why a containerized monolith instead of serverless?**
A long-lived Node process owns a stable Prisma connection pool to RDS. A Lambda-per-request model would open/close pools constantly and fight the connection lifecycle. The transactional reservation path needs a stable DB connection, not a cold start. ECS Fargate runs the same Docker images as local Compose, so there's one deployment artifact.

**Q: Why Postgres and not DynamoDB?**
The core invariant — `reservedQty` never exceeds `physicalQty` under concurrency — needs row-level locking and ACID transactions. `SELECT ... FOR UPDATE` under READ COMMITTED is the exact primitive. DynamoDB has no row lock; it would force an optimistic-concurrency-with-retry design that's more code and more failure modes.

**Q: Why Prisma?**
Schema-first; `prisma generate` emits the types the whole backend uses; `$transaction` gives a clean atomic boundary; `$queryRaw` is the scoped escape hatch for `FOR UPDATE` that the builder can't express.

**Q: Why Express and not NestJS?**
The stack was already proven and understood. NestJS would spend the budget on scaffolding. Express keeps the architecture flat and auditable — every route is visible.

---

## Concurrency (the main event)

**Q: Walk me through what happens when two users confirm orders against the same shelf at the same time.**
Both call `PATCH /api/orders/:id/confirm`. Each opens a `prisma.$transaction`. Both run `SELECT id, physicalQty, reservedQty FROM inventory WHERE id = ANY($ids) ORDER BY id FOR UPDATE`. The first to acquire the lock proceeds; the second blocks. The first checks availability, increments `reservedQty`, commits, and releases the lock. The second unblocks, re-reads the now-higher `reservedQty`, re-checks availability, and — if combined demand exceeds `physicalQty` — throws `AppError(422, ..., { insufficientItems })`, rolling back. Exactly one wins; over-reservation is impossible.

**Q: Why `ORDER BY id` on the `FOR UPDATE`?**
To prevent deadlocks. Any two transactions that overlap lock the same rows in the same global (ascending id) order, so a wait-cycle can't form. Without it, two transactions locking rows in opposite orders would deadlock under contention.

**Q: How do you guarantee a transfer can't be received twice?**
On receive, I `SELECT ... FOR UPDATE` the `stock_transfers` row itself inside the transaction, then check `status === DISPATCHED`. Two concurrent receives serialise on the row lock; the first sets status to RECEIVED and commits; the second then reads RECEIVED and fails the check with 400. It's a structural guard, not a flag.

**Q: Why is `availableQty` not a column?**
A stored column would be a third number that must stay in sync with `physicalQty` and `reservedQty`. Any partial update corrupts it silently. Computing `physical − reserved` on read makes the invariant true by construction. The cost is trivial arithmetic.

**Q: What isolation level does the reservation run at?**
READ COMMITTED (Postgres default, Prisma's `$transaction` default). The `FOR UPDATE` lock is what serialises, not the isolation level — `FOR UPDATE` blocks a second reader of a locked row until commit even under READ COMMITTED.

**Q: What happens if the dispatch request is retried?**
Each deducted source row writes an `InventoryTransaction` with `referenceKey = dispatch-<transferId>-<rowId>`. A retry reuses the same key; the second insert hits the unique constraint → Prisma P2002 → 409. Stock is not deducted twice. The client can treat 409 on a retried idempotent op as "already applied."

---

## Data Model

**Q: Why does `batchNumber` default to `'DEFAULT'` instead of NULL?**
Postgres `NULL ≠ NULL` for uniqueness, so a nullable batch would allow multiple "no-batch" rows for the same item+location, breaking `@@unique([itemId, locationId, batchNumber])`. The non-null sentinel makes the constraint enforce exactly one no-batch row.

**Q: Why are `itemName`/`itemSku` snapshotted onto work orders and transfers?**
If an item is renamed later, historical records still show the name that was correct when they were created. The live `itemId` reference is kept for navigation; the display fields are frozen for audit accuracy.

**Q: Why is the order number `ORD-<timestamp>-<random>`?**
`COUNT+1` races under concurrent `POST /api/orders` — two reads see the same count and produce the same number, hitting P2002. The timestamp+random suffix is statistically unique without a DB sequence or extra locking.

**Q: How is shortage calculated?**
`shortageQty = max(requiredQty − availableQty, 0)`, where `availableQty` is the sum of `physicalQty − reservedQty` across all inventory rows for the item at that location. It's computed live on every read; it's not stored.

---

## Security

**Q: How is authorization enforced?**
`authenticate` verifies the Bearer JWT and sets `req.user`; `authorize(...roles)` is a higher-order middleware applied per handler that rejects wrong-role with 403. The frontend filters nav by role for UX, but the backend is the authority — a `curl` from a SALES user to `POST /api/transfers` is rejected by the server.

**Q: What happens with an insecure JWT secret in production?**
`index.ts` checks `NODE_ENV === 'production'` and refuses to start (`process.exit(1)`) if `JWT_SECRET` is missing or is the dev fallback. An insecure secret can't run in prod.

**Q: How are secrets handled in production?**
`DATABASE_URL` and `JWT_SECRET` live in SSM SecureString and are injected via the ECS task `secrets` array using the execution role's `ssm:GetParameters` + `kms:Decrypt`. They never appear in task-def JSON or Terraform state. `lifecycle { ignore_changes = [value] }` keeps operator rotations from being reverted.

---

## Failure & Operations

**Q: What happens if the database is down?**
At startup, `prisma.$connect()` failure exits the task (ECS restarts it). At request time, a DB error becomes a 500 envelope. At health check, `/health` runs `SELECT 1` and returns 503 with `database.status = 'unreachable'`; the ALB marks the target unhealthy and stops sending traffic.

**Q: What's not protected?**
No HTTPS (JWT in cleartext), no rate limiting, no token revocation, single-AZ RDS with no backups, one task per service (no zero-downtime deploy), no frontend tests. The hot path (reservation/dispatch/receipt/adjust) is correct by design; the gaps are operational, not correctness.

**Q: How would you scale this?**
Raise `desired_count` to 2+ for zero-downtime rolling deploys; add an ECS auto-scaling policy on CPU; enable multi-AZ RDS; add an HTTPS listener with ACM. The concurrency design already scales horizontally — the locks are row-level, so more tasks don't change correctness.

---

## Trade-offs & Judgement

**Q: What's the biggest trade-off you accepted?**
Single-AZ RDS with `backup_retention_period = 0` and one ECS task per service. I prioritised "the numbers are always right" (correctness on the hot path) over "the system never goes down" (availability). For a data-integrity operations tool, that's the right priority — an over-reservation is a worse failure than a brief outage.

**Q: If you had one more day, what would you do?**
Enable HTTPS at the ALB. It's low effort, it's Terraform-only, and it closes the one genuinely unsafe gap (JWT in cleartext). Everything else is "incomplete but safe."

---

## Modification Scenarios (design-on-the-spot)

**Q: How would you add partial transfer receipt?**
Add a `receivedQty` on `StockTransfer` (default 0). On receive, accept a `quantity` ≤ remaining; increment `receivedQty` and the destination; when `receivedQty === quantity`, set status to RECEIVED. The double-receipt guard generalises to "only DISPATCHED or partially-received transfers can receive." Each partial receipt needs its own `referenceKey` (e.g., `receive-<transferId>-<seq>`).

**Q: How would you add a damaged-stock field?**
Add `damagedQty Int @default(0)` to `Inventory`; `availableQty` becomes `physical − reserved − damaged`. A damage event writes an `InventoryTransaction(OUT)` and increments `damagedQty` inside a `FOR UPDATE` transaction. Display `damagedQty` separately so it's not confused with consumed stock.

**Q: How would you add JWT refresh?**
Add a `refreshToken` (longer TTL, stored HttpOnly cookie) issued alongside the access token. Add `POST /api/auth/refresh` that verifies the refresh token and issues a new access token. Move token storage from `localStorage` to the HttpOnly cookie to remove the XSS-exfiltration risk.

**Q: How would you add a user-management screen?**
Add `/api/users` CRUD (ADMIN only) with `create`, `list`, `update` (role/isActive), and a signup endpoint with role assignment. Reuse `authenticate` + `authorize(ADMIN)`. The seed script already shows the create pattern; expose it as routes.

**Q: How would you reverse stock on cancelling a DISPATCHED transfer?**
Add a "recall" action: from DISPATCHED only, inside a transaction, `FOR UPDATE` the source rows, increment `physicalQty` back by the un-received quantity, write an `InventoryTransaction(IN)` with `referenceKey = recall-<transferId>`, set status to CANCELLED. This is a new lifecycle transition (`DISPATCHED → CANCELLED` via recall), distinct from the REQUESTED-only cancel that exists today.


---

**Read next:** [16 — API and DB Design →](16-API-and-DB-Design.md)

[← Back to documentation index](README.md)
