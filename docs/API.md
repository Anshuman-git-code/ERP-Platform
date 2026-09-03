# API Documentation — Mini Operations ERP

Base URL (local dev): `http://localhost:4000`
Base URL (via compose): `http://localhost:4002`

All endpoints (except `POST /api/auth/login` and `GET /health`) require:

```
Authorization: Bearer <JWT>
```

---

## Authentication

### POST /api/auth/login

```json
// Request
{ "email": "admin@opserp.dev", "password": "Password123!" }

// 200 OK
{
  "success": true,
  "token": "<JWT>",
  "user": { "id": "...", "name": "Admin User", "email": "admin@opserp.dev", "role": "ADMIN" }
}

// 401 — wrong credentials
{ "success": false, "message": "Invalid email or password." }

// 422 — validation failure
{ "success": false, "message": "Validation failed", "errors": [...] }
```

### GET /api/auth/me

```json
// 200 OK
{ "success": true, "user": { "userId": "...", "email": "...", "role": "ADMIN" } }
```

---

## Locations

| Method | Path | Roles |
|--------|------|-------|
| GET | /api/locations | ALL |
| POST | /api/locations | ADMIN |
| GET | /api/locations/:id | ALL |

### POST /api/locations

```json
// Request
{ "name": "Warehouse C", "address": "3 Park Road" }

// 201 Created
{ "success": true, "data": { "id": "...", "name": "Warehouse C", "address": "3 Park Road", "createdAt": "..." } }

// 409 — duplicate name
{ "success": false, "message": "A record with this value already exists." }
```

---

## Items

| Method | Path | Roles |
|--------|------|-------|
| GET | /api/items | ALL |
| POST | /api/items | ADMIN, OPERATIONS |
| GET | /api/items/:id | ALL |
| PUT | /api/items/:id | ADMIN, OPERATIONS |

### GET /api/items?page=1&limit=20&search=bolt

```json
{
  "success": true,
  "data": [{ "id": "...", "name": "Bolt M8 Stainless", "sku": "BOLT-M8-SS", "category": "Fasteners", "unitPrice": "5.50" }],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

### POST /api/items

```json
// Request
{ "name": "Steel Rod 20mm", "sku": "STEEL-ROD-20MM", "category": "Raw Material", "unitPrice": 450.00 }

// 201 Created — returns item object
// 409 — duplicate SKU
```

---

## Inventory

| Method | Path | Roles |
|--------|------|-------|
| GET | /api/inventory | ALL |
| POST | /api/inventory | ADMIN, OPERATIONS |
| GET | /api/inventory/:id | ALL |
| PATCH | /api/inventory/:id/adjust | ADMIN, OPERATIONS |
| GET | /api/inventory/:id/transactions | ALL |

`availableQty` is always computed as `physicalQty - reservedQty` — it is never stored.

### POST /api/inventory

```json
// Request
{ "itemId": "...", "locationId": "...", "physicalQty": 100, "batchNumber": "BATCH-2026-01" }
// batchNumber defaults to "DEFAULT" if omitted

// 201 Created
{
  "success": true,
  "data": {
    "id": "...", "itemId": "...", "locationId": "...", "batchNumber": "BATCH-2026-01",
    "physicalQty": 100, "reservedQty": 0, "availableQty": 100
  }
}

// 409 — duplicate item/location/batch combination
```

### PATCH /api/inventory/:id/adjust

```json
// Request
{ "transactionType": "IN", "quantity": 20, "reason": "Restock", "referenceKey": "PO-12345" }
// referenceKey is optional — if provided, must be globally unique (idempotency key)

// 200 OK — returns updated inventory with new physicalQty and availableQty
// 422 — OUT adjustment would cause negative stock
// 409 — duplicate referenceKey
```

---

## Work Orders

| Method | Path | Roles |
|--------|------|-------|
| GET | /api/work-orders | ALL |
| POST | /api/work-orders | ADMIN |
| GET | /api/work-orders/:id | ALL |
| PATCH | /api/work-orders/:id/status | ADMIN, OPERATIONS |

`shortageQty` = max(requiredQty − availableQty, 0) — computed live at read time.

### POST /api/work-orders

```json
// Request
{ "locationId": "...", "itemId": "...", "requiredQty": 50, "assignedToId": "...", "notes": "Q3 batch" }

// 201 Created
{
  "success": true,
  "data": {
    "workOrderNumber": "WO-00002", "status": "ASSIGNED",
    "requiredQty": 50, "availableQty": 5, "shortageQty": 45,
    "itemName": "Steel Rod 10mm", "itemSku": "STEEL-ROD-10MM"
  }
}
```

### PATCH /api/work-orders/:id/status

```json
// Request — forward-only transitions: ASSIGNED → IN_PROGRESS → COMPLETED
{ "status": "IN_PROGRESS" }

// 400 — invalid transition (e.g. ASSIGNED → COMPLETED)
{ "success": false, "message": "Invalid transition: ASSIGNED → COMPLETED. Expected next status: IN_PROGRESS." }
```

---

## Stock Transfers

| Method | Path | Roles |
|--------|------|-------|
| GET | /api/transfers | ALL |
| POST | /api/transfers | ADMIN, OPERATIONS |
| GET | /api/transfers/:id | ALL |
| PATCH | /api/transfers/:id/dispatch | ADMIN, OPERATIONS |
| PATCH | /api/transfers/:id/receive | ADMIN, OPERATIONS |
| PATCH | /api/transfers/:id/cancel | ADMIN |

**Critical business rules:**
- DISPATCH reduces source `physicalQty` atomically (SELECT FOR UPDATE)
- DISPATCH does NOT touch destination inventory
- RECEIVE increases destination `physicalQty` and sets status to RECEIVED
- Double-receipt is prevented: only `DISPATCHED` transfers can be received

### POST /api/transfers

```json
// Request
{ "sourceLocationId": "...", "destLocationId": "...", "itemId": "...", "quantity": 30, "notes": "..." }

// 201 Created — status: REQUESTED
```

### PATCH /api/transfers/:id/dispatch

```json
// 200 OK — status: DISPATCHED, source physicalQty reduced
// 422 — insufficient available stock at source
{
  "success": false,
  "message": "Insufficient available stock at source. Available: 10, requested: 30."
}
// 400 — transfer is not in REQUESTED status
```

### PATCH /api/transfers/:id/receive

```json
// 200 OK — status: RECEIVED, destination physicalQty increased
// 400 — transfer not in DISPATCHED status (covers double-receipt)
{
  "success": false,
  "message": "Transfer cannot be received. Current status: RECEIVED. Only DISPATCHED transfers can be received."
}
```

---

## Customer Orders

| Method | Path | Roles |
|--------|------|-------|
| GET | /api/orders | ALL |
| POST | /api/orders | ADMIN, SALES |
| GET | /api/orders/:id | ALL |
| PATCH | /api/orders/:id/confirm | ADMIN, SALES |
| PATCH | /api/orders/:id/cancel | ADMIN, SALES |

**Reservation is atomic** — `confirm` uses `SELECT FOR UPDATE` on inventory rows in deterministic id order. Two concurrent confirms cannot collectively exceed `availableQty`.

### POST /api/orders

```json
// Request — creates PENDING order, does NOT reserve stock yet
{
  "customerName": "Acme Corp",
  "customerPhone": "+91-9876543210",
  "locationId": "...",
  "items": [
    { "inventoryId": "...", "quantity": 10 },
    { "inventoryId": "...", "quantity": 5 }
  ]
}

// 201 Created — status: PENDING
```

### PATCH /api/orders/:id/confirm

```json
// 200 OK — status: CONFIRMED, reservedQty incremented for each inventory row
// 422 — insufficient available stock
{
  "success": false,
  "message": "Insufficient available stock for one or more items.",
  "details": {
    "insufficientItems": [
      { "inventoryId": "...", "itemName": "Steel Rod 10mm", "available": 3, "requested": 10 }
    ]
  }
}
```

### PATCH /api/orders/:id/cancel

```json
// 200 OK — status: CANCELLED
// If order was CONFIRMED, reservedQty is decremented (reservation released)
// 400 — already cancelled
```

---

## Dashboard

### GET /api/dashboard

```json
// 200 OK — all roles
{
  "success": true,
  "data": {
    "items": { "total": 5 },
    "locations": { "total": 3 },
    "inventory": { "records": 10, "totalPhysical": 1025, "totalReserved": 0, "totalAvailable": 1025 },
    "workOrders": { "open": 1 },
    "transfers": { "pending": 0, "dispatched": 0 },
    "orders": { "pending": 0, "confirmed": 0 }
  }
}
```

---

## Health Check

### GET /health

```json
// 200 OK — database reachable
{ "status": "ok", "timestamp": "...", "uptime": 120, "database": { "status": "ok", "latencyMs": 1 } }

// 503 — database unreachable
{ "status": "degraded", "database": { "status": "unreachable" } }
```

---

## Error Response Format

All errors follow the same envelope:

```json
{
  "success": false,
  "message": "Human-readable description",
  "errors": [...],    // only on 422 validation failures
  "details": {...},   // only on some business errors (e.g. insufficientItems)
  "field": [...]      // only on 409 duplicate key (field name from DB)
}
```

| Status | Meaning |
|--------|---------|
| 200/201 | Success |
| 400 | Business rule violation (wrong state, invalid transition) |
| 401 | Missing / expired / invalid token |
| 403 | Authenticated but wrong role |
| 404 | Resource not found |
| 409 | Unique constraint violation |
| 422 | Validation failure or insufficient stock |
| 503 | Health check degraded |
