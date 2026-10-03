# Transaction Deep Dive

## Fundamental Concepts First

### What is a database transaction?

Simple meaning: A group of operations that either ALL succeed together, or ALL fail together. There is no partial success.

Technical meaning: A unit of work in PostgreSQL that satisfies ACID properties:
- **Atomicity**: all operations commit or all roll back
- **Consistency**: database constraints are enforced
- **Isolation**: concurrent transactions don't see each other's uncommitted data
- **Durability**: committed data survives crashes

### What is a Prisma transaction?

```typescript
await prisma.$transaction(async (tx) => {
  // Operations using `tx` instead of `prisma`
  // If any throw, ALL operations are rolled back
});
```

Prisma wraps all operations inside the callback in a single PostgreSQL `BEGIN ... COMMIT` block. If anything throws, PostgreSQL receives `ROLLBACK`.

### Why is `prisma.$transaction()` ALONE not enough for concurrency?

This is the most important concept in the entire application.

Prisma transactions run at PostgreSQL's **default isolation level: READ COMMITTED**.

At READ COMMITTED, a transaction sees data as it was committed the moment it reads it. But two concurrent transactions can both READ the same row, both calculate "there's enough stock," and both WRITE.

```
Transaction A reads:  physicalQty=10, reservedQty=0  → available=10
Transaction B reads:  physicalQty=10, reservedQty=0  → available=10
Transaction A writes: reservedQty += 8  (10-8=2 available)
Transaction B writes: reservedQty += 8  (10-8=2 available? No — now 16-10 = NEGATIVE!)
Final state: reservedQty=16, physicalQty=10 → availableQty = -6  ← CORRUPTED
```

This is the race condition this application must prevent.

### What is SELECT FOR UPDATE?

Simple meaning: "Lock this row. No other transaction can read OR write it until I'm done."

Technical meaning: A PostgreSQL row-level lock that prevents other transactions from acquiring any lock on the same row. Other transactions that try `SELECT FOR UPDATE` on the same row will **block** (wait) until the first transaction commits or rolls back.

```sql
SELECT id, "physicalQty", "reservedQty"
FROM inventory
WHERE id = ANY($ids::text[])
ORDER BY id
FOR UPDATE;
```

With this lock:
- Transaction A locks the rows
- Transaction B tries to lock the same rows → **blocks and waits**
- Transaction A finishes, commits → Transaction B unblocks, re-reads the UPDATED values
- Transaction B now sees `reservedQty=8` from A's commit → available=2 < requested 8 → fails with 422

This is how the concurrency problem is solved.

---

## Transaction 1: Order Confirmation (`PATCH /api/orders/:id/confirm`)

**File:** `backend/src/routes/orders.ts`

**Why a transaction is needed:** Without it, two requests could both read `reservedQty=0`, both calculate `available=10`, both decide to reserve 8, and both commit — resulting in `reservedQty=16` against `physicalQty=10`.

**Full transaction walkthrough:**

```typescript
const confirmed = await prisma.$transaction(async (tx) => {

  // STEP 1: Read the order (no lock needed here — just a read)
  const order = await tx.customerOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) throw new AppError(404, 'Order not found.');
  if (order.status !== OrderStatus.PENDING) {
    throw new AppError(400, `Order is already ${order.status.toLowerCase()}.`);
  }
  // WHY check status: prevents confirming an already-confirmed order.
  // The status check inside the transaction means even if two requests
  // both started, one will win and the second will see status=CONFIRMED here.

  // STEP 2: Sort inventory IDs deterministically
  const inventoryIds = [...new Set(order.items.map((i) => i.inventoryId))].sort();
  // WHY sort: If Transaction A locks rows in order [id1, id2] and Transaction B
  // locks in order [id2, id1], they deadlock (each holds what the other needs).
  // Sorting guarantees both transactions lock in the SAME order, preventing deadlock.

  // STEP 3: SELECT FOR UPDATE — the critical lock
  const lockedRows = await tx.$queryRaw<Array<{...}>>`
    SELECT id, "physicalQty", "reservedQty"
    FROM inventory
    WHERE id = ANY(${inventoryIds}::text[])
    ORDER BY id
    FOR UPDATE
  `;
  // WHY raw SQL: Prisma's .findMany() does not support FOR UPDATE.
  // We must drop down to raw SQL for this specific operation.
  // WHY inside the transaction: The lock is held from this point until
  // the transaction commits or rolls back. Any other request trying to
  // lock these same rows will block here.

  // STEP 4: Re-read values from LOCKED rows
  const inventoryMap = new Map(lockedRows.map((r) => [r.id, r]));
  // WHY re-read: We cannot trust values read BEFORE the lock.
  // The FOR UPDATE gives us the latest committed values at lock time.

  // STEP 5: Check availability against fresh locked values
  const insufficient = [];
  for (const item of order.items) {
    const inv = inventoryMap.get(item.inventoryId);
    const available = inv.physicalQty - inv.reservedQty;  // computed, not stored
    if (available < item.quantity) {
      insufficient.push({ itemName: item.itemName, available, requested: item.quantity });
    }
  }

  if (insufficient.length > 0) {
    throw new AppError(422, 'Insufficient available stock.', { insufficientItems: insufficient });
    // WHY throw inside transaction: Prisma catches the throw and issues ROLLBACK.
    // NO database changes happen. The inventory rows are unlocked.
  }

  // STEP 6: All checks passed — reserve stock
  for (const item of order.items) {
    await tx.inventory.update({
      where: { id: item.inventoryId },
      data: { reservedQty: { increment: item.quantity } },
    });
    // WHY { increment: N } instead of { reservedQty: N }:
    // increment is atomic at the DB level. Using a calculated value
    // (like reservedQty: lockedRow.reservedQty + N) would re-introduce
    // a race condition.
  }

  // STEP 7: Mark order confirmed
  return tx.customerOrder.update({
    where: { id: orderId },
    data: { status: OrderStatus.CONFIRMED, confirmedAt: new Date() },
    ...
  });

  // COMMIT — locks are released, changes become visible to other transactions
});
```

**Database state changes:**
- Before: `inventory.reservedQty = 0`, `order.status = PENDING`
- After success: `inventory.reservedQty += quantity`, `order.status = CONFIRMED`
- After failure (422): NO changes — transaction rolled back

---

## Transaction 2: Transfer Dispatch (`PATCH /api/transfers/:id/dispatch`)

**File:** `backend/src/routes/transfers.ts`

**Why a transaction is needed:** Must check available stock AND reduce it atomically. A separate check-then-write without locking would allow two dispatches to both see "50 available" and both subtract 30, leaving -10.

```typescript
const updated = await prisma.$transaction(async (tx) => {

  // STEP 1: Read transfer (no lock yet)
  const transfer = await tx.stockTransfer.findUnique({ where: { id: transferId } });
  if (transfer.status !== TransferStatus.REQUESTED) {
    throw new AppError(400, `Cannot dispatch. Status: ${transfer.status}.`);
  }

  // STEP 2: Lock source inventory rows
  const sourceRows = await tx.$queryRaw`
    SELECT id, "physicalQty", "reservedQty"
    FROM inventory
    WHERE "itemId" = ${transfer.itemId}
      AND "locationId" = ${transfer.sourceLocationId}
    ORDER BY id
    FOR UPDATE
  `;
  // Locks ALL inventory rows for this item at the source location.
  // If the item exists in multiple batches at the same location,
  // all batch rows are locked and deducted from in FIFO order.

  // STEP 3: Check total available across all source rows
  const totalAvailable = sourceRows.reduce((s, r) => s + (r.physicalQty - r.reservedQty), 0);
  if (totalAvailable < transfer.quantity) {
    throw new AppError(422, `Insufficient stock. Available: ${totalAvailable}.`);
  }

  // STEP 4: Deduct from source rows (FIFO — earliest rows first)
  let remaining = transfer.quantity;
  for (const row of sourceRows) {
    if (remaining <= 0) break;
    const deduct = Math.min(row.physicalQty - row.reservedQty, remaining);
    if (deduct <= 0) continue;

    await tx.inventory.update({
      where: { id: row.id },
      data: { physicalQty: { decrement: deduct } },
    });

    // STEP 5: Audit trail with idempotency key
    await tx.inventoryTransaction.create({
      data: {
        inventoryId: row.id,
        transactionType: 'OUT',
        quantity: deduct,
        reason: `Transfer ${transfer.transferNumber} dispatched`,
        referenceKey: `dispatch-${transfer.id}-${row.id}`,
        // WHY referenceKey: If this endpoint is called twice (network retry),
        // the second call fails with 409 on the unique constraint,
        // not with double-subtracted stock.
        createdById: req.user!.userId,
      },
    });
    remaining -= deduct;
  }

  // STEP 6: Update transfer status to DISPATCHED
  // DESTINATION INVENTORY IS NOT TOUCHED HERE — intentional by design.
  return tx.stockTransfer.update({
    where: { id: transferId },
    data: { status: 'DISPATCHED', dispatchedById: req.user!.userId, dispatchedAt: new Date() },
    ...
  });
});
```

**Database state changes:**
- `source inventory.physicalQty -= quantity` ← ONLY source changes
- `inventory_transactions` row created with `OUT` type
- `stock_transfers.status = DISPATCHED`
- Destination inventory: **UNCHANGED**

---

## Transaction 3: Transfer Receipt (`PATCH /api/transfers/:id/receive`)

**File:** `backend/src/routes/transfers.ts`

**Why a transaction is needed:** Must guard against double-receipt (same transfer received twice) AND increase destination stock atomically.

**The double-receipt guard mechanism:**

```typescript
const updated = await prisma.$transaction(async (tx) => {

  // STEP 1: Lock the TRANSFER ROW ITSELF
  const transfers = await tx.$queryRaw`
    SELECT id, status, "destLocationId", "itemId", quantity, "transferNumber"
    FROM stock_transfers
    WHERE id = ${transferId}
    FOR UPDATE
  `;
  // WHY lock the transfer row: If two receive requests arrive simultaneously,
  // one locks the row, the other blocks.
  // The first reads status=DISPATCHED, changes to RECEIVED, commits.
  // The second unblocks, re-reads status=RECEIVED, hits the check below → 400.
  // This is the double-receipt guard.

  const transfer = transfers[0];

  // STEP 2: Status check INSIDE the transaction after the lock
  if (transfer.status !== TransferStatus.DISPATCHED) {
    throw new AppError(400,
      `Transfer cannot be received. Status: ${transfer.status}. Only DISPATCHED transfers can be received.`
    );
    // WHY check status NOT RECEIVED: After the first receive commits, this check
    // always fails for any subsequent receive attempt. Even if two requests
    // started simultaneously, only one wins — the other sees status=RECEIVED here.
  }

  // STEP 3: Find or create destination inventory record
  let destInv = await tx.inventory.findFirst({
    where: { itemId: transfer.itemId, locationId: transfer.destLocationId, batchNumber: 'DEFAULT' },
  });
  if (!destInv) {
    destInv = await tx.inventory.create({
      data: { itemId: transfer.itemId, locationId: transfer.destLocationId, batchNumber: 'DEFAULT', physicalQty: 0 },
    });
    // WHY create if not exists: The destination may have never held this item.
    // The transfer creates the inventory record at the destination.
  }

  // STEP 4: Lock destination inventory
  await tx.$queryRaw`SELECT id FROM inventory WHERE id = ${destInv.id} FOR UPDATE`;
  // WHY lock destination: Another operation might adjust this inventory simultaneously.

  // STEP 5: Increase destination physicalQty
  await tx.inventory.update({
    where: { id: destInv.id },
    data: { physicalQty: { increment: transfer.quantity } },
  });
  // SOURCE INVENTORY NOT TOUCHED — it was already decremented at dispatch.

  // STEP 6: Audit trail with unique referenceKey
  await tx.inventoryTransaction.create({
    data: {
      inventoryId: destInv.id,
      transactionType: 'IN',
      quantity: transfer.quantity,
      reason: `Transfer ${transfer.transferNumber} received`,
      referenceKey: `receive-${transfer.id}`,
      // WHY this specific key: Only one row with this key can exist.
      // If receipt is somehow called twice and both pass the status check
      // (extremely unlikely but possible in edge cases), the second will fail
      // with a 409 on this unique constraint.
      createdById: req.user!.userId,
    },
  });

  // STEP 7: Mark transfer RECEIVED
  return tx.stockTransfer.update({
    where: { id: transferId },
    data: { status: 'RECEIVED', receivedById: req.user!.userId, receivedAt: new Date() },
    ...
  });
});
```

**Database state changes:**
- `destination inventory.physicalQty += quantity`
- `inventory_transactions` row created with `IN` type and referenceKey
- `stock_transfers.status = RECEIVED`
- Source inventory: **UNCHANGED** (was already decremented at dispatch)

---

## Transaction 4: Inventory Adjust (`PATCH /api/inventory/:id/adjust`)

```typescript
const updated = await prisma.$transaction(async (tx) => {

  // Lock the specific inventory row
  const rows = await tx.$queryRaw`
    SELECT id, "physicalQty", "reservedQty"
    FROM inventory
    WHERE id = ${req.params.id}
    FOR UPDATE
  `;

  const inv = rows[0];
  const newPhysicalQty = transactionType === 'IN'
    ? inv.physicalQty + quantity
    : inv.physicalQty - quantity;

  // Guard: never go negative
  if (newPhysicalQty < 0) throw new AppError(422, 'Negative stock...');

  // Guard: never make physicalQty < reservedQty
  if (newPhysicalQty < inv.reservedQty) throw new AppError(422, 'Below reserved...');
  // WHY this guard: If you have physicalQty=10 and reservedQty=8,
  // and someone tries to OUT 5, that would leave physicalQty=5 < reservedQty=8.
  // That's impossible: you can't have more reserved than physical stock.

  // Record audit trail (with optional idempotency key)
  await tx.inventoryTransaction.create({ data: { ..., referenceKey } });

  return tx.inventory.update({ where: { id: inv.id }, data: { physicalQty: newPhysicalQty } });
});
```

---

## Summary: What Lock Does What

| Situation | Lock Target | Why |
|---|---|---|
| Order confirmation | `inventory` rows (sorted by id) | Prevent concurrent over-reservation |
| Transfer dispatch | `inventory` rows at source location | Prevent dispatching more than available |
| Transfer receipt | `stock_transfers` row | Prevent double-receipt |
| Transfer receipt (dest) | destination `inventory` row | Prevent race on destination increment |
| Inventory adjust | `inventory` row being adjusted | Prevent concurrent adjustment conflicts |

---

## Why `prisma.$transaction()` Without FOR UPDATE Is Not Sufficient

At READ COMMITTED (Postgres default):

```
Time →         Transaction A                  Transaction B
               BEGIN                          BEGIN
               READ inventory row             READ SAME inventory row
               (sees physicalQty=10)          (sees physicalQty=10)
               WRITE physicalQty -= 8         WRITE physicalQty -= 8
               COMMIT                         COMMIT
               Final: physicalQty = 2         But B saw 10, committed -8
                                              Actual DB value: 10-8-8 = -6 !!
```

With FOR UPDATE:

```
Time →         Transaction A                  Transaction B
               BEGIN                          BEGIN
               SELECT ... FOR UPDATE          Tries SELECT ... FOR UPDATE
               (acquires row lock)            BLOCKED — waits
               READ physicalQty=10
               WRITE physicalQty -= 8
               COMMIT (releases lock)
                                              Unblocked — re-reads physicalQty=2
                                              available = 2 - 0 = 2 < requested 8
                                              THROW 422 (rollback)
                                              Final: physicalQty = 2 (correct)
```
