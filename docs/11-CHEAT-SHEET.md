# Interview Cheat Sheet

All answers are grounded in this repository's actual code.

---

## What is this application?

**Simple:** A stock management system for a company with multiple warehouses. It tracks where stock is, moves it between locations, manages work orders that need stock, and lets sales users reserve stock for customers.

**Technical:** A full-stack TypeScript application implementing the flow: Inventory → Work Order → Internal Transfer → Customer Reservation. Built with React 18 + Vite frontend, Node.js + Express + Prisma backend, PostgreSQL database, deployed on AWS ECS Fargate with a GitLab CI/CD pipeline.

---

## What problem does it solve?

Without it: Two sales users could both see "10 Steel Rods available" and both promise 8 to different customers. The system would promise 16 units when only 10 exist.

With it: When User A confirms an order for 8, the system locks the inventory row in the database and reserves exactly 8. When User B tries to confirm for 8 simultaneously, the lock makes their request wait, re-read the updated `reservedQty=8`, calculate `available=2`, and correctly fail with 422.

---

## Explain the architecture

```
Browser → React SPA (Vite + Tailwind)
  ↓ Axios (with JWT interceptor)
nginx (SPA fallback + /api/* proxy)
  ↓
Express API (Node.js 20, TypeScript)
  ├── JWT middleware (authenticate)
  ├── RBAC middleware (authorize)
  ├── express-validator (validate)
  └── Prisma ORM
        ↓
PostgreSQL 15 (RDS in production)
```

Production: AWS ECS Fargate (frontend + backend containers) behind an Application Load Balancer. Secrets in SSM SecureString. GitLab CI/CD builds images → pushes to ECR → updates ECS service.

---

## Explain frontend to backend flow

```
1. User clicks "Confirm" on an order
2. React handler calls ordersApi.confirm(id)
3. ordersApi.confirm calls apiClient.patch('/orders/${id}/confirm')
4. Axios interceptor attaches "Authorization: Bearer <JWT>"
5. Request reaches Express
6. authenticate() verifies JWT → req.user set
7. authorize(ADMIN, SALES) checks role → allowed
8. validate() checks params → valid
9. Route handler runs prisma.$transaction(...)
10. SELECT FOR UPDATE locks inventory rows
11. Check available stock
12. UPDATE reservedQty += quantity
13. UPDATE order.status = CONFIRMED
14. COMMIT
15. Response: 200 { data: { status: "CONFIRMED" } }
16. React state updates → table re-renders with CONFIRMED badge
```

---

## Explain backend to database flow

```
Request arrives at Express
  ↓ Middleware runs (authenticate, authorize, validate)
  ↓ Route handler executes
  ↓ prisma.inventory.findMany(...)
     ↑ Prisma generates SQL: SELECT * FROM inventory WHERE ...
     ↑ PrismaClient sends to PostgreSQL connection pool
     ↑ PostgreSQL executes, returns rows
     ↑ Prisma maps rows to TypeScript objects
  ↓ Route handler returns res.json(...)
```

For transactions:
```
prisma.$transaction(async (tx) => { ... })
↓ BEGIN; (PostgreSQL)
  tx.$queryRaw`SELECT ... FOR UPDATE` → PostgreSQL row lock acquired
  tx.inventory.update(...)           → UPDATE statement executed
  tx.customerOrder.update(...)       → UPDATE statement executed
↓ COMMIT; (if no throws) or ROLLBACK; (if throw)
```

---

## Why PostgreSQL?

Three reasons for this application:
1. **ACID transactions with row-level locking** — The concurrent reservation problem requires `SELECT FOR UPDATE`. PostgreSQL supports this natively. SQLite doesn't support concurrent writes; MySQL supports it but has different locking semantics.
2. **Prisma support** — Prisma has excellent PostgreSQL support including raw queries via `$queryRaw`.
3. **Production-grade** — RDS PostgreSQL handles backups, read replicas, and encryption out of the box.

---

## Why Prisma?

1. **Type safety** — Every query returns TypeScript types matching the schema. A schema change automatically breaks TypeScript compilation in affected queries — you can't forget to update a query.
2. **Migration system** — `prisma migrate dev` generates SQL from schema changes, versions them, and tracks what's been applied.
3. **`$transaction()`** — Clean API for wrapping operations in database transactions.
4. **`$queryRaw`** — Escape hatch to raw SQL for `SELECT FOR UPDATE`, which Prisma's ORM API doesn't support.

---

## Why JWT?

**Simple:** A signed "badge" that proves who you are without needing a database lookup every request.

**Technical:** After login, the server signs `{ userId, email, role }` with `JWT_SECRET` using HS256. The client stores this token and sends it in every request header. The server verifies the signature with the same secret — if it matches and isn't expired, the payload is trusted. No session table needed.

**Tradeoff:** If a user is deleted after login, their JWT is still valid until it expires (8 hours). This application accepts this tradeoff.

---

## Why bcrypt?

Passwords must never be stored in plain text. `bcrypt.hash(password, 10)` applies a one-way hash with a salt (prevents rainbow table attacks) and 2^10 = 1024 rounds (makes brute-force slow). `bcrypt.compare(plain, hash)` verifies without knowing the original password.

---

## What is RBAC?

Role-Based Access Control. Users are assigned a role (ADMIN, OPERATIONS, SALES). Each API endpoint specifies which roles are allowed. The `authorize(...roles)` middleware enforces this.

```
// In routes/transfers.ts:
router.patch('/:id/dispatch', authorize(Role.ADMIN, Role.OPERATIONS), ...)

// If a SALES user hits this endpoint:
// authorize() reads req.user.role = 'SALES'
// 'SALES' not in [ADMIN, OPERATIONS]
// Returns HTTP 403
// Route handler never executes
```

---

## What is middleware?

A function that runs between the HTTP request arriving and the route handler executing. Middleware can: read/modify the request, send a response early, or call `next()` to pass to the next middleware.

In this application, the middleware chain for every protected route is:
```
morgan (logging) → express.json (body parsing) → authenticate (JWT) → authorize (role) → validate (input) → route handler
```

---

## What is a transaction?

A group of database operations that all succeed or all fail together. In this application, `prisma.$transaction()` wraps multiple Prisma calls in a single PostgreSQL `BEGIN ... COMMIT / ROLLBACK`.

**Why they're needed:** Without a transaction, if the `UPDATE reservedQty` succeeds but the `UPDATE order.status` fails, the inventory would be reserved but the order would still show PENDING. Data would be corrupted. The transaction ensures both happen or neither happens.

---

## What is SELECT FOR UPDATE?

A PostgreSQL statement that reads a row AND locks it. Other transactions trying to read the same row with `FOR UPDATE` will block (wait) until the first transaction finishes.

**In this application — order confirmation:**
```sql
SELECT id, "physicalQty", "reservedQty"
FROM inventory
WHERE id = ANY(ARRAY['id1','id2'])
ORDER BY id   -- deterministic order prevents deadlock
FOR UPDATE
```

This prevents two concurrent confirmations from both reading `available=10`, both deciding to reserve 8, and both succeeding — which would leave `reservedQty=16 > physicalQty=10`.

---

## Why is SELECT FOR UPDATE needed? Why isn't `prisma.$transaction()` enough?

Prisma transactions run at PostgreSQL's default isolation level: **READ COMMITTED**. At this level, a transaction sees data as it was committed when it reads it — but two transactions can both read the same row before either has written.

```
Without FOR UPDATE:
  A reads: reservedQty=0, available=10
  B reads: reservedQty=0, available=10  (A hasn't committed yet)
  A: available(10) >= 8 → reserve 8 → reservedQty=8 → commit
  B: available(10) >= 8 → reserve 8 → reservedQty=8 → commit (!!!!)
  Final: reservedQty=8 (B overwrote A's write — actually 16 if using increment)

With FOR UPDATE:
  A: SELECT FOR UPDATE → acquires lock
  B: SELECT FOR UPDATE → BLOCKS
  A: commits → releases lock
  B: unblocks → re-reads reservedQty=8 → available=2 → 2<8 → 422
```

---

## How do you prevent over-reservation?

```
1. Accept the order as PENDING (no stock check)
2. On confirm: BEGIN TRANSACTION
3. SELECT all affected inventory rows ORDER BY id FOR UPDATE
4. Re-read physicalQty and reservedQty inside the locked transaction
5. Compute available = physicalQty - reservedQty
6. If any item: available < requested → THROW → ROLLBACK
7. Otherwise: UPDATE reservedQty += quantity for all items
8. UPDATE order.status = CONFIRMED
9. COMMIT
```

---

## How do you prevent over-transfer (dispatching more than available)?

Same pattern but on source inventory rows:
```
SELECT ... FROM inventory WHERE itemId=$x AND locationId=$source FOR UPDATE
totalAvailable = SUM(physicalQty - reservedQty)
if (totalAvailable < transfer.quantity) → THROW 422 → ROLLBACK
else: UPDATE physicalQty -= quantity
```

---

## Why doesn't destination stock increase on dispatch?

Because the stock hasn't arrived yet. Dispatch means "sent from source." Receipt means "arrived at destination." If destination stock increased on dispatch, warehouse staff could reserve stock that hasn't physically arrived and might never arrive (transfer could be lost or damaged in transit).

In the code: the dispatch transaction only touches `sourceLocation` inventory and the `stock_transfers` row. There is no `tx.inventory.update` for the destination in the dispatch transaction.

---

## How do you prevent double receipt?

Two mechanisms:

1. **Status check inside the transaction:**
```typescript
SELECT ... FROM stock_transfers WHERE id=$id FOR UPDATE  // lock the transfer row
if (transfer.status !== 'DISPATCHED') throw AppError(400, ...)
// After first receive commits: status='RECEIVED' → this always fails
```

2. **Unique referenceKey:**
```typescript
await tx.inventoryTransaction.create({
  data: { referenceKey: `receive-${transfer.id}` }  // unique constraint
})
// Second receive (if somehow it passes status check) → 409 on this insert
```

---

## How does availableQty work?

It's never stored in the database. It's always computed:
```typescript
availableQty = physicalQty - reservedQty
```

The `withAvailable()` function in `routes/inventory.ts` adds it to every response:
```typescript
function withAvailable(inv) {
  return { ...inv, availableQty: inv.physicalQty - inv.reservedQty };
}
```

Why computed: If stored, every operation changing `physicalQty` or `reservedQty` would also need to update `availableQty`. Any bug in that synchronization creates inconsistency. Computing from source fields guarantees correctness.

---

## How do you handle authorization?

```typescript
// STEP 1: authenticate() attaches req.user after verifying JWT
const payload = jwt.verify(token, JWT_SECRET);
req.user = { userId, email, role };

// STEP 2: authorize() checks role
if (!roles.includes(req.user.role)) {
  throw new AppError(403, 'Access denied.');
}
```

Each route specifies which roles are allowed:
```typescript
router.patch('/:id/dispatch', authorize(Role.ADMIN, Role.OPERATIONS), handler)
```

---

## How do you prevent negative stock?

Three places:

1. **Inventory adjust (OUT):**
```typescript
if (newPhysicalQty < 0) throw new AppError(422, 'Negative stock...');
if (newPhysicalQty < inv.reservedQty) throw new AppError(422, 'Below reserved...');
```

2. **Transfer dispatch:**
```typescript
if (totalAvailable < transfer.quantity) throw new AppError(422, 'Insufficient stock...');
// Only dispatches up to available (physicalQty - reservedQty)
```

3. **Order reservation never touches physicalQty** — only `reservedQty`. Physical stock cannot go negative from reservations alone.

---

## What is an idempotency key / referenceKey?

**Simple:** A label that says "this specific action already happened." If the action is attempted again with the same label, the database rejects it.

**Technical:** `InventoryTransaction.referenceKey String? @unique`. System-generated keys like `"dispatch-<transferId>-<invRowId>"` and `"receive-<transferId>"` ensure that even if a network retry calls the dispatch or receive endpoint twice, the second attempt fails with a 409 (unique constraint violation) rather than double-changing stock.

---

## What happens if a database operation fails halfway?

The entire `prisma.$transaction()` rolls back. Example:

```typescript
await prisma.$transaction(async (tx) => {
  await tx.inventory.update(...);    // Step 1: succeeds
  await tx.inventoryTransaction.create(...);  // Step 2: referenceKey collision → throws
  // Step 3 never runs
});
// Prisma catches the throw → ROLLBACK
// Step 1's UPDATE is UNDONE
```

The caller receives an error (409 if it was a unique violation). The database is in the same state as before the transaction started.

---

## How would you modify the system for damaged stock?

1. Add `damagedQty Int @default(0)` to `Inventory` in schema
2. Run migration: `prisma migrate dev --name add_damaged_qty`
3. Update `withAvailable()`: `availableQty = physicalQty - reservedQty - damagedQty`
4. Add damage adjustment to the adjust endpoint or create a new dedicated endpoint
5. Update frontend Inventory table to show damagedQty column
6. Update frontend types
7. Write tests verifying damagedQty reduces availableQty

---

## What was the hardest technical part?

The concurrent reservation problem. A naive implementation would have both users see "10 available" and both succeed. The solution required:

1. Understanding that `prisma.$transaction()` alone does NOT prevent this at READ COMMITTED isolation
2. Using raw SQL `SELECT ... FOR UPDATE` inside the Prisma transaction
3. Sorting inventory IDs before locking to prevent deadlock
4. Writing a concurrent test with `Promise.all([confirm1, confirm2])` to prove it works

---

## What would you improve?

Already documented in `docs/KNOWN_LIMITATIONS.md`:

1. **JWT refresh tokens** — Current 8h expiry means users get logged out mid-session. A refresh token pattern would provide seamless re-authentication.
2. **Rate limiting** — No `express-rate-limit` middleware. In production, the login endpoint should be rate-limited to prevent credential stuffing attacks.
3. **Frontend tests** — No Vitest/RTL tests. The backend has 74 integration tests but the frontend UI is untested.
4. **Partial transfer receipt** — Currently all-or-nothing. Real logistics often require partial receipts.
5. **`damagedQty` field** — Stock damaged in the warehouse reduces available stock but shouldn't affect `physicalQty` accounting.
