# Business Rules Deep Dive

---

## Rule 1: A customer cannot reserve more stock than available

### 1. Business meaning
A Sales user confirms an order. The system must ensure that `reservedQty` never exceeds `physicalQty - existing reservations`. If 10 units are available and the customer wants 15, the reservation must fail.

### 2. Real-world scenario
Warehouse A has 10 Steel Rods. Customer Omkar wants 6 and Customer Balaji wants 8. Only one can be fully served — the system must prevent both from succeeding.

### 3. Why the rule exists
Without it, customers could be promised stock that doesn't exist. Warehouse staff would then be unable to fulfill orders, causing business damage and customer complaints.

### 4. Exact API
`PATCH /api/orders/:id/confirm`

### 5. Exact frontend action
User clicks "Confirm" button in `frontend/src/pages/Orders.tsx` → `handleConfirm()` → `ordersApi.confirm(id)` → `apiClient.patch('/orders/${id}/confirm')`

### 6. Exact route file
`backend/src/routes/orders.ts` — the `PATCH /:id/confirm` handler

### 7. Exact mechanism: SELECT FOR UPDATE

```typescript
// Inside prisma.$transaction(async (tx) => { ... })

const inventoryIds = [...new Set(order.items.map((i) => i.inventoryId))].sort();
// Sort is critical for deadlock prevention

const lockedRows = await tx.$queryRaw<Array<{id: string; physicalQty: number; reservedQty: number}>>`
  SELECT id, "physicalQty", "reservedQty"
  FROM inventory
  WHERE id = ANY(${inventoryIds}::text[])
  ORDER BY id
  FOR UPDATE
`;
```

### 8. Exact validation
```typescript
const available = inv.physicalQty - inv.reservedQty;
if (available < item.quantity) {
  insufficient.push({ itemName: item.itemName, available, requested: item.quantity });
}

if (insufficient.length > 0) {
  throw new AppError(422, 'Insufficient available stock for one or more items.', {
    insufficientItems: insufficient,
  });
}
```

### 9. Database state: before operation
- `inventory.physicalQty = 10`
- `inventory.reservedQty = 0`
- `customer_orders.status = PENDING`

### 10. Database state: after SUCCESSFUL operation
- `inventory.reservedQty = 8` (incremented by order quantity)
- `customer_orders.status = CONFIRMED`
- `customer_orders.confirmedAt = now()`

### 11. Database state: after FAILED operation (422)
- `inventory.reservedQty = 0` (UNCHANGED — transaction rolled back)
- `customer_orders.status = PENDING` (UNCHANGED)
- No rows written anywhere

### 12. What happens on rollback
Prisma catches the `AppError` throw inside `$transaction`. PostgreSQL receives `ROLLBACK`. All `UPDATE` statements that ran before the throw are undone. The row locks are released.

### 13. Concurrency scenario

**Without FOR UPDATE:**
```
User A: reads reservedQty=0, available=10, decides to reserve 8
User B: reads reservedQty=0, available=10, decides to reserve 8
User A: UPDATE reservedQty = 8
User B: UPDATE reservedQty = 8  ← overwrites A's value!
Final: reservedQty = 8 (B's write won), but A thinks they reserved 8 too
```

Actually PostgreSQL's `{ increment: 8 }` is atomic — let's examine the real issue:
```
User A: reads available=10, reserves 8 using increment → reservedQty becomes 8
User B: reads available=10 (before A commits), reserves 8 → reservedQty becomes 16
physicalQty=10, reservedQty=16 → availableQty = -6  ← CORRUPTED
```

**With FOR UPDATE:**
```
User A: SELECT FOR UPDATE — acquires lock
User B: SELECT FOR UPDATE — BLOCKED
User A: available=10 >= 8 → reserves → reservedQty=8 → COMMIT → releases lock
User B: unblocked — re-reads reservedQty=8 → available=10-8=2 < 8 → 422 ROLLBACK
```

### 14. Which tests verify this rule
`backend/src/__tests__/orders.test.ts`:
- `"returns 422 when requested quantity exceeds available (10 available, request 15)"`
- `"inventory reservedQty unchanged after failed reservation attempt"`
- `"only one of two simultaneous reservations succeeds when combined qty > available"`
- `"final reservedQty equals exactly 8 — not 16 (no over-reservation)"`

The **concurrency test** specifically:
```typescript
const [confirmRes1, confirmRes2] = await Promise.all([
  request(app).patch(`/api/orders/${orderId1}/confirm`)...,
  request(app).patch(`/api/orders/${orderId2}/confirm`)...,
]);
// Exactly one must succeed (200), one must fail (422)
expect(statuses.filter(s => s === 200).length).toBe(1);
expect(statuses.filter(s => s === 422).length).toBe(1);
// reservedQty must be exactly 8, not 16
expect(inv!.reservedQty).toBe(8);
```

### 15. What breaks if this protection is removed
Remove `FOR UPDATE` from the query → Two concurrent confirms both calculate `available=10`, both proceed, both increment `reservedQty` by 8 → final `reservedQty=16` against `physicalQty=10` → `availableQty=-6`. Stock is over-promised.

---

## Rule 2: A transfer cannot dispatch more stock than available

### 1. Business meaning
You cannot send more stock from a location than what is physically available there (physicalQty minus already-reserved stock).

### 2. Exact API
`PATCH /api/transfers/:id/dispatch`

### 3. Exact mechanism
```typescript
const sourceRows = await tx.$queryRaw`
  SELECT id, "physicalQty", "reservedQty"
  FROM inventory
  WHERE "itemId" = ${transfer.itemId}
    AND "locationId" = ${transfer.sourceLocationId}
  ORDER BY id
  FOR UPDATE
`;

const totalAvailable = sourceRows.reduce((s, r) => s + (r.physicalQty - r.reservedQty), 0);

if (totalAvailable < transfer.quantity) {
  throw new AppError(422,
    `Insufficient available stock at source. Available: ${totalAvailable}, requested: ${transfer.quantity}.`
  );
}
```

### 4. Why available uses `physicalQty - reservedQty` (not just physicalQty)
Reserved stock is promised to customers. Even though it's physically in the warehouse, it cannot be dispatched to another location — those units already belong to confirmed orders.

### 5. Tests
`backend/src/__tests__/transfers.test.ts`:
- `"dispatch returns 422 when quantity exceeds available stock"` (100 requested, 50 available)
- `"source stock remains unchanged after a failed dispatch"`
- `"transfer stays in REQUESTED status after a failed dispatch"`

---

## Rule 3: Destination inventory increases ONLY when the transfer is RECEIVED, not DISPATCHED

### 1. Business meaning
When stock leaves Warehouse A for Warehouse B, it is "in transit." It should not appear in Warehouse B's inventory until it physically arrives.

### 2. Why this matters
If destination stock increased on dispatch, Warehouse B staff could reserve that stock before it arrives. If the transfer is then lost or cancelled, the reservations would be against stock that never came.

### 3. Exact implementation in dispatch
The dispatch transaction in `transfers.ts`:
```typescript
// Deduct from source rows
await tx.inventory.update({
  where: { id: row.id },
  data: { physicalQty: { decrement: deduct } },
});
// NO update to destination inventory here
return tx.stockTransfer.update({ ... status: 'DISPATCHED' ... });
// Transaction ends. Destination inventory is UNCHANGED.
```

### 4. Exact implementation in receive
```typescript
// Only in the receive transaction:
await tx.inventory.update({
  where: { id: destInv.id },
  data: { physicalQty: { increment: transfer.quantity } },
});
```

### 5. Tests
```typescript
it('after dispatch: destination stock has NOT increased yet', async () => {
  const destInv = await prisma.inventory.findFirst({ where: { itemId, locationId: locationBId } });
  if (destInv) expect(destInv.physicalQty).toBe(0);
  else expect(destInv).toBeNull();
});

it('receipt succeeds (200) and increases destination stock', async () => {
  // ... receive the transfer ...
  const destInv = await prisma.inventory.findFirst({ where: { itemId, locationId: locationBId } });
  expect(destInv!.physicalQty).toBe(20);
});
```

---

## Rule 4: The same transfer cannot be received twice

### 1. Business meaning
Once stock arrives and is recorded, that same transfer cannot be received again. Receiving it twice would double-count stock that was only delivered once.

### 2. The two-layer protection

**Layer 1 — Status check inside transaction after row lock:**
```typescript
const transfers = await tx.$queryRaw`
  SELECT id, status, ...
  FROM stock_transfers
  WHERE id = ${transferId}
  FOR UPDATE                ← lock the transfer row
`;

if (transfer.status !== TransferStatus.DISPATCHED) {
  throw new AppError(400,
    `Transfer cannot be received. Current status: ${transfer.status}. Only DISPATCHED transfers can be received.`
  );
}
```
After the first receive commits, `status = RECEIVED`. Any subsequent receive call hits this check and fails with 400.

**Layer 2 — Unique referenceKey on InventoryTransaction:**
```typescript
await tx.inventoryTransaction.create({
  data: {
    referenceKey: `receive-${transfer.id}`,  // globally unique
    ...
  },
});
```
Even if two concurrent receive calls somehow both pass the status check simultaneously (extremely rare edge case), the second one fails when trying to insert the `inventoryTransaction` row — `referenceKey` has a unique constraint.

### 3. Why the lock on the transfer row matters
Without `FOR UPDATE` on the transfer row, two concurrent receive requests could both read `status=DISPATCHED` before either commits. Both would proceed to increment destination stock. The lock forces them to serialize.

### 4. Tests
```typescript
it('Mandatory Test 4 — receiving the same transfer again returns 400', async () => {
  const res = await request(app)
    .patch(`/api/transfers/${transferId}/receive`)
    .set('Authorization', `Bearer ${opsToken}`);
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/dispatched/i);
});

it('destination stock unchanged after double-receipt attempt (still 20)', async () => {
  const destInv = await prisma.inventory.findFirst({ where: { itemId, locationId: locationBId } });
  expect(destInv!.physicalQty).toBe(20);  // unchanged from first receipt
});
```

---

## Rule 5: An unauthorized user cannot perform a restricted operation

### 1. Business meaning
- SALES cannot adjust inventory or create work orders
- OPERATIONS cannot confirm customer orders
- No one without a valid JWT can access any data

### 2. How authentication is enforced

Every route file starts with:
```typescript
router.use(authenticate);
```
This runs `authenticate()` middleware on every request to any route in that file. If there's no valid JWT, `next(AppError(401))` is called and the request never reaches the route handler.

### 3. How authorization is enforced

Each route has an `authorize(...)` call before the handler:
```typescript
router.post('/', authorize(Role.ADMIN), ...)
router.patch('/:id/dispatch', authorize(Role.ADMIN, Role.OPERATIONS), ...)
router.patch('/:id/confirm', authorize(Role.ADMIN, Role.SALES), ...)
```

The `authorize` factory creates a middleware that reads `req.user.role` (set by `authenticate`) and throws `AppError(403)` if the role isn't in the allowed list.

### 4. Role matrix

| Operation | ADMIN | OPERATIONS | SALES |
|---|---|---|---|
| Create location | ✓ | — | — |
| Create/update items | ✓ | ✓ | — |
| Adjust inventory | ✓ | ✓ | — |
| Create work orders | ✓ | — | — |
| Advance work order status | ✓ | ✓ | — |
| Create transfers | ✓ | ✓ | — |
| Dispatch/receive transfers | ✓ | ✓ | — |
| Cancel transfers | ✓ | — | — |
| Create/confirm/cancel orders | ✓ | — | ✓ |
| Read all data | ✓ | ✓ | ✓ |

### 5. What happens step by step for a SALES user trying to dispatch a transfer

```
SALES user sends: PATCH /api/transfers/abc/dispatch
  ↓
authenticate() runs
  → reads Authorization header
  → jwt.verify() succeeds
  → req.user = { userId: '...', email: '...', role: 'SALES' }
  → next() called
  ↓
authorize(Role.ADMIN, Role.OPERATIONS) runs
  → reads req.user.role = 'SALES'
  → 'SALES' not in [ADMIN, OPERATIONS]
  → throw new AppError(403, 'Access denied. Required role: ADMIN or OPERATIONS.')
  → next(error) called
  ↓
errorHandler receives AppError
  → returns HTTP 403
  → { "success": false, "message": "Access denied. Required role: ADMIN or OPERATIONS." }
The route handler NEVER executes.
```

### 6. Tests
`backend/src/__tests__/rbac.test.ts`:
- 5 unauthenticated → 401 tests
- 8 SALES restrictions → 403 tests
- 4 OPERATIONS restrictions → 403 tests
- 5 ADMIN permitted → 200 sanity checks

Key test examples:
```typescript
it('SALES cannot dispatch a transfer (OPS_ADMIN only) → 403', async () => {
  const res = await request(app)
    .patch('/api/transfers/some-id/dispatch')
    .set('Authorization', `Bearer ${salesToken}`);
  expect(res.status).toBe(403);
});

it('OPERATIONS cannot confirm a customer order (SALES_ADMIN only) → 403', async () => {
  const res = await request(app)
    .patch('/api/orders/some-id/confirm')
    .set('Authorization', `Bearer ${opsToken}`);
  expect(res.status).toBe(403);
});
```
