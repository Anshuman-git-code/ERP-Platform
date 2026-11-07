# 05 — Business Flows

> Each flow is described from four perspectives: business (what the user experiences), technical (what the code does), AWS (which services are invoked), and failure (what can go wrong and what happens).

---

## Flow 1: Authentication

### Business Perspective
A user enters their email and password on the login screen. On success they reach the app and see only the navigation their role permits. On failure they see an error. After 8 hours the token expires and they are sent back to login.

### Technical Perspective
```
1. Login.tsx submits email + password
2. authApi.login() → POST /api/auth/login
3. auth route: bcrypt.compare(password, user.password); 401 on mismatch/inactive
4. jwt.sign({ userId, email, role }, JWT_SECRET, { expiresIn: '8h' })
5. Response { success, token, user }
6. AuthContext stores token + user in localStorage; sets state
7. apiClient interceptor attaches Authorization: Bearer <token> on every call
8. On any 401 response: interceptor clears storage and redirects to /login
```

### AWS Perspective
```
ALB → backend ECS task (Express)
  → Prisma: User.findUnique (users table)
  → bcrypt compare (CPU, in-process)
  → jwt.sign (in-process, HMAC-SHA256)
  → RDS unaffected beyond the initial read
```

### Failure Perspective
| Failure | Status | Behavior |
|---|---|---|
| Wrong password / unknown email / inactive user | 401 | `Invalid email or password.` (deliberately identical message) |
| Missing Bearer header on a protected route | 401 | `Authentication token required.` |
| Expired token | 401 | `Token expired.` (distinct from invalid) |
| Tampered/malformed token | 401 | `Invalid token.` |
| Production with insecure JWT secret | — | Server refuses to start (`process.exit(1)`) |

---

## Flow 2: Inventory Creation

### Business Perspective
An OPERATIONS (or ADMIN) user opens Inventory, clicks "Add Record", picks an item and a location, enters a physical quantity and optional batch, and submits. The new row appears with `availableQty` computed.

### Technical Perspective
```
1. Inventory.tsx modal submits { itemId, locationId, physicalQty, batchNumber? }
2. POST /api/inventory  (authenticate + authorize(ADMIN, OPERATIONS))
3. validate: itemId/locationId required; physicalQty non-negative int; batch optional
4. Verify item + location exist (404 otherwise)
5. batch = batchNumber?.trim() || 'DEFAULT'
6. prisma.inventory.create({ data: { itemId, locationId, batchNumber: batch, physicalQty } })
7. If physicalQty > 0: create InventoryTransaction (type IN, "Initial stock")
8. Return 201 with withAvailable(inventory)  ← availableQty = physical − reserved
```

### AWS Perspective
```
ALB → backend task → Prisma
  → Item.findUnique, Location.findUnique
  → Inventory.create (insert)
  → InventoryTransaction.create (insert)
  → RDS commit
```

### Failure Perspective
| Failure | Status | Behavior |
|---|---|---|
| Item/location not found | 404 | `Item not found.` / `Location not found.` |
| Duplicate (item, location, batch) | 409 | Prisma P2002 → `A record with this value already exists.` |
| physicalQty negative | 422 | Validation failed |
| Wrong role (SALES) | 403 | `Access denied. Required role: ADMIN or OPERATIONS.` |

---

## Flow 3: Manual Stock Adjustment

### Business Perspective
An OPERATIONS user adjusts stock IN (restock) or OUT (consumption/damage) on an inventory row, with an optional reason and an optional idempotency key. The system never lets physical stock go negative or below reserved stock.

### Technical Perspective
```
1. PATCH /api/inventory/:id/adjust { transactionType: IN|OUT, quantity, reason?, referenceKey? }
2. prisma.$transaction:
   a. SELECT id, physicalQty, reservedQty FROM inventory WHERE id = ? FOR UPDATE
   b. newPhysical = IN ? physical + qty : physical − qty
   c. If newPhysical < 0 → 422 "would result in negative stock"
   d. If newPhysical < reservedQty → 422 "release reservations first"
   e. Insert InventoryTransaction (with referenceKey if provided)
   f. UPDATE inventory SET physicalQty = newPhysical
3. Return withAvailable(updated)
```

### AWS Perspective
```
ALB → backend task → Prisma $transaction
  → SELECT ... FOR UPDATE (row lock)
  → InventoryTransaction.create
  → Inventory.update
  → RDS commit (lock released)
```

### Failure Perspective
| Failure | Status | Behavior |
|---|---|---|
| OUT that would go negative | 422 | `Adjustment would result in negative stock...` |
| OUT that would drop physical below reserved | 422 | `...less than reserved stock... Release reservations first.` |
| Duplicate referenceKey | 409 | P2002 → duplicate value |
| Inventory row missing | 404 | `Inventory record not found.` |

---

## Flow 4: Work Order Creation and Shortage

### Business Perspective
An ADMIN creates a work order: "we need 50 units of Steel Rod at Shop Floor, assigned to Ops User." The list immediately shows `shortageQty` = how many more units are needed given current availability.

### Technical Perspective
```
1. POST /api/work-orders { locationId, itemId, requiredQty, assignedToId, notes? }  (ADMIN only)
2. Verify location, item, assigned user exist (404)
3. workOrderNumber = `WO-${String(count+1).padStart(5,'0')}`   ← low-frequency path
4. Snapshot itemName + itemSku at creation
5. prisma.workOrder.create({ ..., status: ASSIGNED })
6. getInventoryAvailability(itemId, locationId): sum physical & reserved across batches → availableQty
7. Return 201 with shortageQty = max(requiredQty − availableQty, 0)
```

### AWS Perspective
```
ALB → backend task → Prisma
  → Location/Item/User findUnique
  → WorkOrder.create
  → Inventory.findMany (sum) → compute
  → RDS
```

### Failure Perspective
| Failure | Status | Behavior |
|---|---|---|
| Assigned user/location/item missing | 404 | respective message |
| requiredQty < 1 | 422 | validation |
| Non-ADMIN role | 403 | `Access denied. Required role: ADMIN.` |

---

## Flow 5: Work Order Status Advance

### Business Perspective
An OPERATIONS (or ADMIN) user moves a work order forward: ASSIGNED → IN_PROGRESS (start), then → COMPLETED (finish). Backward or skip transitions are rejected.

### Technical Perspective
```
1. PATCH /api/work-orders/:id/status { status }  (ADMIN, OPERATIONS)
2. Read current work order
3. allowedNext = transitions[current]  (ASSIGNED→IN_PROGRESS, IN_PROGRESS→COMPLETED, COMPLETED→null)
4. If newStatus !== allowedNext → 400 with the expected next status
5. Update status; set startedAt (on IN_PROGRESS) / completedAt (on COMPLETED)
```

### Failure Perspective
| Failure | Status | Behavior |
|---|---|---|
| ASSIGNED → COMPLETED | 400 | `Invalid transition: ASSIGNED → COMPLETED. Expected next status: IN_PROGRESS.` |
| COMPLETED → anything | 400 | `...none (already completed)` |
| Wrong role (SALES) | 403 | denied |

---

## Flow 6: Transfer Dispatch

### Business Perspective
An OPERATIONS user dispatches a REQUESTED transfer. Source stock drops by the transfer quantity; destination is untouched. Stock is now "in transit." If the source doesn't have enough available stock, dispatch is refused and nothing changes.

### Technical Perspective
```
1. PATCH /api/transfers/:id/dispatch  (ADMIN, OPERATIONS)
2. prisma.$transaction:
   a. Read transfer; assert status === REQUESTED (else 400)
   b. SELECT id, physicalQty, reservedQty FROM inventory
      WHERE itemId=? AND locationId=source ORDER BY id FOR UPDATE
   c. If no source rows → 422 "no inventory record at source"
   d. totalAvailable = Σ(physical − reserved); if < transfer.quantity → 422
   e. Deduct FIFO across source rows:
        for each row: deduct = min(available, remaining); physicalQty -= deduct
        InventoryTransaction(OUT, reason, referenceKey=`dispatch-<transferId>-<rowId>`)
   f. UPDATE transfer SET status=DISPATCHED, dispatchedBy, dispatchedAt
3. Return updated transfer
```

### AWS Perspective
```
ALB → backend task → Prisma $transaction
  → SELECT ... FOR UPDATE (locks source rows)
  → Inventory.update (per row), InventoryTransaction.create (per row)
  → StockTransfer.update
  → RDS commit
```

### Failure Perspective
| Failure | Status | Behavior |
|---|---|---|
| Insufficient available at source | 422 | `Insufficient available stock at source. Available: X, requested: Y.` |
| No inventory row at source | 422 | `No inventory record found at source location for this item.` |
| Not REQUESTED (e.g., already DISPATCHED) | 400 | `Transfer cannot be dispatched. Current status: DISPATCHED.` |
| Wrong role (SALES) | 403 | denied |

---

## Flow 7: Transfer Receipt

### Business Perspective
An OPERATIONS user receives a DISPATCHED transfer. Destination stock rises by the transfer quantity. Receiving the same transfer again is rejected — destination does not increase a second time.

### Technical Perspective
```
1. PATCH /api/transfers/:id/receive  (ADMIN, OPERATIONS)
2. prisma.$transaction:
   a. SELECT id, status, destLocationId, itemId, quantity, transferNumber
      FROM stock_transfers WHERE id=? FOR UPDATE        ← locks the transfer row
   b. If not found → 404; if status !== DISPATCHED → 400   ← double-receipt guard
   c. Find or create destination inventory (DEFAULT batch)
   d. SELECT id FROM inventory WHERE id=destInv.id FOR UPDATE
   e. UPDATE inventory SET physicalQty += transfer.quantity
   f. InventoryTransaction(IN, reason, referenceKey=`receive-<transferId>`)
   g. UPDATE transfer SET status=RECEIVED, receivedBy, receivedAt
3. Return updated transfer
```

### AWS Perspective
```
ALB → backend task → Prisma $transaction
  → SELECT ... FOR UPDATE (locks transfer row, then dest inventory row)
  → Inventory.findFirst or create + update
  → InventoryTransaction.create
  → StockTransfer.update
  → RDS commit
```

### Failure Perspective
| Failure | Status | Behavior |
|---|---|---|
| Double-receipt (status is RECEIVED) | 400 | `Transfer cannot be received. Current status: RECEIVED. Only DISPATCHED transfers can be received.` |
| Not yet dispatched (status REQUESTED) | 400 | same family message |
| Wrong role (SALES) | 403 | denied |

---

## Flow 8: Customer Order Create → Confirm (the concurrency-critical flow)

### Business Perspective
A SALES user creates a customer order (PENDING — no stock reserved yet), then confirms it. On confirm, the requested items are reserved against specific inventory rows. If two sales users confirm orders that together exceed what is available, exactly one succeeds and the other is told which item was insufficient.

### Technical Perspective
```
1. POST /api/orders { customerName, locationId, items:[{ inventoryId, quantity }] }  (ADMIN, SALES)
   - Verify location + each inventory row; snapshot itemName/SKU/unitPrice per OrderItem
   - orderNumber = `ORD-${Date.now()}-${random5}`   ← collision-safe
   - Create PENDING order; return 201 (no reservation)

2. PATCH /api/orders/:id/confirm  (ADMIN, SALES)
   prisma.$transaction:
     a. Read order + items; assert status === PENDING (else 400)
     b. distinct inventoryIds.sort()        ← deterministic order
     c. SELECT id, physicalQty, reservedQty FROM inventory
        WHERE id = ANY($ids) ORDER BY id FOR UPDATE
     d. For each item: if available < requested → push to insufficient[]
     e. If any insufficient → throw AppError(422, ..., { insufficientItems }) → ROLLBACK
     f. For each item: UPDATE inventory SET reservedQty += quantity
     g. UPDATE customer_orders SET status=CONFIRMED, confirmedAt
   → COMMIT
```

### AWS Perspective
```
ALB → backend task → Prisma $transaction
  → SELECT ... FOR UPDATE (locks all referenced inventory rows in id order)
  → Inventory.update (per item), CustomerOrder.update
  → RDS commit (locks released)
```

### Failure Perspective
| Failure | Status | Behavior |
|---|---|---|
| Insufficient stock on any item | 422 | `Insufficient available stock for one or more items.` + `details.insufficientItems[]` (per-item available vs requested) |
| Already CONFIRMED/CANCELLED | 400 | `Order is already confirmed/cancelled.` |
| Concurrent over-reservation | 422 | Second confirm blocks on the lock, then sees the raised reservedQty and fails — never over-reserves |
| Wrong role (OPERATIONS) | 403 | denied |

---

## Flow 9: Customer Order Cancel

### Business Perspective
A SALES user cancels an order. If it was CONFIRMED, the reserved stock is released (available goes back up). If it was only PENDING, only the status changes.

### Technical Perspective
```
1. PATCH /api/orders/:id/cancel  (ADMIN, SALES)
2. prisma.$transaction:
   a. Read order + items; if already CANCELLED → 400
   b. If status === CONFIRMED: for each item, UPDATE inventory SET reservedQty -= quantity
   c. UPDATE customer_orders SET status=CANCELLED, cancelledAt
3. Return CANCELLED order
```

### Failure Perspective
| Failure | Status | Behavior |
|---|---|---|
| Already cancelled | 400 | `Order is already cancelled.` |
| Wrong role | 403 | denied |

---

## Flow 10: Dashboard

### Business Perspective
Any role opens the app and sees aggregate counts: items, locations, inventory records, total physical/reserved/available, open work orders, pending/dispatched transfers, pending/confirmed orders.

### Technical Perspective
```
1. GET /api/dashboard  (ALL roles)
2. Promise.all of eight prisma count/aggregate calls in parallel:
   - item.count, location.count, inventory.count
   - workOrder.count(status in [ASSIGNED, IN_PROGRESS])
   - stockTransfer.count(REQUESTED), stockTransfer.count(DISPATCHED)
   - customerOrder.count(PENDING), customerOrder.count(CONFIRMED)
   - inventory.aggregate({ _sum: physicalQty, reservedQty })
3. totalAvailable = totalPhysical − totalReserved   ← computed
4. Return aggregated data
```

### AWS Perspective
```
ALB → backend task → Prisma (parallel counts + one aggregate) → RDS
```

### Failure Perspective
| Failure | Status | Behavior |
|---|---|---|
| DB unreachable | 500 | unhandled error envelope |
| Unauthenticated | 401 | required |


---

**Read next:** [06 — Data Modeling →](06-Data-Modeling.md)

[← Back to documentation index](README.md)
