# End-to-End Verification Evidence

## Test Suite Results

```
Test Suites: 5 passed, 5 total
Tests:       74 passed, 74 total
Time:        ~5-7s
```

Run command: `cd backend && npm test`

## Mandatory PDF Tests — Verified by Execution

### Test 1 — Cannot reserve more than available inventory

File: `backend/src/__tests__/orders.test.ts`

```
✓ returns 422 when requested quantity exceeds available (10 available, request 15)
✓ inventory reservedQty unchanged after failed reservation attempt
✓ reservedQty can never exceed physicalQty
✓ only one of two simultaneous reservations succeeds when combined qty > available
✓ final reservedQty equals exactly 8 — not 16 (no over-reservation)
```

Concurrency mechanism: `SELECT id, "physicalQty", "reservedQty" FROM inventory WHERE id = ANY($ids) ORDER BY id FOR UPDATE`
inside `prisma.$transaction()`. Rows locked in ascending id order to prevent deadlocks.

### Test 2 — Cannot transfer more than available inventory

File: `backend/src/__tests__/transfers.test.ts`

```
✓ dispatch returns 422 when quantity exceeds available stock
✓ source stock remains unchanged after a failed dispatch
✓ transfer stays in REQUESTED status after a failed dispatch
```

### Test 3 — Destination stock increases only after transfer receipt

File: `backend/src/__tests__/transfers.test.ts`

```
✓ before dispatch: destination has no inventory record at Location B
✓ dispatch succeeds (200) and reduces source stock
✓ after dispatch: destination stock has NOT increased yet
✓ receipt succeeds (200) and increases destination stock
✓ source stock unchanged after receipt (still 30)
```

### Test 4 — Same transfer cannot be received twice

File: `backend/src/__tests__/transfers.test.ts`

```
✓ Mandatory Test 4 — receiving the same transfer again returns 400
✓ destination stock unchanged after double-receipt attempt (still 20)
```

Double-receipt guard: transfer row locked with `SELECT ... FOR UPDATE` inside receive transaction; status check `!== DISPATCHED` returns 400 immediately.

### Test 5 — Unauthorized user cannot perform restricted operation

File: `backend/src/__tests__/rbac.test.ts`

```
✓ GET /api/locations without token → 401
✓ GET /api/inventory without token → 401
✓ GET /api/work-orders without token → 401
✓ GET /api/transfers without token → 401
✓ GET /api/orders without token → 401
✓ SALES cannot create a location (ADMIN only) → 403
✓ SALES cannot create an item (OPS_ADMIN only) → 403
✓ SALES cannot adjust inventory (OPS_ADMIN only) → 403
✓ SALES cannot create a work order (ADMIN only) → 403
✓ SALES cannot update work order status (OPS_ADMIN only) → 403
✓ SALES cannot create a transfer (OPS_ADMIN only) → 403
✓ SALES cannot dispatch a transfer (OPS_ADMIN only) → 403
✓ SALES cannot receive a transfer (OPS_ADMIN only) → 403
✓ OPERATIONS cannot create a location (ADMIN only) → 403
✓ OPERATIONS cannot create a work order (ADMIN only) → 403
✓ OPERATIONS cannot confirm a customer order (SALES_ADMIN only) → 403
✓ OPERATIONS cannot cancel a customer order (SALES_ADMIN only) → 403
```

## Docker Compose Verification

Images built successfully:
- `ops-erp-backend:local` — multi-stage node:20-alpine, tsc clean, prisma generate OK
- `ops-erp-frontend:local` — Vite compiled 106 modules, 5 lazy-loaded page chunks

`docker compose config` — VALID

End-to-end checks (12/12 pass against running compose stack):
- Backend `/health` → `{ status: "ok", database: { status: "ok", latencyMs: 1 } }`
- Login `admin@opserp.dev` → ADMIN JWT token
- GET `/api/auth/me` → ADMIN role
- GET `/api/locations` → 3 seeded locations
- GET `/api/inventory` → 10 rows, all with `availableQty` field
- GET `/api/work-orders` → WO-00001 with `shortageQty: 15`
- No-token request → 401
- SALES POST `/work-orders` → 403
- Frontend `GET /` → 200 (SPA)
- Frontend `/inventory` → 200 (SPA fallback)
- Frontend `/health` → proxied to backend
- Frontend `/api/locations` → proxied to backend

## TypeCheck Results

```
backend  (npx tsc --noEmit):  PASS — 0 errors
frontend (npx tsc --noEmit):  PASS — 0 errors
```

## API Smoke Tests (backend running locally)

16/16 checks pass:
- Health, login (all 3 roles), /me
- All 7 API endpoints accessible to ADMIN
- SALES and OPS read access confirmed
- `availableQty` = `physicalQty - reservedQty` verified across all 10 inventory rows
- `shortageQty` present on work order responses

## CI/CD Pipeline

Pipeline configuration: `.gitlab-ci.yml`
- 5 stages: validate → test → build → package → deploy
- Test stage: PostgreSQL service container, all 74 tests run
- Package stage: Docker images to GitLab Container Registry
- Deploy stage: ECR push + ECS update-service (main branch, MANUAL gate)

Note: Remote GitLab pipeline execution has not been verified in this environment
(no GitLab remote configured). Configuration is locally validated.

## Terraform Infrastructure

`terraform fmt -check`: PASS
`terraform validate`: Requires `terraform init` to download provider.
No stale CS1 resources (no S3 product-image bucket, no challan infrastructure).
