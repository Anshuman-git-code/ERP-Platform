# 20 — Complete Request Flow

> A single request traced end to end through every layer. The chosen request is `PATCH /api/orders/:id/confirm` — the concurrency-critical reservation path — because it exercises every layer and the most important logic in the system.

---

## The Scenario

A SALES user, logged in, clicks "Confirm" on a PENDING order that reserves 8 units of an item against an inventory row that has `physicalQty = 10, reservedQty = 0`. Simultaneously, another SALES user confirms a different PENDING order reserving 8 units of the same inventory row.

---

## Step 1 — Browser (React)

```
Orders.tsx → ordersApi.confirm(orderId)
  → apiClient.patch('/api/orders/:id/confirm')
  → axios request interceptor: read localStorage 'token'
    → headers.Authorization = 'Bearer <jwt>'
  → request leaves the browser to /api/orders/:id/confirm
```

`apiClient` was created with `baseURL = import.meta.env.VITE_API_BASE_URL ?? '/api'` (baked into the bundle as `/api`). The interceptor guarantees every call carries the token; a 401 response interceptor clears `token`/`user` and redirects to `/login`.

---

## Step 2 — ALB (path routing)

```
ALB receives PATCH /api/orders/:id/confirm
  listener rule (priority 10): path matches /api/* → forward to backend target group
  (default action would have sent /* to the frontend target group)
  → backend target group → a healthy backend ECS task (IP target)
```

The ALB's health check (`/health`, 30s) means only a task returning 200 receives traffic.

---

## Step 3 — Express global middleware

```
app receives the request
  trust proxy = 1          → reads X-Forwarded-* correctly behind ALB/nginx
  cors(allowedOrigin)       → origin is the ALB DNS in prod; credentials allowed
  morgan('combined')        → one structured log line via winston
  express.json({ limit: '1mb' }) → parses the (empty) JSON body
  → next() into the router
```

---

## Step 4 — Router-level auth + handler-level authz + validation

```
router.use(authenticate)   → authenticate(req, res, next)
  → reads Authorization: Bearer <jwt>
  → jwt.verify(token, JWT_SECRET) → payload { userId, email, role, iat, exp }
  → req.user = { userId, email, role }
  (no Bearer → 401; expired → 401 "Token expired"; invalid → 401 "Invalid token")

authorize(Role.ADMIN, Role.SALES)   → 403 if role is OPERATIONS
  (SALES passes)

validate    → express-validator chain (param('id').notEmpty()) → no errors → next()
```

---

## Step 5 — The handler opens a transaction

```typescript
const confirmed = await prisma.$transaction(async (tx) => {
  // 5a. Read the order with its items; assert PENDING
  const order = await tx.customerOrder.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order) throw new AppError(404, 'Order not found.');
  if (order.status !== OrderStatus.PENDING)
    throw new AppError(400, `Order is already ${order.status.toLowerCase()}.`);
```

At this point two concurrent confirms (A and B) have both read their orders and are about to lock the same inventory row.

---

## Step 6 — Lock the inventory rows (the serialization point)

```typescript
  const inventoryIds = [...new Set(order.items.map((i) => i.inventoryId))].sort();
  const lockedRows = await tx.$queryRaw`
    SELECT id, "physicalQty", "reservedQty"
    FROM inventory
    WHERE id = ANY(${inventoryIds}::text[])
    ORDER BY id
    FOR UPDATE
  `;
```

```
Confirm A: acquires the row lock first   → proceeds
Confirm B: blocks on the same row        → waits for A to commit
```

The `ORDER BY id` is the deadlock-avoidance guarantee: both lock in the same order, so no cycle can form.

---

## Step 7 — Availability check

```typescript
  const inventoryMap = new Map(lockedRows.map((r) => [r.id, r]));
  const insufficient = [];
  for (const item of order.items) {
    const inv = inventoryMap.get(item.inventoryId);
    const available = inv.physicalQty - inv.reservedQty;     // 10 - 0 = 10
    if (available < item.quantity) insufficient.push({ ... }); // 8 < 10? no
  }
  if (insufficient.length > 0)
    throw new AppError(422, 'Insufficient available stock...', { insufficientItems: insufficient });
```

Confirm A: `available = 10`, requested `8` → passes. Confirm B will re-evaluate after A commits.

---

## Step 8 — Reserve and commit

```typescript
  for (const item of order.items) {
    await tx.inventory.update({
      where: { id: item.inventoryId },
      data: { reservedQty: { increment: item.quantity } },    // reservedQty 0 → 8
    });
  }
  return tx.customerOrder.update({
    where: { id: orderId },
    data: { status: OrderStatus.CONFIRMED, confirmedAt: new Date() },
  });
});  // COMMIT → locks released
```

---

## Step 9 — Confirm B unblocks and fails

```
Confirm B's SELECT ... FOR UPDATE now unblocks.
  It re-reads reservedQty = 8 (A's committed value).
  available = 10 - 8 = 2
  requested = 8 → 2 < 8 → insufficient
  → throw AppError(422, 'Insufficient available stock for one or more items.',
                   { insufficientItems: [{ inventoryId, itemName, available: 2, requested: 8 }] })
  → ROLLBACK (no reservation applied)
```

Exactly one confirm succeeded; the other received a clear 422 naming the insufficient item. `reservedQty` is `8`, never `16`. The invariant holds.

---

## Step 10 — Response back through the layers

```
Confirm A: handler returns confirmed order
  → res.json({ success: true, data: confirmedOrder })
  → ALB → browser
  → Orders.tsx updates the row to CONFIRMED

Confirm B: AppError(422) thrown
  → express-async-errors routes to errorHandler
  → err instanceof AppError → res.status(422).json({
      success: false,
      message: 'Insufficient available stock for one or more items.',
      details: { insufficientItems: [...] }
    })
  → ALB → browser
  → Orders.tsx shows the 422 and the insufficient item to the salesperson
```

---

## Step 11 — Persistence state after both

```
inventory row: physicalQty = 10, reservedQty = 8, availableQty = 2 (computed)
order A: status = CONFIRMED, confirmedAt = now
order B: status = PENDING (unchanged — its confirm failed/rolled back)
InventoryTransaction: none written for B (confirm doesn't write audit rows;
  only dispatch/receive/adjust do)
```

---

## The Layers Touched, In Order

```
Browser (axios interceptor)
  → ALB (path rule → backend target group)
    → Express global middleware (trust proxy, cors, morgan, json)
      → authenticate (jwt.verify → req.user)
        → authorize(ADMIN, SALES) (role check)
          → validate (express-validator)
            → handler
              → prisma.$transaction
                → customerOrder.findUnique (status check)
                → $queryRaw SELECT ... FOR UPDATE (serialize)
                → availability check
                → inventory.update reservedQty += (or throw → rollback)
                → customerOrder.update status = CONFIRMED
              → COMMIT
            → res.json / errorHandler 422
          ← ALB ← browser
```

One request, every layer, and the single database lock that makes the whole system trustworthy.


---

**Read next:** back to [01 — Business Requirements](01-Business-Requirements.md)

[← Back to documentation index](README.md)
