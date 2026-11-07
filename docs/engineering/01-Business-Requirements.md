# 01 — Business Requirements

> This document answers: why does this system exist, who uses it, what problem does it solve, and what are the constraints it must operate within.

---

## 1. Business Problem

A manufacturing or warehouse operation needs to know, at all times, what stock it has, where that stock is, what it has been promised to customers, and what it still needs to fulfil production. Without a single source of truth, the same physical stock gets promised twice, stock that has left a warehouse but not arrived at its destination is double-counted or lost, and nobody can tell how short a work order is until someone walks the floor.

The business need is:

- Operations staff must be able to record stock per item, per location, per batch, and see how much is genuinely available after customer reservations
- Work orders must declare what an item is required, at which location, for whom, and surface the shortage live
- Stock must move between locations through a controlled lifecycle — requested, dispatched (source reduced), then received (destination increased) — with no way to receive the same transfer twice
- Sales must be able to reserve stock for customers atomically, so that two sales people confirming orders against the same shelf cannot collectively over-promise it
- Every action must be restricted to the role permitted to perform it

---

## 2. Business Capabilities

### Administrator (ADMIN) Capabilities
| Capability | Description |
|---|---|
| Manage Locations | Create warehouse / shop-floor locations |
| Manage Items | Create and update the product catalog |
| Manage Inventory | Create inventory records and adjust stock IN/OUT |
| Manage Work Orders | Create work orders and advance their status |
| Manage Transfers | Request, dispatch, receive, and cancel transfers |
| Manage Orders | Create, confirm, and cancel customer orders |

### Operations (OPERATIONS) Capabilities
| Capability | Description |
|---|---|
| Manage Items | Create and update the product catalog |
| Manage Inventory | Create inventory records and adjust stock IN/OUT |
| Advance Work Orders | Move work order status forward (ASSIGNED → IN_PROGRESS → COMPLETED) |
| Manage Transfers | Request, dispatch, and receive transfers |

### Sales (SALES) Capabilities
| Capability | Description |
|---|---|
| Read All Data | Browse inventory, work orders, transfers, items, locations, dashboard |
| Manage Orders | Create, confirm, and cancel customer orders (the reservation path) |

### System Capabilities (Automated)
| Capability | Description |
|---|---|
| Compute Availability | `availableQty = physicalQty − reservedQty`, computed on every read, never stored |
| Compute Shortage | `shortageQty = max(requiredQty − availableQty, 0)`, computed live per work order |
| Enforce State Machines | Forward-only work-order status; transfer lifecycle; order lifecycle |
| Reserve Atomically | Lock inventory rows and reserve stock so concurrent confirms cannot over-reserve |
| Audit Every Movement | Write an `InventoryTransaction` for every stock change, with an idempotency key |

---

## 3. Actors

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    ADMIN     │     │ OPERATIONS   │     │    SALES     │
│              │     │              │     │              │
│ Locations    │     │ Items        │     │ Reads all    │
│ Items        │     │ Inventory    │     │ Customer     │
│ Inventory    │     │ WorkOrders*  │     │  orders      │
│ WorkOrders   │     │ Transfers    │     │  (reserve)   │
│ Transfers    │     │              │     │              │
│ Orders       │     │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
                        * advance status only (ADMIN creates)

All three roles can READ every domain.
```

No signup/self-registration actor is in scope. Users are provisioned by seed or direct database access — see [Known Limitations](13-Production-Improvements.md).

---

## 4. Core Business Flow

```
ADMIN: create Items + Locations
        │
        ▼
OPERATIONS: create Inventory (item + location + batch, physicalQty)
        │
        ▼
ADMIN: create Work Order (item required at location, assigned user)
        │  system shows shortageQty = requiredQty − availableQty (live)
        ▼
OPERATIONS: request Transfer (source → dest)
        │
        ▼
OPERATIONS: dispatch Transfer  ── source physicalQty ↓ (dest unchanged)
        │                         stock is "in transit"
        ▼
OPERATIONS: receive Transfer  ── dest physicalQty ↑ (double-receipt blocked)
        │
        ▼
SALES: create Customer Order (PENDING — no reservation yet)
        │
        ▼
SALES: confirm Order  ── reservedQty ↑ atomically (SELECT FOR UPDATE)
        │                concurrent confirms cannot over-reserve
        ▼
SALES: (optionally) cancel Order ── if CONFIRMED, reservedQty ↓ (release)
```

---

## 5. Functional Requirements

### Authentication & Authorization
- FR-01: All protected operations must authenticate with a JWT before authorization is checked
- FR-02: Users must be classified as ADMIN, OPERATIONS, or SALES
- FR-03: The JWT must carry `userId`, `email`, and `role` claims and expire after a configured TTL (default 8h)
- FR-04: Every route (except `POST /api/auth/login` and `GET /health`) must enforce `authenticate` then `authorize(...roles)` at the backend, not just the frontend
- FR-05: The server must refuse to start in production if `JWT_SECRET` is missing or is the insecure dev fallback

### Inventory Management
- FR-06: Inventory is one row per (item, location, batch) combination, enforced by a unique constraint
- FR-07: `batchNumber` must default to `DEFAULT` (not NULL) so the unique constraint behaves deterministically
- FR-08: `availableQty` must equal `physicalQty − reservedQty` and must never be stored in the database
- FR-09: Stock adjustments must validate that the result never goes negative and that `physicalQty` never drops below `reservedQty`
- FR-10: Every stock change must write an `InventoryTransaction` audit record
- FR-11: An optional `referenceKey` on a transaction must act as an idempotency key — a duplicate submission returns 409, not a duplicate adjustment

### Work Orders
- FR-12: Only ADMIN may create work orders; only ADMIN/OPERATIONS may advance status
- FR-13: `shortageQty` must be `max(requiredQty − availableQty, 0)` computed at read time from live inventory, never stored
- FR-14: Work order status must progress forward only: ASSIGNED → IN_PROGRESS → COMPLETED; any other transition is rejected with 400
- FR-15: Work orders must snapshot `itemName` and `itemSku` at creation for historical accuracy

### Stock Transfers
- FR-16: Transfers move stock from a source location to a different destination location
- FR-17: Dispatch must reduce source `physicalQty` atomically and must NOT touch destination inventory
- FR-18: Dispatch must reject (422) when the requested quantity exceeds available stock at the source
- FR-19: Receipt must increase destination `physicalQty` and must reject (400) any transfer not in DISPATCHED status — this prevents double-receipt
- FR-20: Only ADMIN may cancel a transfer, and only from the REQUESTED state
- FR-21: Dispatch and receipt must each write an `InventoryTransaction` with a deterministic `referenceKey`

### Customer Orders
- FR-22: Creating an order produces a PENDING order; it must NOT reserve stock
- FR-23: Confirming an order must atomically increment `reservedQty` on each referenced inventory row
- FR-24: Confirmation must reject (422) when available stock is insufficient for any item, with the specific insufficient items detailed
- FR-25: Two concurrent confirmations that collectively exceed available stock must not both succeed — exactly one must reserve, the other must fail
- FR-26: Cancelling a CONFIRMED order must release its reservation (decrement `reservedQty`); cancelling a PENDING order changes only status
- FR-27: Order numbers must be collision-safe under concurrent creation

### Observability
- FR-28: A `/health` endpoint must report database reachability and latency without requiring authentication

---

## 6. Non-Functional Requirements

### Availability
- NFR-01: The system must degrade gracefully — a database outage must surface as a 503 health status, not a crash
- NFR-02: The frontend must be served independently of the backend so a backend restart does not blank the SPA

### Scalability
- NFR-03: The reservation path must remain correct under concurrent requests without pre-provisioning database capacity
- NFR-04: The database connection pool must not be exhausted during development hot-reloads

### Latency
- NFR-05: Read endpoints must paginate by default (page/limit) to bound response size and latency
- NFR-06: Reservation (confirm) must complete within a single short transaction; rows are locked in deterministic order to avoid deadlock-induced waits

### Security
- NFR-07: Secrets must never appear in container environment variables in plaintext; production uses SSM SecureString
- NFR-08: Authorization must be enforced at the backend on every route, independent of the frontend
- NFR-09: Containers must run as a non-root user

### Maintainability
- NFR-10: All AWS infrastructure must be defined as code (Terraform); no manual console configuration
- NFR-11: The data model must be schema-first (Prisma) so types are generated and shared across the stack
- NFR-12: Every route must validate input with express-validator before reaching business logic

### Correctness (the defining NFRs)
- NFR-13: `physicalQty ≥ 0`, `reservedQty ≥ 0`, and `physicalQty ≥ reservedQty` must hold at every mutation point
- NFR-14: Concurrent reservations must be serialised at the row level; over-reservation is impossible by construction
- NFR-15: A transfer can be received exactly once; double-receipt is impossible by construction

---

## 7. Business Constraints

| Constraint | Impact |
|---|---|
| Single AWS region (ap-south-1) | No multi-region failover |
| Single ECS task per service (`desired_count = 1`) | No zero-downtime rolling deploy; no horizontal scale |
| ALB is HTTP only (port 80) | No HTTPS termination; no TLS at the edge |
| Local Terraform state (S3 backend commented out) | Not suitable for team collaboration |
| No JWT refresh flow | Users re-login after 8h |
| No payment processing | Orders reserve stock only; no billing |
| Users provisioned via seed only | No user-management UI or signup endpoint |
| No partial transfer receipt | A transfer is received in full or not at all |
| No stock reversal on transfer cancel | Cancellation is only permitted in the REQUESTED state |

---

## 8. System Boundaries

### In Scope
- JWT authentication and role-based authorization across three roles
- Item catalog, locations, and per-batch inventory with computed availability
- Stock adjustments with an audit trail and idempotency keys
- Work orders with live shortage calculation and forward-only status
- Internal stock transfers with a three-state lifecycle and double-receipt prevention
- Customer orders with atomic, concurrency-safe stock reservation and release on cancel
- A dashboard of aggregate counts
- Docker Compose for local full-stack runs
- GitLab CI/CD pipeline (validate → test → build → package → deploy)
- Terraform-provisioned AWS footprint (VPC, ALB, ECS Fargate, RDS, SSM, ECR, CloudWatch)

### Out of Scope
- User self-signup and a user-management screen
- JWT refresh tokens
- Rate limiting
- Frontend automated tests
- Payment processing / invoicing
- Partial transfer receipt and damaged-stock tracking
- HTTPS / TLS termination at the ALB
- Multi-region or multi-environment deployments
- Stock reversal when cancelling an already-dispatched transfer

---

## 9. Success Criteria

The system is considered successful when:

1. An ADMIN can sign in, create a location and an item, and create an inventory record that shows the correct `availableQty`
2. An OPERATIONS user can request a transfer, dispatch it (source stock falls), and receive it (destination stock rises) — and a second receive is rejected
3. A SALES user can create an order, confirm it (reservation applied), and cancel it (reservation released)
4. Two SALES users confirming orders that together exceed available stock cannot both succeed — exactly one reserves, the other receives a 422 listing the insufficient item
5. An unauthenticated request to any protected route returns 401, and an authenticated user in the wrong role receives 403
6. The entire AWS footprint can be destroyed and recreated with `terraform apply`
7. `docker compose up --build` brings up the full stack, seeded and healthy, on a single command

---

## 10. Business Assumptions

- `availableQty` is a derived value; the two source fields (`physicalQty`, `reservedQty`) are the source of truth
- A reservation is a hold, not a consumption — `physicalQty` is unchanged by reservation; only `reservedQty` moves
- A transfer in DISPATCHED state represents stock that has physically left the source but not yet arrived at the destination; it is neither at source nor at destination in full
- A work order's shortage is a point-in-time observation, not a stored fact; it recomputes as inventory changes
- Roles are assigned at provisioning (seed), not through an approval workflow
- Order numbers and transfer/work-order numbers are display identifiers; the database primary key (`cuid`) is the true identity


---

**Read next:** [02 — Engineering Thinking →](02-Engineering-Thinking.md)

[← Back to documentation index](README.md)
