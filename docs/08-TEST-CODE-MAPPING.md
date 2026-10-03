# Test-to-Code Mapping

## Test Infrastructure

### `src/__tests__/setup.ts`
**What it does:** Runs before every test file. Overrides environment variables so tests use the test database, not the development database.

```typescript
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://erp_user:devpassword123@localhost:5432/ops_erp_test?schema=public';
process.env.JWT_SECRET = 'test_secret_do_not_use_in_production_abcdef1234567890';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';  // suppress log noise
```

**Why a separate test database:** Tests create and delete records constantly. Running against the development database would pollute it and cause test-to-test interference.

**How tests import it:** Every test file has `import './setup';` as the first import. This ensures the env vars are overridden before `app.ts` (which reads them) is imported.

**The test pattern used throughout:**
```
beforeAll → create users, get tokens, create fixtures
afterAll  → clean up in dependency order (children before parents)
describe  → group related tests
it        → one specific assertion
```

---

## Mandatory Test 1: Cannot Reserve More Than Available

**File:** `src/__tests__/orders.test.ts`

### Chain: Test → API → Route → Business Logic → Prisma → DB → Assertion

```
TEST: "returns 422 when requested quantity exceeds available (10 available, request 15)"
  │
  │ Setup: resetInventory(10, 0) → physicalQty=10, reservedQty=0
  │
  ↓ HTTP: POST /api/orders  (creates PENDING order for qty 15)
  │   → backend/src/routes/orders.ts POST /
  │   → prisma.customerOrder.create (status=PENDING, NO stock check yet)
  │   → 201 response
  │
  ↓ HTTP: PATCH /api/orders/:id/confirm
  │   → routes/orders.ts PATCH /:id/confirm
  │   → prisma.$transaction()
  │      → SELECT id, physicalQty=10, reservedQty=0 FROM inventory FOR UPDATE
  │      → available = 10 - 0 = 10
  │      → 10 < 15 → insufficient = [{ available: 10, requested: 15 }]
  │      → throw AppError(422)
  │      → ROLLBACK
  │   → errorHandler returns: { success: false, message: "Insufficient...", details: { insufficientItems } }
  │
  ↓ ASSERTION:
    expect(confirmRes.status).toBe(422);
    expect(confirmRes.body.details.insufficientItems[0].available).toBe(10);
    expect(confirmRes.body.details.insufficientItems[0].requested).toBe(15);
```

### The Concurrency Test (most important)

```
TEST: "only one of two simultaneous reservations succeeds when combined qty > available"
  │
  │ Setup: resetInventory(10, 0) → 10 available
  │
  │ Create TWO pending orders, each requesting qty=8 (combined=16 > 10)
  │   [POST /api/orders × 2]
  │   → Both succeed (201) — creating an order doesn't reserve stock
  │
  ↓ Fire both confirms SIMULTANEOUSLY:
    const [confirmRes1, confirmRes2] = await Promise.all([
      request(app).patch('/api/orders/${id1}/confirm')...,
      request(app).patch('/api/orders/${id2}/confirm')...,
    ]);
  │
  │ What happens at the DB level:
  │   Transaction A: BEGIN → SELECT FOR UPDATE (acquires lock)
  │   Transaction B: BEGIN → SELECT FOR UPDATE → BLOCKED (waits)
  │   Transaction A: available=10, 10>=8 → reserves 8 → reservedQty=8 → COMMIT
  │   Transaction B: UNBLOCKED → re-reads reservedQty=8 → available=10-8=2 → 2<8 → 422 ROLLBACK
  │
  ↓ ASSERTIONS:
    expect(statuses.filter(s => s === 200).length).toBe(1);   // exactly one succeeded
    expect(statuses.filter(s => s === 422).length).toBe(1);   // exactly one failed
  │
  ↓ Verify DB state:
    const inv = await prisma.inventory.findUnique({ where: { id: inventoryId } });
    expect(inv!.reservedQty).toBe(8);   // not 16!
    expect(inv!.physicalQty).toBe(10);  // unchanged
```

**Why this test matters:** It proves the `SELECT FOR UPDATE` is actually working. If the lock were removed, BOTH requests could succeed and `reservedQty` would be 16 against `physicalQty` of 10.

---

## Mandatory Test 2: Cannot Transfer More Than Available

**File:** `src/__tests__/transfers.test.ts`

```
TEST: "dispatch returns 422 when quantity exceeds available stock"
  │
  │ Setup: sourceInventory physicalQty=50, reservedQty=0 → available=50
  │
  │ Create transfer for quantity=100 (exceeds available)
  │   POST /api/transfers → { sourceLocationId: A, destLocationId: B, quantity: 100 }
  │   → Creates REQUESTED transfer (no stock check yet)
  │   → 201 response
  │
  ↓ PATCH /api/transfers/:id/dispatch
  │   → routes/transfers.ts PATCH /:id/dispatch
  │   → prisma.$transaction()
  │      → status check: REQUESTED ✓
  │      → SELECT id, physicalQty=50, reservedQty=0 FROM inventory ... FOR UPDATE
  │      → totalAvailable = 50 - 0 = 50
  │      → 50 < 100 → throw AppError(422, "Insufficient stock. Available: 50, requested: 100.")
  │      → ROLLBACK
  │
  ↓ ASSERTIONS:
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/insufficient/i);

  ↓ Verify DB unchanged:
    const inv = await prisma.inventory.findUnique({ where: { id: sourceInvId } });
    expect(inv!.physicalQty).toBe(50);  // unchanged

    const tr = await prisma.stockTransfer.findUnique({ where: { id: transferId } });
    expect(tr!.status).toBe('REQUESTED');  // unchanged
```

---

## Mandatory Test 3: Destination Stock Only After Receipt

**File:** `src/__tests__/transfers.test.ts`

```
TEST SEQUENCE (all in one describe block):

BEFORE DISPATCH:
  "before dispatch: destination has no inventory record at Location B"
  → prisma.inventory.findFirst({ where: { itemId, locationId: locationBId } })
  → either null or physicalQty=0
  → ASSERTION: destInv === null || destInv.physicalQty === 0

AFTER DISPATCH:
  PATCH /api/transfers/:id/dispatch
  → source physicalQty: 50 → 30 (decremented by 20)
  
  "after dispatch: destination stock has NOT increased yet"
  → same query
  → ASSERTION: still null or physicalQty=0  ← THIS IS THE CRITICAL CHECK

AFTER RECEIPT:
  PATCH /api/transfers/:id/receive
  → destination physicalQty: 0 → 20 (incremented by 20)
  
  "receipt succeeds (200) and increases destination stock"
  → prisma.inventory.findFirst({ where: { itemId, locationId: locationBId } })
  → ASSERTION: destInv.physicalQty === 20

  "source stock unchanged after receipt (still 30)"
  → ASSERTION: srcInv.physicalQty === 30  ← source was NOT affected by receipt
```

This test directly verifies the dispatch implementation doesn't touch the destination, and the receive implementation does.

---

## Mandatory Test 4: No Double Receipt

**File:** `src/__tests__/transfers.test.ts`

```
TEST: "Mandatory Test 4 — receiving the same transfer again returns 400"
  │
  │ Context: transfer was already received in the previous test
  │          stock_transfers.status = 'RECEIVED'
  │          destination.physicalQty = 20
  │
  ↓ PATCH /api/transfers/:id/receive  (second call)
  │   → routes/transfers.ts PATCH /:id/receive
  │   → prisma.$transaction()
  │      → SELECT ... FROM stock_transfers WHERE id = $id FOR UPDATE
  │      → transfer.status = 'RECEIVED' (not 'DISPATCHED')
  │      → throw AppError(400, "Transfer cannot be received. Current status: RECEIVED. Only DISPATCHED transfers can be received.")
  │      → ROLLBACK
  │
  ↓ ASSERTIONS:
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/dispatched/i);

  ↓ Verify stock unchanged:
    const destInv = await prisma.inventory.findFirst({ where: { itemId, locationId: locationBId } });
    expect(destInv!.physicalQty).toBe(20);  // still 20, not 40
```

**Why status check inside the transaction (not outside):** If the status were checked outside the transaction, two concurrent receive calls could both read `status=DISPATCHED` before either locks the row. By checking INSIDE the transaction AFTER `FOR UPDATE`, the check reads the most recently committed value.

---

## Mandatory Test 5: Unauthorized User Blocked

**File:** `src/__tests__/rbac.test.ts`

### 401 Tests (no token)

```
TEST: "GET /api/inventory without token → 401"
  │
  ↓ GET /api/inventory (no Authorization header)
  │   → routes/inventory.ts
  │   → router.use(authenticate) runs first
  │   → authHeader = undefined
  │   → next(new AppError(401, 'Authentication token required.'))
  │   → errorHandler: res.status(401).json({ success: false, message: ... })
  │
  ↓ ASSERTION: expect(res.status).toBe(401)
```

### 403 Tests (wrong role)

```
TEST: "SALES cannot dispatch a transfer (OPS_ADMIN only) → 403"
  │
  ↓ PATCH /api/transfers/some-id/dispatch
         Authorization: Bearer <salesToken>
  │
  │   → authenticate() runs → req.user.role = 'SALES'
  │   → authorize(Role.ADMIN, Role.OPERATIONS) runs
  │   → 'SALES' not in [ADMIN, OPERATIONS]
  │   → next(new AppError(403, 'Access denied. Required role: ADMIN or OPERATIONS.'))
  │   → errorHandler: res.status(403).json(...)
  │   → route handler NEVER executes
  │
  ↓ ASSERTION: expect(res.status).toBe(403)
```

**Note on "some-id" in rbac tests:** The RBAC tests use nonsense IDs like `'some-id'`. This is intentional — the role check runs BEFORE any database lookup. The request fails with 403 before the route handler even tries to find the transfer. This proves authorization is enforced at the middleware level, not inside the business logic.

---

## Test File Structure Pattern

Every test file follows the same structure:

```typescript
// 1. Import setup FIRST (overrides env vars)
import './setup';

// 2. Create test fixtures in beforeAll
let salesToken: string;
beforeAll(async () => {
  // Create test users directly via Prisma (not via API)
  const user = await prisma.user.create({ ... });
  // Get JWT tokens via login API
  salesToken = (await request(app).post('/api/auth/login')...).body.token;
});

// 3. Clean up in afterAll in dependency order
afterAll(async () => {
  await prisma.orderItem.deleteMany(...);  // children first
  await prisma.customerOrder.deleteMany(...);
  await prisma.inventory.deleteMany(...);
  await prisma.user.deleteMany(...);
  await prisma.$disconnect();
});

// 4. Reset state between test groups
async function resetInventory(qty: number) {
  await prisma.inventory.update({ where: { id: inventoryId }, data: { physicalQty: qty } });
}

// 5. Tests
describe('group name', () => {
  it('test name', async () => {
    const res = await request(app).patch(...)...;
    expect(res.status).toBe(200);
    // Verify DB directly — not just the API response
    const inv = await prisma.inventory.findUnique({ where: { id } });
    expect(inv!.reservedQty).toBe(8);
  });
});
```

**Why verify DB state directly (not just HTTP response)?** The API response could theoretically return the wrong data while the DB has the right data (or vice versa). Direct DB verification proves the transaction actually changed the correct fields.
