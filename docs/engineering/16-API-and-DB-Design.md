# 16 — API and DB Design

> The API surface and the database design that backs it. Every endpoint maps to one or more tables; the design note explains the constraint or access pattern that makes the endpoint safe.

---

## 1. API Conventions

- Base path: all business routes under `/api/*`; `GET /health` is unauthenticated.
- Auth: `Authorization: Bearer <JWT>` on every protected route (issued by `POST /api/auth/login`).
- Response envelope: `{ success: boolean, data?, meta?, message?, errors?, details?, field? }`.
- Pagination: `?page=1&limit=20` on list endpoints → `meta: { total, page, limit, totalPages }`.
- Status codes: 200/201 success, 400 business rule/state, 401 auth, 403 role, 404 not found, 409 unique violation, 422 validation/insufficient stock, 503 health degraded, 500 unexpected.

---

## 2. Endpoint Catalogue

### Authentication
| Method | Path | Roles | Description |
|---|---|---|---|
| POST | `/api/auth/login` | public | Email + password → `{ token, user }`; 401 on failure |
| GET | `/api/auth/me` | any authed | Returns the current `req.user` |

### Locations
| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/api/locations` | ALL | List locations (ordered by name) |
| POST | `/api/locations` | ADMIN | Create location (name, address?); 409 on duplicate name |
| GET | `/api/locations/:id` | ALL | Single location |
| GET | `/api/locations/count` | public* | Total location count (registered before `authenticate`) |
| GET | `/api/locations/hello` | any authed* | Health-style "hello" route (registered after `authenticate`) |

*`/count` is registered before the router-level `authenticate`, so it is effectively public. `/hello` is after `authenticate` but before `authorize`, so it is authed but not role-gated. Both are utility/demo routes.

### Items
| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/api/items` | ALL | Paginated; `?search=` matches name/sku/category (case-insensitive) |
| POST | `/api/items` | ADMIN, OPERATIONS | Create item (name, sku, category?, unitPrice); 409 on duplicate SKU |
| GET | `/api/items/:id` | ALL | Single item |
| PUT | `/api/items/:id` | ADMIN, OPERATIONS | Partial update (name?, category?, unitPrice?) |

### Inventory
| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/api/inventory` | ALL | Paginated; `?locationId=` `?itemId=` filters; returns `availableQty` computed |
| POST | `/api/inventory` | ADMIN, OPERATIONS | Create (itemId, locationId, physicalQty, batchNumber?=DEFAULT); writes an IN transaction |
| GET | `/api/inventory/:id` | ALL | Single record with `availableQty` |
| PATCH | `/api/inventory/:id/adjust` | ADMIN, OPERATIONS | `{ transactionType, quantity, reason?, referenceKey? }`; locks row; guards negative & below-reserved |
| GET | `/api/inventory/:id/transactions` | ALL | Audit log for the row |

### Work Orders
| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/api/work-orders` | ALL | Paginated; `?status=` `?locationId=`; returns live `availableQty` + `shortageQty` per row |
| POST | `/api/work-orders` | ADMIN | Create (locationId, itemId, requiredQty, assignedToId, notes?); snapshots item name/SKU |
| GET | `/api/work-orders/:id` | ALL | Single with `shortageQty` |
| PATCH | `/api/work-orders/:id/status` | ADMIN, OPERATIONS | `{ status }`; forward-only transition enforced |

### Stock Transfers
| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/api/transfers` | ALL | Paginated; `?status=` |
| POST | `/api/transfers` | ADMIN, OPERATIONS | Create (source, dest, itemId, quantity, notes?); REQUESTED |
| GET | `/api/transfers/:id` | ALL | Single transfer |
| PATCH | `/api/transfers/:id/dispatch` | ADMIN, OPERATIONS | REQUESTED→DISPATCHED; reduces source (FIFO, `FOR UPDATE`); 422 if insufficient |
| PATCH | `/api/transfers/:id/receive` | ADMIN, OPERATIONS | DISPATCHED→RECEIVED; increases dest; transfer-row lock prevents double-receipt |
| PATCH | `/api/transfers/:id/cancel` | ADMIN | REQUESTED→CANCELLED only |

### Customer Orders
| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/api/orders` | ALL | Paginated; `?status=`; includes items + inventory |
| POST | `/api/orders` | ADMIN, SALES | Create PENDING order (customerName, locationId, items[]); no reservation |
| GET | `/api/orders/:id` | ALL | Single with items |
| PATCH | `/api/orders/:id/confirm` | ADMIN, SALES | PENDING→CONFIRMED; atomic reservation (`FOR UPDATE`, id-ordered); 422 with `insufficientItems` |
| PATCH | `/api/orders/:id/cancel` | ADMIN, SALES | →CANCELLED; releases reservation if it was CONFIRMED |

### Dashboard & Health
| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/api/dashboard` | ALL | Aggregate counts + totals |
| GET | `/health` | public | DB reachability + latency; 200/503 |

---

## 3. Database Design

### Tables

| Table | PK | Key constraints / indexes |
|---|---|---|
| `users` | `id` (cuid) | `email @unique` |
| `locations` | `id` (cuid) | `name @unique` |
| `items` | `id` (cuid) | `sku @unique`; `@@index([sku])` |
| `inventory` | `id` (cuid) | `@@unique([itemId, locationId, batchNumber])`; `@@index([itemId])`; `@@index([locationId])` |
| `inventory_transactions` | `id` (cuid) | `referenceKey @unique`; `@@index([inventoryId])`; `@@index([createdAt])` |
| `work_orders` | `id` (cuid) | `workOrderNumber @unique`; `@@index([status])`; `@@index([locationId])` |
| `stock_transfers` | `id` (cuid) | `transferNumber @unique`; `@@index([status, source, dest])` |
| `customer_orders` | `id` (cuid) | `orderNumber @unique`; `@@index([status])`; `@@index([locationId])` |
| `order_items` | `id` (cuid) | `@@index([orderId])`; `@@index([inventoryId])`; cascade delete from order |

### Enums (Postgres native)
`Role`, `WorkOrderStatus`, `TransferStatus`, `OrderStatus`, `TransactionType`.

### Relationships (foreign keys)
- `Inventory` → `Item`, `Location`
- `InventoryTransaction` → `Inventory`, `User` (createdBy)
- `WorkOrder` → `Location`, `Item`, `User` (assignedTo, createdBy)
- `StockTransfer` → `Location` (source, dest), `Item`, `User` (requestedBy, dispatchedBy?, receivedBy?)
- `CustomerOrder` → `Location`, `User` (createdBy)
- `OrderItem` → `CustomerOrder` (cascade), `Inventory`, `Item`

### Computed (not stored)
- `availableQty = physicalQty − reservedQty` (per inventory row, via `withAvailable()`)
- `shortageQty = max(requiredQty − availableQty, 0)` (per work order, via `getInventoryAvailability()`)
- Dashboard `totalAvailable = totalPhysical − totalReserved`

---

## 4. Endpoint ↔ DB Operation Map (the critical ones)

| Endpoint | DB operations inside one transaction |
|---|---|
| `POST /api/inventory` | `Item.findUnique`, `Location.findUnique`, `Inventory.create`, `InventoryTransaction.create` (IN) |
| `PATCH /api/inventory/:id/adjust` | `SELECT … FOR UPDATE` (inventory row), guard checks, `InventoryTransaction.create`, `Inventory.update` |
| `PATCH /api/transfers/:id/dispatch` | `StockTransfer.findUnique` (status check), `SELECT … FOR UPDATE` (source rows, id-ordered), availability check, per-row `Inventory.update` + `InventoryTransaction.create` (OUT, `dispatch-…`), `StockTransfer.update` |
| `PATCH /api/transfers/:id/receive` | `SELECT … FOR UPDATE` (transfer row), status check, find/create dest inventory, `SELECT … FOR UPDATE` (dest row), `Inventory.update`, `InventoryTransaction.create` (IN, `receive-…`), `StockTransfer.update` |
| `POST /api/orders` | `Location.findUnique`, `Inventory.findMany`, `CustomerOrder.create` + nested `OrderItem.create` (no reservation) |
| `PATCH /api/orders/:id/confirm` | `CustomerOrder.findUnique` (status), `SELECT … FOR UPDATE` (inventory rows, id-ordered), availability check, per-item `Inventory.update` (reservedQty +=), `CustomerOrder.update` |
| `PATCH /api/orders/:id/cancel` | `CustomerOrder.findUnique`, if CONFIRMED per-item `Inventory.update` (reservedQty −=), `CustomerOrder.update` |

---

## 5. Design Notes

- **No `DELETE` routes exist.** Records are kept (audit + history); inactivation is via `isActive` (users) or status (orders/transfers).
- **No `PUT` on most resources** — only items have a partial update; inventory is adjusted, not edited, to preserve the audit trail.
- **`availableQty`/`shortageQty` are response-only fields** — never in the schema, always computed.
- **Read endpoints are open to all roles; mutating endpoints are role-gated** — the role matrix in [09 — Security](09-Security-Architecture.md) is the authoritative view.


---

**Read next:** [17 — System Design Overview →](17-System-Design-Overview.md)

[← Back to documentation index](README.md)
