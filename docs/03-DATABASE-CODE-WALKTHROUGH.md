# Database Code Walkthrough

Source of truth: `backend/prisma/schema.prisma`

---

## Enums

### `Role`
```
ADMIN       — full access, creates work orders
OPERATIONS  — manages inventory and transfers
SALES       — creates customer orders and reserves stock
```

### `WorkOrderStatus`
```
ASSIGNED    → IN_PROGRESS → COMPLETED   (forward only, never backward)
```

### `TransferStatus`
```
REQUESTED → DISPATCHED → RECEIVED
    ↓ (only from REQUESTED)
  CANCELLED
```

### `OrderStatus`
```
PENDING → CONFIRMED → CANCELLED
       ↗ (PENDING can also go directly to CANCELLED)
```

### `TransactionType`
```
IN   — stock entering a location (receipt, adjustment, initial stock)
OUT  — stock leaving a location (dispatch, adjustment)
```

---

## Model: `User`

```
Table: users
```

| Field | Type | Constraint | Purpose |
|---|---|---|---|
| id | String | PK, cuid() | Unique identifier |
| name | String | NOT NULL | Display name |
| email | String | UNIQUE, NOT NULL | Login identifier |
| password | String | NOT NULL | bcrypt hash (never plain text) |
| role | Role | NOT NULL, default SALES | RBAC role |
| isActive | Boolean | default true | Soft disable without delete |
| createdAt | DateTime | auto | Audit trail |
| updatedAt | DateTime | auto-update | Audit trail |

**Why `isActive` exists:** Allows disabling a user's login without deleting their records (work orders, transfers, orders they created still reference them). The login route checks `!user.isActive` and returns 401.

**Relations outward:**
- Has many `WorkOrder` (as creator and as assignee — two separate relations)
- Has many `StockTransfer` (as requester, dispatcher, or receiver — three separate relations)
- Has many `CustomerOrder`
- Has many `InventoryTransaction`

---

## Model: `Location`

```
Table: locations
```

| Field | Type | Constraint | Purpose |
|---|---|---|---|
| id | String | PK, cuid() | |
| name | String | UNIQUE, NOT NULL | "Warehouse A", "Shop Floor" |
| address | String? | nullable | Human-readable address |
| createdAt / updatedAt | DateTime | auto | |

**Why UNIQUE on name:** Prevents accidentally creating two "Warehouse A" locations. The seed uses `upsert({ where: { name } })` to be idempotent.

**Relations:** Has many `Inventory` records, `WorkOrder`, `StockTransfer` (both as source and destination), `CustomerOrder`.

---

## Model: `Item`

```
Table: items
```

| Field | Type | Constraint | Purpose |
|---|---|---|---|
| id | String | PK, cuid() | |
| name | String | NOT NULL | Human-readable name |
| sku | String | UNIQUE, NOT NULL | Machine identifier ("STEEL-ROD-10MM") |
| category | String? | nullable | "Raw Material", "Fasteners" |
| unitPrice | Decimal(10,2) | NOT NULL | Used for order snapshots |
| createdAt / updatedAt | DateTime | auto | |

**Why UNIQUE on sku:** No two items can have the same stock-keeping unit. If you try to create a duplicate, Prisma throws `P2002` which the error handler converts to 409.

**@@index([sku]):** Adding an index on `sku` makes `findUnique({ where: { sku } })` fast even with millions of items.

**Relations:** Has many `Inventory` records (the item exists at many locations), `WorkOrder`, `StockTransfer`, `OrderItem`.

---

## Model: `Inventory` ← THE CENTRAL MODEL

```
Table: inventory
```

| Field | Type | Constraint | Purpose |
|---|---|---|---|
| id | String | PK, cuid() | |
| itemId | String | FK → items | Which item |
| locationId | String | FK → locations | Where |
| batchNumber | String | NOT NULL, default "DEFAULT" | Which batch |
| physicalQty | Int | default 0 | Actual stock on hand |
| reservedQty | Int | default 0 | Stock held by confirmed orders |
| createdAt / updatedAt | DateTime | auto | |

**The composite unique constraint:**
```
@@unique([itemId, locationId, batchNumber])
```
This is the rule that prevents duplicate inventory rows. You cannot have two rows for ("Steel Rod", "Warehouse A", "DEFAULT"). When someone tries to create a duplicate, Prisma throws `P2002`.

**Why `batchNumber` defaults to "DEFAULT" (not null):**
PostgreSQL treats `NULL != NULL` for uniqueness purposes. If batchNumber were nullable, you could create two rows both with `batchNumber = NULL` for the same item+location and the unique constraint would NOT catch it (because `NULL != NULL` is true). Using the string `"DEFAULT"` as a sentinel ensures the constraint works deterministically.

**`availableQty` is NEVER stored.** It is always computed as:
```
availableQty = physicalQty - reservedQty
```
The `withAvailable()` function in `routes/inventory.ts` adds this field to every response:
```typescript
function withAvailable(inv: { physicalQty: number; reservedQty: number }) {
  return { ...inv, availableQty: inv.physicalQty - inv.reservedQty };
}
```

**Why not store availableQty?** If it were stored, every operation that changes `physicalQty` or `reservedQty` would also need to update `availableQty` atomically. Any bug in that synchronization would create inconsistent data. Computing it from the two source-of-truth fields guarantees it's always correct.

**Indexes:**
- `@@index([itemId])` — fast lookup of all inventory for a given item
- `@@index([locationId])` — fast lookup of all inventory at a given location

---

## Model: `InventoryTransaction`

```
Table: inventory_transactions
```

| Field | Type | Constraint | Purpose |
|---|---|---|---|
| id | String | PK, cuid() | |
| inventoryId | String | FK → inventory | Which inventory row this affects |
| transactionType | TransactionType | NOT NULL | IN or OUT |
| quantity | Int | NOT NULL | How many units |
| reason | String? | nullable | Human note ("Transfer TR-00001 dispatched") |
| referenceKey | String? | UNIQUE when set | Idempotency key |
| createdById | String | FK → users | Who made this change |
| createdAt | DateTime | auto | |

**The `referenceKey` field and idempotency:**

Simple meaning: A unique label that says "this specific logical event already happened." If you try to create a second transaction with the same referenceKey, the database rejects it.

Technical meaning: `referenceKey String? @unique` — when provided, PostgreSQL enforces that no two rows share the same value.

How it's used:
- Transfer dispatch creates: `referenceKey: "dispatch-<transferId>-<inventoryRowId>"`
- Transfer receipt creates: `referenceKey: "receive-<transferId>"`
- Manual adjustments can provide a caller-supplied key

If a network glitch causes the dispatch endpoint to be called twice, the second call fails with a 409 "already exists" error instead of double-subtracting stock.

**Why `referenceKey` is nullable:** Not every transaction has an idempotency requirement. Initial stock records and manual adjustments without a provided key don't need one. The `@unique` constraint in PostgreSQL on a nullable column allows multiple NULLs (they are not considered equal), but any non-null value must be unique.

---

## Model: `WorkOrder`

```
Table: work_orders
```

| Field | Type | Constraint | Purpose |
|---|---|---|---|
| workOrderNumber | String | UNIQUE | Human-readable "WO-00001" |
| locationId | String | FK → locations | Where work happens |
| itemId | String | FK → items | What material is needed |
| requiredQty | Int | NOT NULL | How much is needed |
| assignedToId | String | FK → users | Who is responsible |
| status | WorkOrderStatus | default ASSIGNED | State machine |
| itemName, itemSku | String | NOT NULL | Snapshot — preserves history |
| startedAt, completedAt | DateTime? | nullable | Timestamps per transition |

**Why snapshot `itemName` and `itemSku`?** If someone renames an item after a work order is created, the work order should still show the original name. The snapshot captures the item data at creation time, decoupling historical records from the live catalogue.

**`shortageQty` is NOT stored.** It's computed live by `getInventoryAvailability()` in `routes/workOrders.ts`:
```typescript
shortageQty = Math.max(wo.requiredQty - availableQty, 0)
```
Why not store it? Because inventory changes constantly. A stored shortage would go stale the moment stock is added or a transfer is received. Computing it fresh on every read guarantees accuracy.

**Indexes:**
- `@@index([status])` — for filtering "all open work orders"
- `@@index([locationId])` — for filtering work orders at a specific location

---

## Model: `StockTransfer`

```
Table: stock_transfers
```

| Field | Type | Constraint | Purpose |
|---|---|---|---|
| transferNumber | String | UNIQUE | Human-readable "TR-00001" |
| sourceLocationId | String | FK → locations | Where stock comes from |
| destLocationId | String | FK → locations | Where stock goes |
| itemId | String | FK → items | What is being moved |
| quantity | Int | NOT NULL | How many units |
| status | TransferStatus | default REQUESTED | State machine |
| requestedById | String | FK → users | Who requested |
| dispatchedById | String? | nullable | Who dispatched |
| receivedById | String? | nullable | Who received |
| dispatchedAt, receivedAt | DateTime? | nullable | Per-event timestamps |
| itemName, itemSku | String | NOT NULL | Snapshot |

**Two location foreign keys on one row:** `sourceLocationId` and `destLocationId` both reference the `locations` table. Prisma handles this with named relations:
```
sourceLocation  Location @relation("SourceLocation", ...)
destLocation    Location @relation("DestLocation", ...)
```

**The double-receipt protection relies on `status`:** The receive endpoint begins with `SELECT status ... FOR UPDATE` and checks `status === DISPATCHED`. Once set to `RECEIVED`, this check always fails for any subsequent receive attempt. The status field is the database-level guard.

---

## Model: `CustomerOrder`

```
Table: customer_orders
```

| Field | Type | Constraint | Purpose |
|---|---|---|---|
| orderNumber | String | UNIQUE | "ORD-1788460195811-A79E9" |
| customerName | String | NOT NULL | Minimal CRM — just a name |
| customerPhone | String? | nullable | Optional contact |
| locationId | String | FK → locations | Which location's inventory to reserve |
| status | OrderStatus | default PENDING | State machine |
| totalQty | Int | default 0 | Sum of all item quantities |
| confirmedAt, cancelledAt | DateTime? | nullable | Per-state timestamps |

**Why `orderNumber` uses timestamp+random instead of COUNT+1:**
```typescript
const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
```
Two simultaneous `POST /api/orders` calls could both read the same COUNT and try to insert with the same number. Using `timestamp + random` makes collisions astronomically unlikely without needing a DB sequence. If they did collide, the `@unique` constraint would catch it.

---

## Model: `OrderItem`

```
Table: order_items
```

| Field | Type | Constraint | Purpose |
|---|---|---|---|
| orderId | String | FK → customer_orders, CASCADE | Parent order |
| inventoryId | String | FK → inventory | Specific inventory row being reserved |
| quantity | Int | NOT NULL | How many units to reserve |
| itemName, itemSku | String | NOT NULL | Snapshot |
| unitPrice | Decimal(10,2) | NOT NULL | Price at time of order |
| itemId | String | FK → items | For querying |

**Why reference `inventoryId` instead of `itemId`?** A reservation must target a specific inventory row (item + location + batch). If it only referenced `itemId`, the system wouldn't know which location's stock to reserve.

**`onDelete: Cascade`:** When a `CustomerOrder` is deleted, all its `OrderItem` rows are automatically deleted too. This prevents orphaned order items.

---

## Complete Relational Structure

```
User ──────────────────────┐
  │                         │ (assignedTo)
  │ (createdBy)             ↓
  ├──→ WorkOrder ←──── Location ←─────┐
  │                                    │
  ├──→ StockTransfer (source/dest) ────┘
  │                    │
  ├──→ CustomerOrder   │
  │         │          │
  │         └──→ OrderItem ──→ Inventory ──→ Item
  │                                │
  └──→ InventoryTransaction ───────┘
```

**Every path that touches stock goes through `Inventory`:**
- Order confirmation increments `inventory.reservedQty`
- Order cancellation decrements `inventory.reservedQty`
- Transfer dispatch decrements `inventory.physicalQty` at source
- Transfer receipt increments `inventory.physicalQty` at destination
- Manual adjust changes `inventory.physicalQty` either direction

**`availableQty = physicalQty - reservedQty` enforced everywhere:**
- Order confirm checks: `physicalQty - reservedQty >= requested`
- Transfer dispatch checks: `physicalQty - reservedQty >= transfer.quantity`
- Adjust OUT checks: `physicalQty - quantity >= 0` AND `physicalQty - quantity >= reservedQty`
