# 10 — Transaction & Concurrency Workflow

> In a serverless event system the defining mechanism is the event bus. In this system it is the database transaction with row locking. This document is the deep dive on the workflow that makes concurrent stock movements safe — the most important engineering in the project.

---

## 1. Why This Exists

The naive flow is: read `reservedQty`, add the order quantity, write it back. Under READ COMMITTED (Postgres's default, and Prisma's `$transaction` isolation), two concurrent confirms both read the same `reservedQty`, both add, both write — and the result is the last writer's value, not the sum. Stock is over-reserved.

```
T = 0:  reservedQty = 0,  physicalQty = 10,  available = 10
T = 1:  Request A reads reservedQty = 0
T = 2:  Request B reads reservedQty = 0
T = 3:  Request A computes 0 + 8 = 8, writes reservedQty = 8  (available = 2)
T = 4:  Request B computes 0 + 8 = 8, writes reservedQty = 8  (available = 2 again!)
Result: two orders of 8 against 10 physical — 16 promised. Over-reserved.
```

The fix is not application logic; it is a database lock that makes T2's read wait until T3 commits.

---

## 2. The Primitive: SELECT ... FOR UPDATE

```sql
SELECT id, "physicalQty", "reservedQty"
FROM inventory
WHERE id = ANY($1)
ORDER BY id
FOR UPDATE
```

`FOR UPDATE` acquires a row-level lock on the matched rows for the duration of the transaction. A second transaction running the same query on the same rows blocks until the first commits (or rolls back). When it unblocks, it re-reads the committed values — so the second confirm sees the raised `reservedQty` and correctly fails the availability check.

This is expressed in Prisma via `$queryRaw` (the builder does not surface `FOR UPDATE`):

```typescript
const lockedRows = await tx.$queryRaw<Array<{ id: string; physicalQty: number; reservedQty: number }>>`
  SELECT id, "physicalQty", "reservedQty"
  FROM inventory
  WHERE id = ANY(${inventoryIds}::text[])
  ORDER BY id
  FOR UPDATE
`;
```

The `${inventoryIds}::text[]` is a Prisma bound parameter (typed cast to a text array), not string interpolation — it is safe from SQL injection.

---

## 3. The Atomicity Boundary

Every stock movement runs inside `prisma.$transaction(async (tx) => { ... })`. Inside the callback, all `tx.*` calls share one database transaction. A thrown error (e.g., an `AppError` for insufficient stock) rolls back every write in the callback. Reads that must be locked are inside the transaction; reads that are only for validation of existence (location, item) are outside it, because they do not need to be protected.

---

## 4. Critical Transaction 1 — Order Confirm (Reservation)

```
PATCH /api/orders/:id/confirm   (ADMIN, SALES)

prisma.$transaction(async (tx) => {
  1. Read order + items; assert status === PENDING (else 400)
  2. distinct inventoryIds = [...new Set(order.items.map(i => i.inventoryId))].sort()
       ← deterministic ascending order
  3. SELECT id, physicalQty, reservedQty FROM inventory
     WHERE id = ANY($ids) ORDER BY id FOR UPDATE
       ← all referenced rows locked in id order
  4. For each order item:
       available = physicalQty − reservedQty
       if available < requested → collect into insufficient[]
  5. if insufficient.length > 0:
       throw AppError(422, 'Insufficient available stock...', { insufficientItems })
       ← ROLLBACK: no reservation applied
  6. For each item: UPDATE inventory SET reservedQty += quantity
  7. UPDATE customer_orders SET status = CONFIRMED, confirmedAt = now()
})   ← COMMIT: all locks released
```

**Concurrency guarantee:** two confirms that overlap on the same inventory row serialise. The first commits its increment; the second unblocks, re-reads the higher `reservedQty`, and — if the combined demand now exceeds `physicalQty` — fails with 422 listing the specific insufficient item. Exactly one wins; over-reservation is impossible.

**The deadlock-avoidance trick:** rows are locked `ORDER BY id`. Any two transactions that touch an overlapping set of rows lock them in the same global order, so a cycle (A waits on B while B waits on A) cannot form. Without the sort, two transactions locking rows in opposite orders would deadlock under contention.

---

## 5. Critical Transaction 2 — Transfer Dispatch

```
PATCH /api/transfers/:id/dispatch   (ADMIN, OPERATIONS)

prisma.$transaction(async (tx) => {
  1. Read transfer; assert status === REQUESTED (else 400)
  2. SELECT id, physicalQty, reservedQty FROM inventory
     WHERE itemId = $itemId AND locationId = $sourceLocationId
     ORDER BY id FOR UPDATE
       ← all source-batch rows for this item locked
  3. totalAvailable = Σ(physical − reserved)
     if totalAvailable < transfer.quantity → 422 ROLLBACK
  4. Deduct FIFO across rows:
       remaining = quantity
       for row of sourceRows (ordered by id):
         available = row.physical − row.reserved
         deduct = min(available, remaining)
         if deduct <= 0 continue
         UPDATE inventory SET physicalQty = physicalQty − deduct
         INSERT inventory_transaction (OUT, deduct,
            reason='Transfer <n> dispatched',
            referenceKey=`dispatch-<transferId>-<rowId>`)
         remaining -= deduct
  5. UPDATE stock_transfers SET status = DISPATCHED, dispatchedBy, dispatchedAt
})   ← COMMIT
```

**Business rule enforced:** dispatch reduces source only; destination is never touched. Stock is "in transit" between dispatch and receipt. `availableQty` is respected — you cannot dispatch more than is available after reservations.

---

## 6. Critical Transaction 3 — Transfer Receipt (double-receipt guard)

```
PATCH /api/transfers/:id/receive   (ADMIN, OPERATIONS)

prisma.$transaction(async (tx) => {
  1. SELECT id, status, destLocationId, itemId, quantity, transferNumber
     FROM stock_transfers WHERE id = $id FOR UPDATE
       ← the transfer row itself is locked
  2. if not found → 404
     if status !== DISPATCHED → 400
       ← once RECEIVED, status != DISPATCHED, so a second receive is rejected
  3. Find or create destination inventory (DEFAULT batch)
  4. SELECT id FROM inventory WHERE id = $destId FOR UPDATE
  5. UPDATE inventory SET physicalQty += quantity
  6. INSERT inventory_transaction (IN, quantity,
       reason='Transfer <n> received',
       referenceKey=`receive-<transferId>`)
  7. UPDATE stock_transfers SET status = RECEIVED, receivedBy, receivedAt
})   ← COMMIT
```

**Why the transfer row is locked, not just the inventory row:** two concurrent receive calls on the same transfer both pass "status === DISPATCHED" if they read without a lock. Locking the transfer row serialises them: the first commit sets status to RECEIVED and releases the lock; the second then reads RECEIVED and fails the check. This is the structural double-receipt guard.

---

## 7. Critical Transaction 4 — Manual Stock Adjust

```
PATCH /api/inventory/:id/adjust   (ADMIN, OPERATIONS)

prisma.$transaction(async (tx) => {
  1. SELECT id, physicalQty, reservedQty FROM inventory WHERE id = $id FOR UPDATE
  2. newPhysical = (IN) ? physical + qty : physical − qty
  3. if newPhysical < 0 → 422 "would result in negative stock"
  4. if newPhysical < reservedQty → 422 "release reservations first"
  5. INSERT inventory_transaction (type, qty, reason, referenceKey?)
  6. UPDATE inventory SET physicalQty = newPhysical
})   ← COMMIT
```

The two guards (`physical ≥ 0` and `physical ≥ reserved`) keep the invariants true even for manual adjustments. The `referenceKey`, when provided, is the idempotency key — a duplicate submission returns 409.

---

## 8. The Invariants (held at every mutation)

| Invariant | Enforced where |
|---|---|
| `availableQty = physicalQty − reservedQty` (never stored) | `withAvailable()` on every read |
| `physicalQty ≥ 0` | adjust guard; dispatch deducts only `available` |
| `reservedQty ≥ 0` | confirm only increments; cancel only decrements when positive |
| `physicalQty ≥ reservedQty` (so `available ≥ 0`) | adjust guard; confirm checks availability before incrementing |
| `reservedQty` cannot exceed `physicalQty` under concurrency | `SELECT FOR UPDATE` serialises confirms |
| A transfer is received exactly once | transfer-row lock + `status === DISPATCHED` check |
| Work-order status is forward-only | `transitions` map rejects any non-allowed next status |

---

## 9. Idempotency Keys

System-generated transactions carry deterministic `referenceKey`s so a retried request is a no-op (the second insert hits the unique constraint → P2002 → 409):

| Operation | referenceKey |
|---|---|
| Transfer dispatch (per source row) | `dispatch-<transferId>-<inventoryRowId>` |
| Transfer receipt | `receive-<transferId>` |
| Manual adjust | caller-provided (optional) |

A 409 on a retried idempotent operation is the "already applied" signal — the client can treat it as success for the stock state, because the first application already moved the stock.

---

## 10. What Is Not Protected (and why)

- **Order creation (`POST /api/orders`)** does not lock anything — it only creates a PENDING order, reserving nothing. No contention, no lock needed. The collision risk is the `orderNumber`, solved with a timestamp+random suffix rather than `COUNT+1`.
- **Transfer/work-order number generation** uses `COUNT+1` and accepts the rare race window because these are low-frequency, single-actor paths; the `@unique` constraint catches any collision as a 409.
- **Cancel of a CONFIRMED order** decrements `reservedQty` without an explicit row lock. Under normal operation this is safe because a cancel is single-actor and the decrement is bounded. A stricter version would lock the rows first; this is a noted hardening opportunity.


---

**Read next:** [11 — Failure Scenarios →](11-Failure-Scenarios.md)

[← Back to documentation index](README.md)
