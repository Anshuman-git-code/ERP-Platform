# Architecture Decision Records

## 1. SELECT FOR UPDATE for concurrent reservation

**Decision:** Use raw `SELECT ... FOR UPDATE` inside `prisma.$transaction()` for the order confirmation and transfer dispatch paths.

**Why:** Prisma's default `$transaction()` runs at READ COMMITTED isolation (PostgreSQL default). Two concurrent confirmations can both read the same `reservedQty` before either commits, leading to over-reservation. `SELECT FOR UPDATE` serializes access to the locked rows — the second request blocks until the first commits, then re-reads the updated values and correctly fails if stock is exhausted.

Rows are locked in ascending `id` order to prevent deadlocks when two requests lock overlapping sets of inventory rows in different orders.

## 2. `availableQty` is always computed, never stored

**Decision:** `availableQty = physicalQty - reservedQty` is computed at query time, not stored as a column.

**Why:** A stored `availableQty` column would require updating it in sync with every change to `physicalQty` and `reservedQty`. Under concurrent transactions this creates additional write conflicts and opportunities for staleness. The computed value is always consistent with the two source fields.

Validation ensures `physicalQty >= 0`, `reservedQty >= 0`, and `physicalQty >= reservedQty` at every mutation point.

## 3. InventoryTransaction with referenceKey for idempotency

**Decision:** Add an `InventoryTransaction` model with an optional `referenceKey String? @unique` field.

**Why:** The requirements explicitly call out preventing duplicate inventory transactions. The unique `referenceKey` provides an idempotency mechanism: callers can supply a business-meaningful key (e.g., `dispatch-<transferId>-<inventoryId>`) and a duplicate submission returns 409 instead of creating a duplicate adjustment. All system-generated transactions (dispatch, receive) use deterministic keys to prevent double-application.

## 4. batchNumber defaults to 'DEFAULT' (non-null)

**Decision:** `batchNumber String @default("DEFAULT")` with `@@unique([itemId, locationId, batchNumber])`.

**Why:** PostgreSQL treats `NULL != NULL` for uniqueness purposes, so a nullable `batchNumber` allows multiple "no-batch" rows for the same item+location. Using `'DEFAULT'` as the sentinel ensures the unique constraint genuinely prevents duplicates.

## 5. Item/SKU snapshot on WorkOrder and StockTransfer

**Decision:** Snapshot `itemName` and `itemSku` onto WorkOrder and StockTransfer at creation time.

**Why:** If an Item's name or SKU is later updated, historical records still display accurate information. This mirrors the `ChallanItem` snapshot pattern from the reference project and is standard practice for audit-sensitive documents.

## 6. Order number uses timestamp+random suffix

**Decision:** `ORD-${Date.now()}-${random}` instead of `COUNT(*)+1`.

**Why:** Under concurrent `POST /api/orders` requests, two calls can read the same COUNT before either commits, generating a duplicate `orderNumber` and causing a P2002 conflict. The timestamp+random suffix is statistically unique without needing a DB sequence or additional locking.

## 7. Express + Prisma over NestJS + TypeORM

**Decision:** Reuse the CS1 Express/Prisma stack rather than introduce NestJS.

**Why:** The stack is already proven, tested, and understood. NestJS would add significant scaffolding complexity for a case study scope. Prisma's type-safe query builder, migration system, and transaction API are well-suited to the schema. Express keeps the architecture flat and auditable.

## 8. Secrets via SSM SecureString (production)

**Decision:** `DATABASE_URL` and `JWT_SECRET` are stored in AWS SSM SecureString and injected via the ECS task definition `secrets` array.

**Why:** Environment variables in task definition JSON are visible in the AWS console and audit logs. SSM SecureString encrypts at rest and provides IAM-controlled access. The values never appear in Terraform state or CI/CD logs. The `lifecycle { ignore_changes = [value] }` block prevents Terraform from overwriting manually rotated secrets.
