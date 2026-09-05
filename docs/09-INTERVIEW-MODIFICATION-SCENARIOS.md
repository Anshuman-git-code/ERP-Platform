# Interview Modification Scenarios

These are realistic changes an interviewer could ask you to make live. For each one, understand the affected files, the approach, the risks — and the **exact commands to run to make it live**.

---

## How to make any change live (Docker Compose)

Every scenario that changes the Prisma schema needs a migration. Every scenario needs a rebuild. This is the pattern:

```bash
# 1. After editing schema.prisma — create migration (run from backend/)
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2/backend
npx prisma migrate dev --name <your_migration_name>

# 2. After all code changes — rebuild and restart Docker
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2
docker compose down
docker compose up --build
```

The backend Dockerfile runs `prisma migrate deploy` automatically at container startup, so the new column/table is added to the database without any manual SQL.

For scenarios with **no schema change**, skip step 1 — just rebuild Docker.

---

## Scenario 1: Add a "damagedQty" field to Inventory

**The request:** "Track damaged stock. Damaged items reduce available stock but are separate from reserved stock."

### What you'd need to change

**1. `backend/prisma/schema.prisma`**
```
model Inventory {
  ...
  damagedQty   Int  @default(0)    ← new field
}
```

**2. `availableQty` formula changes**
Old: `physicalQty - reservedQty`
New: `physicalQty - reservedQty - damagedQty`

Every place `withAvailable()` is called in `routes/inventory.ts` needs updating:
```typescript
function withAvailable(inv: { physicalQty: number; reservedQty: number; damagedQty: number }) {
  return { ...inv, availableQty: inv.physicalQty - inv.reservedQty - inv.damagedQty };
}
```

**3. New endpoint or extend adjust endpoint**
Option A: Add a separate `PATCH /api/inventory/:id/damage` endpoint
Option B: Add `damagedQty` adjustment to the existing `/adjust` endpoint

**4. Frontend — `frontend/src/pages/Inventory.tsx`**
- Add `damagedQty` column to the table
- Add damage adjustment in the modal

**5. `frontend/src/types/index.ts`**
- Add `damagedQty: number` to the `Inventory` interface

**6. Tests**
- `inventory.test.ts`: add test verifying `availableQty` correctly subtracts damagedQty

**Transaction implication:** The damage adjustment needs the same `SELECT FOR UPDATE` pattern as the regular adjust to prevent race conditions.

**What could go wrong:** Forgetting to update `withAvailable()` everywhere — it's called in GET, POST, PATCH adjust, and PATCH transfer receive (the upsert).

### Commands to make it live

```bash
# Step 1 — Create the database migration
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2/backend
npx prisma migrate dev --name add_damaged_qty
# This adds ALTER TABLE "inventory" ADD COLUMN "damagedQty" INTEGER NOT NULL DEFAULT 0;
# to a new migration file and applies it to your local dev database immediately.
# It also regenerates the Prisma TypeScript types so damagedQty is type-safe.

# Step 2 — Rebuild Docker with all your code changes
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2
docker compose down
docker compose up --build
# --build forces Docker to rebuild the images (picks up your code + schema changes).
# On startup the backend container runs: prisma migrate deploy
# which applies the add_damaged_qty migration to the Docker database automatically.

# Step 3 — Verify (open a new terminal while compose is running)
curl -s http://localhost:3002/health
# Should return: { "status": "ok", "database": { "status": "ok" } }

# Step 4 — No re-seed needed.
# Existing inventory rows automatically get damagedQty = 0 (the column default).
```

---

## Scenario 2: Allow Partial Transfer Receipt

**The request:** "A transfer of 30 units arrives in two shipments. Allow receiving 15 now and 15 later."

### What you'd need to change

**1. `backend/prisma/schema.prisma`**
```
model StockTransfer {
  ...
  quantity           Int            // total requested (already exists)
  receivedQty        Int  @default(0)    ← new field
  // status: REQUESTED → DISPATCHED → PARTIALLY_RECEIVED → RECEIVED
}
```
Add `PARTIALLY_RECEIVED` to the `TransferStatus` enum.

**2. `backend/src/routes/transfers.ts` receive endpoint**
```typescript
// Accept: body.receiveQty (how much to receive now)
// Validate: receiveQty <= transfer.quantity - transfer.receivedQty
// Update: receivedQty += receiveQty
// If receivedQty === quantity → status = RECEIVED
// Else → status = PARTIALLY_RECEIVED
```

**3. Business rule 4 (double-receipt prevention) changes**
Instead of checking `status !== DISPATCHED`, check:
`transfer.receivedQty + receiveQty > transfer.quantity`

**4. Frontend — `frontend/src/pages/Transfers.tsx`**
- Show remaining quantity in the Receive modal
- Input field for how many to receive
- Show PARTIALLY_RECEIVED badge

**5. Tests**
- Partial receipt increases dest by partial amount
- Total after two partials equals full transfer.quantity
- Cannot receive more than remaining

**Transaction implication:** Same `FOR UPDATE` on transfer row + dest inventory, but check `receivedQty + receiveQty <= quantity` instead of just status.

### Commands to make it live

```bash
# Step 1 — Create the migration (covers both receivedQty column and PARTIALLY_RECEIVED enum value)
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2/backend
npx prisma migrate dev --name add_partial_transfer_receipt
# Prisma generates SQL like:
#   ALTER TYPE "TransferStatus" ADD VALUE 'PARTIALLY_RECEIVED';
#   ALTER TABLE "stock_transfers" ADD COLUMN "receivedQty" INTEGER NOT NULL DEFAULT 0;

# Step 2 — Rebuild Docker
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2
docker compose down
docker compose up --build

# Step 3 — Verify the new status value works
# (After logging in via the UI and testing a partial receive)
# Or test directly:
# curl -X PATCH http://localhost:3002/api/transfers/<id>/receive \
#   -H "Authorization: Bearer <token>" \
#   -H "Content-Type: application/json" \
#   -d '{"receiveQty": 15}'
```

---

## Scenario 3: Cancel a Confirmed Order and Release Reservation

**Already implemented!** `PATCH /api/orders/:id/cancel` handles this.

### No code changes needed — it already works

```typescript
if (order.status === OrderStatus.CONFIRMED) {
  for (const item of order.items) {
    await tx.inventory.update({
      where: { id: item.inventoryId },
      data: { reservedQty: { decrement: item.quantity } },
    });
  }
}
```

**If asked to explain:** The cancel transaction checks if the order was CONFIRMED. If it was, it releases the reservations by decrementing `reservedQty`. If it was only PENDING, no stock was ever reserved so nothing to release.

**Test already exists:** `"cancelling a CONFIRMED order releases its reservedQty"` in `orders.test.ts`.

### Commands to verify it works (no rebuild needed)

```bash
# This feature is already live. You can verify it by running the existing tests:
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2/backend
npm test -- --testPathPattern=orders
# Look for: "cancelling a CONFIRMED order releases its reservedQty" → ✓

# Or verify against the running Docker stack:
# 1. Log in as sales@opserp.dev
# 2. Create an order and confirm it — watch reservedQty increase in Inventory
# 3. Cancel that confirmed order — watch reservedQty decrease back
```

---

## Scenario 4: Restrict Users to Their Assigned Location

**The request:** "An Operations user should only be able to adjust inventory and dispatch transfers at their assigned location."

### What you'd need to change

**1. `backend/prisma/schema.prisma`**
```
model User {
  ...
  locationId   String?             ← nullable: ADMIN = no restriction, OPS = location-specific
  location     Location? @relation(fields: [locationId], references: [id])
}
```

**2. `backend/src/routes/inventory.ts` adjust endpoint**
```typescript
if (req.user!.role === Role.OPERATIONS && req.user!.locationId) {
  const inv = await prisma.inventory.findUnique({ where: { id: req.params.id } });
  if (inv?.locationId !== req.user!.locationId) {
    throw new AppError(403, 'You can only adjust inventory at your assigned location.');
  }
}
```

**3. Same pattern in `transfers.ts` dispatch**
Check `transfer.sourceLocationId === req.user.locationId`.

**4. `backend/src/types/index.ts`**
Add `locationId?: string` to the JWT payload interface.

**5. `backend/src/routes/auth.ts`**
Include `locationId` in the JWT payload:
```typescript
jwt.sign({ userId, email, role, locationId: user.locationId }, JWT_SECRET, ...)
```

**6. Frontend — `Layout.tsx`**
Show the user's assigned location in the sidebar.

**Transaction implication:** The location check should happen inside the transaction (after the FOR UPDATE) to prevent a race condition where the user's locationId changes between check and lock.

### Commands to make it live

```bash
# Step 1 — Create the migration (adds locationId column to users table)
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2/backend
npx prisma migrate dev --name add_user_location_restriction
# SQL: ALTER TABLE "users" ADD COLUMN "locationId" TEXT;
#      ALTER TABLE "users" ADD CONSTRAINT "users_locationId_fkey"
#        FOREIGN KEY ("locationId") REFERENCES "locations"("id");
# Existing users get locationId = NULL (no restriction — correct default)

# Step 2 — Rebuild Docker
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2
docker compose down
docker compose up --build

# Step 3 — Assign a location to an ops user for testing
# (via the database directly, since there's no user management UI)
# Connect to the running Docker postgres:
docker exec -it ops_erp_postgres psql -U ops_user -d ops_erp

# Inside psql — find the location ID first:
# SELECT id, name FROM locations;

# Then assign it to the ops user:
# UPDATE users SET "locationId" = '<location-id-here>' WHERE email = 'ops@opserp.dev';
# \q

# Step 4 — Test
# Log in as ops@opserp.dev
# Try to adjust inventory at the assigned location → should work (200)
# Try to adjust inventory at a different location → should fail (403)
```

---

## Scenario 5: Add a New Role — "MANAGER"

**The request:** "Add a MANAGER role that can do everything OPERATIONS can do, plus create work orders (but not cancel transfers)."

### What you'd need to change

**1. `backend/prisma/schema.prisma`**
```
enum Role {
  ADMIN
  MANAGER    ← new
  OPERATIONS
  SALES
}
```

**2. Every `authorize()` call in route files**
```typescript
// workOrders.ts — MANAGER can now create work orders:
const MANAGER_ADMIN = [Role.ADMIN, Role.MANAGER];
router.post('/', authorize(...MANAGER_ADMIN), ...)

// transfers.ts — MANAGER can dispatch and receive (same as OPERATIONS):
const OPS_ADMIN = [Role.ADMIN, Role.OPERATIONS, Role.MANAGER];
router.patch('/:id/dispatch', authorize(...OPS_ADMIN), ...)
router.patch('/:id/receive',  authorize(...OPS_ADMIN), ...)

// transfers.ts — MANAGER cannot cancel (ADMIN only stays ADMIN only):
router.patch('/:id/cancel', authorize(Role.ADMIN), ...)  // unchanged
```

**3. Frontend — `frontend/src/components/Layout.tsx`**
```typescript
const roleBadgeColor = {
  ADMIN: 'bg-purple-100 text-purple-800',
  MANAGER: 'bg-indigo-100 text-indigo-800',    ← new
  OPERATIONS: 'bg-blue-100 text-blue-800',
  SALES: 'bg-green-100 text-green-800',
};
```

**4. `frontend/src/types/index.ts`**
```typescript
export type Role = 'ADMIN' | 'MANAGER' | 'OPERATIONS' | 'SALES';
```

**5. Tests — `rbac.test.ts`**
Add a MANAGER user in `beforeAll` and verify its permissions.

**What could go wrong:** Forgetting to add MANAGER to an `authorize()` call locks it out. Accidentally adding MANAGER to cancel-transfer leaves it with too much access.

### Commands to make it live

```bash
# Step 1 — Create the migration (adds MANAGER value to the Role enum)
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2/backend
npx prisma migrate dev --name add_manager_role
# SQL: ALTER TYPE "Role" ADD VALUE 'MANAGER';

# Step 2 — Rebuild Docker
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2
docker compose down
docker compose up --build

# Step 3 — Create a MANAGER user for testing
docker exec -it ops_erp_postgres psql -U ops_user -d ops_erp

# Inside psql — you need a bcrypt hash for "Password123!"
# The easiest way is to insert via the seed pattern.
# Exit psql, then run a quick Node script:
# \q

cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2/backend
node -e "
const bcrypt = require('bcryptjs');
bcrypt.hash('Password123!', 10).then(hash => {
  console.log('Hash:', hash);
  // Copy this hash and use it in the psql INSERT below
});
"

# Then insert the MANAGER user (replace <hash> with the output above):
docker exec -it ops_erp_postgres psql -U ops_user -d ops_erp -c "
INSERT INTO users (id, name, email, password, role, \"isActive\", \"createdAt\", \"updatedAt\")
VALUES (gen_random_uuid(), 'Manager User', 'manager@opserp.dev', '<hash>', 'MANAGER', true, now(), now());
"

# Step 4 — Run tests to verify RBAC
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2/backend
npm test -- --testPathPattern=rbac
```

---

## Scenario 6: Add Pagination to the Locations List

**Currently:** `GET /api/locations` returns ALL locations with no pagination.

### What you'd need to change

**1. `backend/src/routes/locations.ts`**
```typescript
router.get('/',
  authorize(...ALL_ROLES),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  async (req, res) => {
    const page = parseInt((req.query.page as string) ?? '1', 10);
    const limit = parseInt((req.query.limit as string) ?? '20', 10);
    const skip = (page - 1) * limit;

    const [locations, total] = await Promise.all([
      prisma.location.findMany({ skip, take: limit, orderBy: { name: 'asc' } }),
      prisma.location.count(),
    ]);

    return res.json({
      success: true,
      data: locations,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  }
);
```

**2. `frontend/src/api/locations.ts`**
```typescript
list: (params?: { page?: number; limit?: number }) =>
  apiClient.get<PaginatedResponse<Location>>('/locations', { params }),
```

**3. Frontend — any page that fetches all locations for dropdowns**
Dropdowns currently fetch ALL locations. With pagination they need to either fetch all pages or switch to a search/autocomplete approach.

**What this teaches:** Adding pagination to a "simple" endpoint can cascade into frontend dropdown behavior.

### Commands to make it live

```bash
# No schema change needed — this is a pure code change.

# Step 1 — Rebuild Docker
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2
docker compose down
docker compose up --build

# Step 2 — Verify pagination works
# (After the stack is up)
curl -s "http://localhost:3002/api/locations?page=1&limit=2" \
  -H "Authorization: Bearer <your-token>"
# Should return: { data: [...], meta: { total: 3, page: 1, limit: 2, totalPages: 2 } }

# Get a token first:
TOKEN=$(curl -s -X POST http://localhost:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@opserp.dev","password":"Password123!"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s "http://localhost:3002/api/locations?page=1&limit=2" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

---

## Scenario 7: Add Audit Logging

**The request:** "Log every time someone creates a work order, dispatches a transfer, or confirms an order."

### What you'd need to change

**1. New model in `schema.prisma`**
```
model AuditLog {
  id         String   @id @default(cuid())
  userId     String
  action     String   // "CREATE_WORK_ORDER", "DISPATCH_TRANSFER", "CONFIRM_ORDER"
  entityType String   // "WorkOrder", "StockTransfer", "CustomerOrder"
  entityId   String
  details    Json?    // before/after state
  createdAt  DateTime @default(now())

  user       User     @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([entityType, entityId])
  @@map("audit_logs")
}
```

Also add the reverse relation on `User`:
```
model User {
  ...
  auditLogs  AuditLog[]
}
```

**2. Each relevant route handler**
```typescript
// Inside the transaction, after the main operation:
await tx.auditLog.create({
  data: {
    userId: req.user!.userId,
    action: 'CONFIRM_ORDER',
    entityType: 'CustomerOrder',
    entityId: orderId,
    details: { before: { status: 'PENDING' }, after: { status: 'CONFIRMED' } },
  },
});
```

**Transaction implication:** Audit log inside the transaction = rolled back if operation fails (you log only successful actions). Audit log outside the transaction = logged even if operation fails (you log all attempts).

### Commands to make it live

```bash
# Step 1 — Create the migration (creates the audit_logs table)
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2/backend
npx prisma migrate dev --name add_audit_logging
# SQL: CREATE TABLE "audit_logs" (
#        "id" TEXT NOT NULL, "userId" TEXT NOT NULL,
#        "action" TEXT NOT NULL, "entityType" TEXT NOT NULL,
#        "entityId" TEXT NOT NULL, "details" JSONB,
#        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
#        CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
#      );
#      CREATE INDEX ...
#      ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" ...

# Step 2 — Rebuild Docker
cd /Users/anshumanmohapatra/Desktop/CASE-STUDY-2
docker compose down
docker compose up --build

# Step 3 — Verify audit logs are being created
# Perform an action (e.g. confirm an order), then check the table:
docker exec -it ops_erp_postgres psql -U ops_user -d ops_erp -c "
SELECT action, \"entityType\", \"entityId\", \"createdAt\"
FROM audit_logs
ORDER BY \"createdAt\" DESC
LIMIT 10;
"
```

---

## Quick reference: which scenarios need a migration?

| Scenario | Schema change? | Migration needed? | Rebuild Docker? |
|---|---|---|---|
| 1. damagedQty field | Yes — new column | Yes | Yes |
| 2. Partial transfer receipt | Yes — new column + enum value | Yes | Yes |
| 3. Cancel order (already done) | No | No | No |
| 4. Location restriction | Yes — new column + FK | Yes | Yes |
| 5. MANAGER role | Yes — new enum value | Yes | Yes |
| 6. Pagination on locations | No | No | Yes |
| 7. Audit logging | Yes — new table | Yes | Yes |
