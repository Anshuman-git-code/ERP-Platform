# 18 — Requirements to Architecture

> Each functional and non-functional requirement traces to the architectural element that realises it. This is the traceability that lets you answer "where is this requirement implemented?" without guessing.

---

## 1. Functional Requirements → Implementation

| Requirement | Implemented by |
|---|---|
| FR-01 JWT auth before authorization | `middleware/auth.ts` `authenticate` (router-level on every route module) |
| FR-02 Role classification | `Role` enum; `role` on `User`; JWT `role` claim |
| FR-03 JWT carries userId/email/role, 8h TTL | `routes/auth.ts` `jwt.sign({ userId, email, role }, JWT_SECRET, { expiresIn })` |
| FR-04 authenticate + authorize on every route | each route file: `router.use(authenticate)` + `authorize(...roles)` per handler; `/health` and `/api/auth/login` excluded |
| FR-05 refuse to start with insecure secret in prod | `index.ts` production guard → `process.exit(1)` |
| FR-06 one inventory row per (item, location, batch) | `Inventory @@unique([itemId, locationId, batchNumber])` |
| FR-07 batchNumber defaults to DEFAULT | `batchNumber String @default("DEFAULT")` |
| FR-08 availableQty computed, never stored | `withAvailable()` helper; no `availableQty` column |
| FR-09 no negative stock, physical ≥ reserved | `inventory.ts` adjust guards; dispatch deducts only `available` |
| FR-10 audit transaction per stock change | `InventoryTransaction` written in every mutation path |
| FR-11 referenceKey idempotency | `referenceKey String? @unique`; system keys `dispatch-*`, `receive-*` |
| FR-12 ADMIN creates work orders; ADMIN/OPS advance | `workOrders.ts`: POST `authorize(ADMIN)`, status PATCH `authorize(ADMIN, OPERATIONS)` |
| FR-13 shortageQty computed live | `getInventoryAvailability()` + `max(requiredQty − availableQty, 0)` on read |
| FR-14 forward-only work-order status | `transitions` map in `workOrders.ts` status handler |
| FR-15 snapshot itemName/itemSku | copied at creation in work order, transfer, order item |
| FR-16 transfer between different locations | `transfers.ts` POST rejects `source === dest` |
| FR-17 dispatch reduces source only | `transfers.ts` dispatch deducts source rows; destination untouched |
| FR-18 dispatch rejects insufficient | `Σ(physical − reserved) < quantity` → 422 |
| FR-19 receipt increases dest, only DISPATCHED | `transfers.ts` receive: status check + increment dest |
| FR-20 cancel: ADMIN only, REQUESTED only | `transfers.ts` cancel `authorize(ADMIN)` + status check |
| FR-21 dispatch/receipt audit with deterministic key | `referenceKey = dispatch-<id>-<rowId>` / `receive-<id>` |
| FR-22 create order = PENDING, no reservation | `orders.ts` POST creates order, does not touch inventory |
| FR-23 confirm reserves atomically | `orders.ts` confirm: `FOR UPDATE`, increment `reservedQty` |
| FR-24 confirm rejects insufficient with detail | 422 + `details.insufficientItems[]` |
| FR-25 concurrent confirms can't over-reserve | `SELECT … FOR UPDATE` `ORDER BY id` serialises |
| FR-26 cancel CONFIRMED releases; PENDING status only | `orders.ts` cancel: decrements if CONFIRMED |
| FR-27 collision-safe order numbers | `ORD-${Date.now()}-${random5}` |
| FR-28 unauthenticated /health | `app.ts` `/health` route before auth middleware |

---

## 2. Non-Functional Requirements → Implementation

| Requirement | Implemented by |
|---|---|
| NFR-01 graceful DB outage | `/health` returns 503; `index.ts` exits on connect failure (ECS restarts) |
| NFR-02 frontend independent of backend | separate ECS services; SPA on nginx; only `/api/*` depends on backend |
| NFR-03 correct under concurrency without pre-provisioning | row-level locks; no capacity planning needed for correctness |
| NFR-04 no connection-pool exhaustion in dev | `lib/prisma.ts` singleton via `globalThis` |
| NFR-05 pagination bounds read size | page/limit on all list endpoints |
| NFR-06 short reservation transaction, deadlock-free | `FOR UPDATE` + `ORDER BY id`; lock-check-update-commit |
| NFR-07 secrets never in plaintext env | SSM SecureString + task `secrets` array |
| NFR-08 backend authorization independent of frontend | `authorize(...roles)` on every route |
| NFR-09 non-root container | backend Dockerfile `USER appuser` |
| NFR-10 all infra as code | `infra/terraform/*` (no console resources) |
| NFR-11 schema-first | `prisma/schema.prisma` + `prisma generate` |
| NFR-12 input validation before logic | express-validator chain + `validate` middleware |
| NFR-13 physical ≥ 0, reserved ≥ 0, physical ≥ reserved | adjust guards; dispatch FIFO; confirm availability check |
| NFR-14 concurrent reservation serialised at row level | `SELECT … FOR UPDATE` |
| NFR-15 transfer received exactly once | transfer-row lock + `status === DISPATCHED` check |

---

## 3. Constraints → Architectural Consequence

| Constraint | Consequence in the architecture |
|---|---|
| Single region (ap-south-1) | All resources in one region; no cross-region replication |
| One ECS task per service | `desired_count = 1`; no rolling deploy; `ignore_changes = [desired_count]` for future autoscaling |
| ALB HTTP only | listener on 80; no ACM cert; flagged improvement |
| Local Terraform state | S3 backend commented in `provider.tf`; flagged improvement |
| No JWT refresh | 8h tokens; frontend 401-redirect; flagged improvement |
| No payment | orders reserve stock only |
| Seed-only users | no signup endpoint; `prisma/seed.ts` provisions roles |
| No partial receipt | receive is all-or-nothing of `quantity` |
| No stock reversal on cancel | cancel only from REQUESTED; DISPATCHED cancel rejected |

---

## 4. The Trace That Matters Most

The single most important trace is the one that guarantees NFR-14 and NFR-15:

```
FR-23 (confirm reserves atomically)
  → orders.ts confirm handler
    → prisma.$transaction(async (tx) => { ... })              [atomicity]
      → tx.$queryRaw`SELECT … ORDER BY id FOR UPDATE`          [NFR-14: serialise]
      → availability check per item                            [FR-24, NFR-13]
      → tx.inventory.update reservedQty += quantity           [FR-23]
      → tx.customerOrder.update status = CONFIRMED            [FR-23]
    → COMMIT (locks released)
  → 422 with insufficientItems on failure                     [FR-24, FR-25]
```

And for double-receipt (NFR-15):

```
FR-19 (receipt increases dest, only DISPATCHED)
  → transfers.ts receive handler
    → prisma.$transaction
      → tx.$queryRaw`SELECT … FROM stock_transfers WHERE id=? FOR UPDATE`  [serialise receives]
      → status === DISPATCHED check                                           [NFR-15]
      → find/create dest inventory + FOR UPDATE
      → tx.inventory.update physicalQty += quantity
      → tx.inventoryTransaction.create referenceKey=receive-<id>             [FR-21, idempotency]
      → tx.stockTransfer.update status = RECEIVED
```

Every other requirement is realised by a single, identifiable file. These two are realised by a protocol that spans the schema (the unique `referenceKey`, the `id` primary keys worth locking), the data access (`$queryRaw` for `FOR UPDATE`), and the route (the transaction boundary and the checks). That span is why the concurrency design is the architectural centerpiece.


---

**Read next:** [19 — Complete Build Journal →](19-Complete-Build-Journal.md)

[← Back to documentation index](README.md)
