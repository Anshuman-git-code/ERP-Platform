# API Code Walkthrough

## Complete Endpoint Matrix

| # | Method | Path | Auth | Roles | Transaction | Lock | File |
|---|---|---|---|---|---|---|---|
| 1 | POST | /api/auth/login | No | — | No | No | auth.ts |
| 2 | GET | /api/auth/me | Yes | ALL | No | No | auth.ts |
| 3 | GET | /health | No | — | No | No | app.ts |
| 4 | GET | /api/locations | Yes | ALL | No | No | locations.ts |
| 5 | POST | /api/locations | Yes | ADMIN | No | No | locations.ts |
| 6 | GET | /api/locations/:id | Yes | ALL | No | No | locations.ts |
| 7 | GET | /api/items | Yes | ALL | No | No | items.ts |
| 8 | POST | /api/items | Yes | ADMIN, OPS | No | No | items.ts |
| 9 | GET | /api/items/:id | Yes | ALL | No | No | items.ts |
| 10 | PUT | /api/items/:id | Yes | ADMIN, OPS | No | No | items.ts |
| 11 | GET | /api/inventory | Yes | ALL | No | No | inventory.ts |
| 12 | POST | /api/inventory | Yes | ADMIN, OPS | No | No | inventory.ts |
| 13 | GET | /api/inventory/:id | Yes | ALL | No | No | inventory.ts |
| 14 | PATCH | /api/inventory/:id/adjust | Yes | ADMIN, OPS | Yes | FOR UPDATE | inventory.ts |
| 15 | GET | /api/inventory/:id/transactions | Yes | ALL | No | No | inventory.ts |
| 16 | GET | /api/work-orders | Yes | ALL | No | No | workOrders.ts |
| 17 | POST | /api/work-orders | Yes | ADMIN | No | No | workOrders.ts |
| 18 | GET | /api/work-orders/:id | Yes | ALL | No | No | workOrders.ts |
| 19 | PATCH | /api/work-orders/:id/status | Yes | ADMIN, OPS | No | No | workOrders.ts |
| 20 | GET | /api/transfers | Yes | ALL | No | No | transfers.ts |
| 21 | POST | /api/transfers | Yes | ADMIN, OPS | No | No | transfers.ts |
| 22 | GET | /api/transfers/:id | Yes | ALL | No | No | transfers.ts |
| 23 | PATCH | /api/transfers/:id/dispatch | Yes | ADMIN, OPS | Yes | FOR UPDATE | transfers.ts |
| 24 | PATCH | /api/transfers/:id/receive | Yes | ADMIN, OPS | Yes | FOR UPDATE | transfers.ts |
| 25 | PATCH | /api/transfers/:id/cancel | Yes | ADMIN | No | No | transfers.ts |
| 26 | GET | /api/orders | Yes | ALL | No | No | orders.ts |
| 27 | POST | /api/orders | Yes | ADMIN, SALES | No | No | orders.ts |
| 28 | GET | /api/orders/:id | Yes | ALL | No | No | orders.ts |
| 29 | PATCH | /api/orders/:id/confirm | Yes | ADMIN, SALES | Yes | FOR UPDATE | orders.ts |
| 30 | PATCH | /api/orders/:id/cancel | Yes | ADMIN, SALES | Yes | No lock | orders.ts |
| 31 | GET | /api/dashboard | Yes | ALL | No | No | dashboard.ts |

---

## Full Request Lifecycle: `PATCH /api/orders/:id/confirm`

This is the most important endpoint. Tracing it teaches you every layer.

```
User clicks "Confirm" on an order in the Orders page
│
│ frontend/src/pages/Orders.tsx
│   const handleConfirm = async (id: string) => {
│     await ordersApi.confirm(id);
│     await load();  // refresh the table
│   }
│
│ frontend/src/api/orders.ts
│   confirm: (id: string) => apiClient.patch(`/orders/${id}/confirm`)
│
│ frontend/src/api/client.ts (Axios interceptor)
│   Adds: Authorization: Bearer eyJhbGci...
│
↓ HTTP: PATCH /api/orders/abc123/confirm
         Headers: Authorization: Bearer <token>
│
│ NGINX (in Docker/prod)
│   /api/* → proxy_pass to backend:4000
│
↓ Express app.ts receives request
│
│ morgan() — logs: "PATCH /api/orders/abc123/confirm 200"
│ express.json() — parses request body (empty in this case)
│ app.use('/api/orders', orderRoutes) — matched
│
↓ backend/src/routes/orders.ts
│
│ router.use(authenticate)  ← runs first on every route in this file
│   reads authHeader = "Bearer eyJhbGci..."
│   jwt.verify(token, JWT_SECRET) → payload = { userId, email, role: 'SALES' }
│   req.user = { userId: 'cm...', email: 'sales@opserp.dev', role: 'SALES' }
│   next() called
│
│ router.patch('/:id/confirm', authorize(Role.ADMIN, Role.SALES), ...)
│   authorize checks: 'SALES' in [ADMIN, SALES] → true → next() called
│
│ [param('id').notEmpty()] validation chain runs
│   req.params.id = 'abc123' — not empty → valid
│
│ validate middleware runs
│   validationResult(req).isEmpty() → true (no errors)
│   next() called
│
↓ Route handler executes:
│   const orderId = req.params.id;  // 'abc123'
│
│   await prisma.$transaction(async (tx) => {
│
│     1. tx.customerOrder.findUnique({ where: { id: 'abc123' }, include: { items: true } })
│        SELECT * FROM customer_orders WHERE id = 'abc123'
│        SELECT * FROM order_items WHERE "orderId" = 'abc123'
│        → order.status === 'PENDING' ✓
│
│     2. inventoryIds = ['inv-id-1', 'inv-id-2'] (sorted)
│
│     3. tx.$queryRaw`
│          SELECT id, "physicalQty", "reservedQty"
│          FROM inventory
│          WHERE id = ANY(ARRAY['inv-id-1','inv-id-2'])
│          ORDER BY id
│          FOR UPDATE
│        `
│        → PostgreSQL acquires row-level locks on both inventory rows
│        → Returns: [{ id: 'inv-id-1', physicalQty: 20, reservedQty: 5 }]
│
│     4. available = 20 - 5 = 15
│        requested = 8
│        15 >= 8 → sufficient
│
│     5. tx.inventory.update({ where: { id: 'inv-id-1' }, data: { reservedQty: { increment: 8 } } })
│        UPDATE inventory SET "reservedQty" = "reservedQty" + 8 WHERE id = 'inv-id-1'
│        → reservedQty becomes 13
│
│     6. tx.customerOrder.update({ where: { id: 'abc123' }, data: { status: 'CONFIRMED', confirmedAt: now() } })
│        UPDATE customer_orders SET status = 'CONFIRMED', "confirmedAt" = now() WHERE id = 'abc123'
│
│   }) ← COMMIT — locks released, all changes visible
│
↓ res.json({ success: true, data: confirmedOrder })
│
↓ HTTP 200: { "success": true, "data": { "status": "CONFIRMED", ... } }
│
│ Axios response interceptor
│   status 200 → not 401 → passes through
│
│ handleConfirm() receives response
│
│ load() called → ordersApi.list() → GET /api/orders
│   Table re-renders with updated status badge (CONFIRMED, green)
│
↓ User sees: order now shows "CONFIRMED" badge, "Cancel" button only
```

---

## Endpoint Details: Every Transactional Endpoint

### `PATCH /api/inventory/:id/adjust`
**Purpose:** Manually change stock up or down (damage, recount, etc.)
**Body:** `{ transactionType: "IN"|"OUT", quantity: N, reason?: string, referenceKey?: string }`
**Transaction:** YES
**Lock:** `SELECT id, physicalQty, reservedQty FROM inventory WHERE id = $id FOR UPDATE`
**Validation:**
- quantity must be > 0
- OUT cannot make physicalQty < 0
- OUT cannot make physicalQty < reservedQty
- referenceKey (if provided) must be unique — prevents duplicate adjustments
**DB changes:** `inventory.physicalQty` changes; `inventory_transactions` row created
**Error codes:** 422 (negative stock), 409 (duplicate referenceKey), 404 (not found)

### `PATCH /api/transfers/:id/dispatch`
**Purpose:** Mark transfer as dispatched; decrement source inventory
**Roles:** ADMIN, OPERATIONS
**Transaction:** YES — source inventory lock + status change are atomic
**Lock:** `SELECT ... FROM inventory WHERE itemId=$x AND locationId=$src FOR UPDATE`
**Validation:** status must be REQUESTED; totalAvailable >= transfer.quantity
**DB changes:** source `inventory.physicalQty -= quantity`; `stock_transfers.status = DISPATCHED`; `inventory_transactions` OUT record
**Idempotency:** `referenceKey: "dispatch-<transferId>-<invRowId>"` prevents double-dispatch

### `PATCH /api/transfers/:id/receive`
**Purpose:** Mark transfer as received; increment destination inventory
**Transaction:** YES — transfer row lock + dest inventory change are atomic
**Lock 1:** `SELECT ... FROM stock_transfers WHERE id=$id FOR UPDATE` — prevents double-receipt
**Lock 2:** `SELECT id FROM inventory WHERE id=$destId FOR UPDATE` — protects dest row
**Validation:** transfer status must be DISPATCHED (fails 400 if already RECEIVED)
**DB changes:** dest `inventory.physicalQty += quantity`; `stock_transfers.status = RECEIVED`; `inventory_transactions` IN record
**Idempotency:** `referenceKey: "receive-<transferId>"` — second attempt fails with 409

### `PATCH /api/orders/:id/confirm`
**Purpose:** Reserve stock for a customer order
**Transaction:** YES
**Lock:** `SELECT ... FROM inventory WHERE id = ANY($ids) ORDER BY id FOR UPDATE`
**Sort by id:** Prevents deadlock when two concurrent requests try to lock the same rows
**Validation:** All items must have `available >= requested`
**DB changes:** `inventory.reservedQty += quantity` for each item; `customer_orders.status = CONFIRMED`

### `PATCH /api/orders/:id/cancel`
**Purpose:** Cancel an order and optionally release reserved stock
**Transaction:** YES (but no lock — the status check inside prevents double-cancel)
**Special:** If `status === CONFIRMED`, releases reservation: `reservedQty -= quantity`
**DB changes:** if CONFIRMED → `inventory.reservedQty -= quantity`; always → `customer_orders.status = CANCELLED`

---

## Error Response Format (all endpoints)

All errors follow the same structure:
```json
{
  "success": false,
  "message": "Human-readable description",
  "errors": [...],       // Only on 422 validation failures
  "details": {...},      // Only on some business errors
  "field": [...]         // Only on 409 duplicate key
}
```

| Status | Meaning | Example trigger |
|---|---|---|
| 200/201 | Success | Successful read/create |
| 400 | Wrong state | Confirm already-confirmed order |
| 401 | No/invalid token | Missing Authorization header |
| 403 | Wrong role | SALES dispatching a transfer |
| 404 | Not found | Order ID doesn't exist |
| 409 | Duplicate | Duplicate SKU, duplicate referenceKey |
| 422 | Validation or insufficient stock | physicalQty < 0, over-reservation |
| 503 | Health degraded | Database unreachable |
