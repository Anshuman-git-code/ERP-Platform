# 06 — Data Modeling

> The schema is the single source of truth. `backend/prisma/schema.prisma` defines the data model; `npx prisma generate` emits the TypeScript types the whole backend uses. This document explains every model, its key choices, and the access patterns it serves.

---

## Design Principle

Relational modeling starts from entities and relationships, then adds indexes for the queries the application must run. The indexes below (`@@index`) are not decorative — each one backs a real query path (filter by status, by location, by item, by created time).

---

## Enums

Native PostgreSQL ENUMs — the database rejects any value not in the list.

```prisma
enum Role            { ADMIN  OPERATIONS  SALES }
enum WorkOrderStatus { ASSIGNED  IN_PROGRESS  COMPLETED }
enum TransferStatus  { REQUESTED  DISPATCHED  RECEIVED  CANCELLED }
enum OrderStatus     { PENDING  CONFIRMED  CANCELLED }
enum TransactionType { IN  OUT }
```

The state machines are encoded as enums and enforced by application logic (forward-only transitions, double-receipt guard), not by the enum alone.

---

## Business Objects and Their Owners

| Business Object | Table | Owner / Reader |
|---|---|---|
| User | users | Provisioned by seed; read on login |
| Location | locations | Created by ADMIN; read by all |
| Item | items | Created/updated by ADMIN/OPERATIONS; read by all |
| Inventory | inventory | Created/adjusted by ADMIN/OPERATIONS; read by all; reserved by SALES (via orders) |
| InventoryTransaction | inventory_transactions | Written by every stock movement; read as audit log |
| WorkOrder | work_orders | Created by ADMIN; advanced by ADMIN/OPERATIONS; read by all |
| StockTransfer | stock_transfers | Created/dispatched/received by ADMIN/OPERATIONS; cancelled by ADMIN |
| CustomerOrder | customer_orders | Created/confirmed/cancelled by ADMIN/SALES |
| OrderItem | order_items | Created with the order; references a specific inventory row |

---

## Model: User

```prisma
model User {
  id        String   @id @default(cuid())
  name      String
  email     String   @unique
  password  String          // bcrypt hash
  role      Role     @default(SALES)
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@map("users")
}
```

- `email @unique` is the login key; `password` is the bcrypt hash (10 rounds), never the plaintext.
- `role @default(SALES)` — least privilege default; the seed sets ADMIN/OPERATIONS explicitly.
- `isActive` lets an account be deactivated without deletion (login refuses inactive users with the same 401 as a wrong password).
- Six reverse relations (`workOrdersAssigned`, `workOrdersCreated`, `transfersRequested/Dispatched/Received`, `ordersCreated`, `stockTransactions`) name the user's role in each relationship for clarity.

Access patterns: `findUnique({ where: { email } })` on login; `findUnique({ where: { id } })` for reference checks (assigned user, created-by).

---

## Model: Location

```prisma
model Location {
  id        String   @id @default(cuid())
  name      String   @unique
  address   String?
  @@map("locations")
}
```

- `name @unique` prevents two warehouses with the same name.
- Reverse relations to inventory, work orders, transfers (source + dest), and orders.
- Access: `findMany` (list, ordered by name), `findUnique({ where: { id } })` (reference check), `create` (ADMIN only).

---

## Model: Item

```prisma
model Item {
  id        String   @id @default(cuid())
  name      String
  sku       String   @unique
  category  String?
  unitPrice Decimal  @db.Decimal(10, 2)
  @@index([sku])
  @@map("items")
}
```

- `sku @unique` is the business identifier; `@@index([sku])` speeds SKU lookups/search.
- `unitPrice` is `Decimal(10,2)` — exact money representation; serializes to a string in JSON, which the frontend type reflects (`unitPrice: string`).
- Search endpoint uses `name`/`sku`/`category` `contains` (case-insensitive) — covered by a full scan at this scale, not an extra index.
- Access: `findMany` (paginated, with optional search), `findUnique`, `create`, `update`.

---

## Model: Inventory (the most important design)

```prisma
model Inventory {
  id           String   @id @default(cuid())
  itemId       String
  locationId   String
  batchNumber  String   @default("DEFAULT")
  physicalQty  Int      @default(0)
  reservedQty  Int      @default(0)
  @@unique([itemId, locationId, batchNumber])
  @@index([itemId])
  @@index([locationId])
  @@map("inventory")
}
```

Three critical decisions:

**1. `availableQty` is not a column.** It is always `physicalQty − reservedQty`, computed by the `withAvailable()` helper on every read. Storing it would introduce a third number that must stay consistent with two others; computing it makes the invariant true by construction.

**2. `batchNumber @default("DEFAULT")`.** Postgres treats `NULL ≠ NULL` for uniqueness, so a nullable batch would allow multiple "no-batch" rows for the same item+location — breaking the unique constraint. The non-null sentinel `'DEFAULT'` makes `@@unique([itemId, locationId, batchNumber])` enforce exactly one no-batch row per item+location.

**3. The `@@unique` constraint.** A duplicate insert throws Prisma `P2002` → 409. The two `@@index` entries back the two filter paths: by item and by location.

Access patterns:
- `findMany({ where: { locationId } })` / `{ itemId }` — filtered listing (paginated)
- `findUnique({ where: { id } })` — single record + its transactions
- `$queryRaw SELECT ... FOR UPDATE` — the locked read inside dispatch/adjust/confirm
- `findFirst({ where: { itemId, locationId, batchNumber: 'DEFAULT' } })` — find-or-create destination on receipt

---

## Model: InventoryTransaction

```prisma
model InventoryTransaction {
  id              String          @id @default(cuid())
  inventoryId     String
  transactionType TransactionType
  quantity        Int
  reason          String?
  referenceKey    String?         @unique   // idempotency key
  createdById     String
  createdAt       DateTime        @default(now())
  @@index([inventoryId])
  @@index([createdAt])
  @@map("inventory_transactions")
}
```

- The audit log for every stock movement. The `Inventory` row is current state; the transactions are how it got there.
- `referenceKey String? @unique` is the idempotency mechanism. `NULL` is allowed (multiple NULLs are fine), but when provided it must be globally unique. System operations use deterministic keys:
  - `dispatch-<transferId>-<inventoryRowId>` (per source row deducted)
  - `receive-<transferId>` (per receipt)
- `transactionType` is `IN` or `OUT`; `quantity` is always positive; the sign comes from the type.
- `@@index([inventoryId])` backs `GET /api/inventory/:id/transactions`; `@@index([createdAt])` supports time-ordered history.

---

## Model: WorkOrder

```prisma
model WorkOrder {
  id              String          @id @default(cuid())
  workOrderNumber String          @unique
  locationId      String
  itemId          String
  requiredQty     Int
  assignedToId    String
  status          WorkOrderStatus @default(ASSIGNED)
  notes           String?
  createdById     String
  startedAt       DateTime?
  completedAt     DateTime?
  itemName        String          // snapshot
  itemSku         String          // snapshot
  @@index([status])
  @@index([locationId])
  @@map("work_orders")
}
```

- `workOrderNumber @unique` is the display ID, generated as `WO-${COUNT+1}` padded to 5 (low-frequency path).
- `shortageQty` is NOT a column — computed live: `max(requiredQty − availableQty, 0)`, where `availableQty` is summed across all inventory rows for the item at the location (`getInventoryAvailability`).
- `itemName`/`itemSku` are snapshots captured at creation for historical accuracy.
- `startedAt`/`completedAt` are set when status advances to `IN_PROGRESS`/`COMPLETED`.
- Forward-only status is enforced by the `transitions` map in the status route.
- Access: `findMany` (paginated, filter by status/location), `findUnique`, `create`, `update` (status + timestamps).

---

## Model: StockTransfer

```prisma
model StockTransfer {
  id              String         @id @default(cuid())
  transferNumber  String         @unique
  sourceLocationId    String
  destLocationId      String
  itemId          String
  quantity        Int
  status          TransferStatus @default(REQUESTED)
  requestedById   String
  dispatchedById  String?
  receivedById    String?
  dispatchedAt    DateTime?
  receivedAt      DateTime?
  itemName        String         // snapshot
  itemSku         String         // snapshot
  @@index([status])
  @@index([sourceLocationId])
  @@index([destLocationId])
  @@map("stock_transfers")
}
```

- Lifecycle: `REQUESTED → DISPATCHED → RECEIVED` (plus `CANCELLED` from `REQUESTED`, ADMIN only).
- `transferNumber` display ID: `TR-${COUNT+1}`.
- Snapshot `itemName`/`itemSku` at creation.
- Three optional actor/timestamp pairs (`requested` always set; `dispatched`/`received` filled as the lifecycle progresses).
- Access: `findMany` (paginated, filter status), `findUnique`, `create`, `$transaction` updates for dispatch/receive/cancel. The receive path locks the transfer row itself (`SELECT ... FOR UPDATE`) to serialize concurrent receive calls.

---

## Model: CustomerOrder

```prisma
model CustomerOrder {
  id            String      @id @default(cuid())
  orderNumber   String      @unique
  customerName  String
  customerPhone String?
  locationId    String
  status        OrderStatus @default(PENDING)
  totalQty      Int         @default(0)
  confirmedAt   DateTime?
  cancelledAt   DateTime?
  @@index([status])
  @@index([locationId])
  @@map("customer_orders")
}
```

- Lifecycle: `PENDING → CONFIRMED` (plus `CANCELLED` from either).
- `orderNumber` is `ORD-${Date.now()}-${random5}` — collision-safe under concurrent creation, because `COUNT+1` would race.
- `totalQty` is the sum of item quantities, set at creation.
- Reservation is not stored on the order — it lives as `reservedQty` on the referenced `Inventory` rows. Confirming increments those; cancelling a confirmed order decrements them.

---

## Model: OrderItem

```prisma
model OrderItem {
  id          String   @id @default(cuid())
  orderId     String
  inventoryId String
  quantity    Int
  itemId      String
  itemName    String   // snapshot
  itemSku     String   // snapshot
  unitPrice   Decimal  @db.Decimal(10, 2)   // snapshot
  @@index([orderId])
  @@index([inventoryId])
  @@map("order_items")
}
```

- Each line references a specific `Inventory` row (the exact shelf/batch being reserved) via `inventoryId`, plus the `Item` via `itemId` for navigation.
- Snapshots `itemName`, `itemSku`, and `unitPrice` so the order line is a point-in-time record.
- `onDelete: Cascade` from the order — deleting an order removes its lines.

---

## Data Relationships

```
User ──────── created ──────→ WorkOrder
       │                   assigned ──→ WorkOrder
       │                   requested/dispatched/received → StockTransfer
       │                   created → CustomerOrder
       │                   created → InventoryTransaction
       │
Location ─── has → Inventory
       │      has → WorkOrder
       │      source of / dest of → StockTransfer
       │      fulfils → CustomerOrder
       │
Item ─────── has → Inventory (many locations)
       │      appears in → WorkOrder, StockTransfer, OrderItem
       │
Inventory ── has → InventoryTransaction (audit)
       │      referenced by → OrderItem (reservation)
       │
CustomerOrder ── has → OrderItem[] ──→ Inventory
```

Foreign keys are enforced by Postgres. Referential integrity for the reservation is application-enforced: `confirm` verifies each `inventoryId` still exists and locks it before incrementing `reservedQty`.

---

## Why Row Locking Is a Data-Model Concern

The most important data-design fact is not a column — it is the locking protocol. `SELECT ... FOR UPDATE` on `inventory` rows (and on the `stock_transfers` row during receipt) is what makes the relational model safe under concurrency. The schema enables this (every row has a stable `id` primary key to lock on), and the application uses `$queryRaw` to express the lock, because Prisma's builder does not surface `FOR UPDATE`. Rows are locked in ascending `id` order so concurrent transactions that overlap cannot deadlock. See [10 — Transaction & Concurrency Workflow](10-Transaction-Concurrency-Workflow.md) for the full protocol.


---

**Read next:** [07 — AWS Service Decisions →](07-AWS-Service-Decisions.md)

[← Back to documentation index](README.md)
