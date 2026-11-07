# 03 — Architecture Decision Records

> Each ADR documents a significant technical decision: the context that forced it, the options considered, the choice made, and the trade-offs accepted.

---

## ADR-001: Containerized Monolith on ECS Fargate

**Status:** Accepted

**Context:** The system is a single-domain operations tool with a relational data model and transactional integrity requirements. Traffic is low and steady, not bursty and event-driven.

**Problem:** How do we host a stateful, transactional web service with the least operational overhead for a case study that still wants to look production-shaped?

**Alternatives Considered:**

| Option | Problem |
|---|---|
| EC2 + manual process management | We own patching, process supervision, scaling. Most ops overhead. |
| Lambda + API Gateway | Stateless functions don't fit a long-lived Prisma connection pool; cold starts; no affinity to a DB connection. |
| ECS Fargate | Containers run continuously; no OS to patch; ALB integrates natively; matches the Docker Compose dev shape. |
| Elastic Beanstalk | Wraps EC2/ECS; adds a managed layer we don't need. |

**Decision:** ECS on Fargate, behind an ALB, one task per service.

**Reasons:**
- The same Docker images built for local Compose run in production — no second deployment artifact
- Fargate removes instance management; we never touch an OS
- ALB path-based routing splits `/api/*` and `/health` to the backend and everything else to the frontend, on one DNS name
- A long-lived Node process holds a stable Prisma connection pool, which a function model fights

**Trade-offs:**

| Trade-off | Accepted Because |
|---|---|
| `desired_count = 1` — no horizontal scale / zero-downtime deploy | Acceptable for a case study; a single task is the honest starting point |
| Pay for a running task even when idle | Low, steady traffic; Fargate's per-second billing is cheap at this size |
| No auto-scaling policy configured | Out of scope; flagged as a production improvement |

**Future Evolution:** Raise `desired_count` to 2+ and enable ALB deregistration delay for zero-downtime rolling deploys; add an ECS auto-scaling policy on average CPU.

---

## ADR-002: PostgreSQL (RDS) Over a NoSQL Store

**Status:** Accepted

**Context:** The core invariant is that `reservedQty` never exceeds `physicalQty` under concurrent mutations, which requires row-level locking and multi-statement transactions.

**Problem:** Which database provides correct row locking and ACID transactions for the reservation path?

**Alternatives Considered:**

| Option | Problem |
|---|---|
| DynamoDB | No `SELECT FOR UPDATE`; transaction model is different; over-reservation would need optimistic concurrency with conditional writes — more code, more retry logic. |
| SQLite | File-based; no concurrent writer model suitable for a server. |
| PostgreSQL | `SELECT FOR UPDATE` under READ COMMITTED serialises competing writes on a row; mature; managed by RDS. |
| MySQL | `SELECT FOR UPDATE` exists but Postgres was already the team's default. |

**Decision:** PostgreSQL 15 on RDS (db.t3.micro), private subnets, encrypted storage.

**Reasons:**
- `SELECT ... FOR UPDATE` is the exact primitive the concurrency design needs
- ACID transactions make the check-then-write reservation atomic and rollback-safe
- Prisma has first-class Postgres support and generates correct SQL
- RDS handles backups, patching, and encryption

**Trade-offs:**

| Trade-off | Accepted Because |
|---|---|
| Minimum RDS cost even when idle | The transactional guarantee is the point; a serverless DB would not give it as cleanly |
| `db.t3.micro` is small | Fine for a case study; size class is a Terraform variable |
| `backup_retention_period = 0` | Case-study choice; flagged as a production improvement |

**Future Evolution:** Enable automated backups and a multi-AZ standby for production; size up for real load.

---

## ADR-003: Prisma as the ORM

**Status:** Accepted

**Context:** The data model is relational with foreign keys, enums, unique constraints, and indexes. The team wanted type-safe queries without hand-writing SQL for every operation.

**Problem:** Which ORM gives type safety, a schema-first workflow, and a usable transaction API?

**Alternatives Considered:**

| Option | Problem |
|---|---|
| TypeORM | Heavier decorators; less predictable SQL; more configuration surface. |
| Raw `pg` driver | Maximum control but no type safety; every query is a string. |
| Prisma | Schema-first; generated types; `$transaction` API; raw `$queryRaw` escape hatch for `FOR UPDATE`. |

**Decision:** Prisma 5.

**Reasons:**
- The `schema.prisma` file is the single source of truth; `prisma generate` emits the types the whole backend uses
- `prisma.$transaction(async (tx) => …)` gives a clean atomic boundary
- `$queryRaw` lets us drop to raw SQL exactly where we need `SELECT ... FOR UPDATE`, which Prisma's query builder does not express
- Migrations are auto-generated from the schema diff

**Trade-offs:**

| Trade-off | Accepted Because |
|---|---|
| Cannot express `FOR UPDATE` in the builder | `$queryRaw` is a deliberate, scoped escape hatch |
| A generated client in `node_modules` | Standard Prisma workflow; `prisma generate` runs in the Docker build |
| Decimal fields serialize as strings to JSON | The frontend types reflect this (`unitPrice: string`) |

**Future Evolution:** None anticipated; Prisma covers the needs. If read load grows, add read replicas via Prisma's `read` datasource extension.

---

## ADR-004: SELECT FOR UPDATE with Deterministic Lock Order

**Status:** Accepted

**Context:** Prisma's `$transaction` runs at READ COMMITTED (Postgres default). Two concurrent confirmations can both read the same `reservedQty` before either commits, leading to over-reservation.

**Problem:** How do we make concurrent reservations safe without serialising the entire system?

**Alternatives Considered:**

| Option | Problem |
|---|---|
| Optimistic concurrency (version column + retry) | More code; retry storms under contention; harder to reason about. |
| Serialize at the application level (one global lock) | Kills throughput; one lock for all orders. |
| `SELECT FOR UPDATE` on the affected rows | The second request blocks until the first commits, then re-reads the updated value and correctly fails. |
| SERIALIZABLE isolation for the whole DB | Clobbers performance for every query, not just the hot path. |

**Decision:** `SELECT ... FOR UPDATE` inside `prisma.$transaction`, with rows locked in ascending `id` order.

**Reasons:**
- Locks exactly the rows an order touches, nothing more
- Under READ COMMITTED, `FOR UPDATE` blocks a second reader of the same row until the first transaction commits; the second then sees the new `reservedQty`
- Sorting the locked inventory `id`s into a single global order means any two transactions that overlap lock the same rows in the same order — so they cannot deadlock

**Trade-offs:**

| Trade-off | Accepted Because |
|---|---|
| A contended hot row serialises its reservers | That is the desired behaviour — only one can win |
| Locks held for the transaction's duration | The transaction is short (lock, check, update, commit) |

**Future Evolution:** If a single SKU becomes a severe contention point, consider sharding reservations by inventory row (choose a specific batch to reserve against) to spread the lock.

---

## ADR-005: availableQty Is Computed, Never Stored

**Status:** Accepted

**Context:** Inventory has `physicalQty` and `reservedQty`; "available" is the difference. There is pressure to store it for fast filtering/sorting.

**Problem:** Should `availableQty` be a column or a computed value?

**Alternatives Considered:**

| Option | Problem |
|---|---|
| Stored column, updated on every change | A third number that must stay in sync with two others; any partial update corrupts it silently. |
| Computed on read | Always a function of the two source fields; trivial arithmetic. |

**Decision:** Computed at read time; never persisted.

**Reasons:**
- There is no third number to keep consistent — the invariant `available = physical − reserved` is true by construction
- A stored column would add a write to every stock mutation path, increasing contention and bug surface
- Validation still enforces `physicalQty ≥ 0`, `reservedQty ≥ 0`, and `physicalQty ≥ reservedQty` at every mutation

**Trade-offs:**

| Trade-off | Accepted Because |
|---|---|
| Cannot index/sort by available in the DB directly | The frontend sorts client-side; row counts are modest |
| A tiny compute cost per read | Negligible |

**Future Evolution:** If fast server-side filtering by availability is needed, add a materialized view or a generated column kept in sync by a trigger — but only when measured need appears.

---

## ADR-006: referenceKey for Idempotent Stock Movements

**Status:** Accepted

**Context:** Networks retry. A retried dispatch or receive must not move stock twice.

**Problem:** How do we make stock movements idempotent?

**Alternatives Considered:**

| Option | Problem |
|---|---|
| Client-side de-dup with a request ID passed back | Works but requires the client to track state. |
| Unique `referenceKey` on the audit row | The DB enforces it; a duplicate insert fails with P2002 → 409. |
| No idempotency | Retries double-move stock — unacceptable. |

**Decision:** `InventoryTransaction.referenceKey String? @unique`. System operations use deterministic keys (`dispatch-<transferId>-<inventoryRowId>`, `receive-<transferId>`).

**Reasons:**
- The unique constraint is enforced by Postgres, not by application code
- A retried operation reuses the same key and is rejected by the DB
- Optional (`String?`) so manual one-off adjustments can omit it

**Trade-offs:**

| Trade-off | Accepted Because |
|---|---|
| A duplicate returns 409, not a silent no-op | The client can treat 409 on a retry as "already applied" |
| `NULL` is allowed (multiple NULLs OK) | Acceptable for non-idempotent manual entries |

---

## ADR-007: batchNumber Defaults to 'DEFAULT' (Non-Null)

**Status:** Accepted

**Context:** `@@unique([itemId, locationId, batchNumber])` should prevent duplicate inventory rows for the same item+location+batch.

**Problem:** What value represents "no specific batch" without breaking the unique constraint?

**Alternatives Considered:**

| Option | Problem |
|---|---|
| Nullable `batchNumber` | Postgres `NULL ≠ NULL` for uniqueness → multiple no-batch rows allowed → constraint broken. |
| Sentinel `'DEFAULT'` | Non-null; uniqueness works; one no-batch row per item+location. |

**Decision:** `batchNumber String @default("DEFAULT")`.

**Reasons:**
- Guarantees exactly one inventory row per (item, location, "no batch")
- The unique constraint behaves deterministically with a non-null sentinel

**Trade-offs:**

| Trade-off | Accepted Because |
|---|---|
| `'DEFAULT'` is a magic string | Documented in the schema; a small price for correct uniqueness |

---

## ADR-008: Snapshot Display Fields on Work Orders, Transfers, and Order Items

**Status:** Accepted

**Context:** Item names, SKUs, and prices can change. Historical documents should describe what was true when they were created.

**Decision:** Copy `itemName`, `itemSku` (and `unitPrice` on order items) from the `Item` at creation time. Keep the live `itemId` reference for navigation.

**Reasons:** Audit accuracy — a work order from last quarter still reads the item name that was correct then.

**Trade-off:** Slight denormalization and the possibility of a stale-looking name if the item is renamed — which is the intended behaviour for historical records.

---

## ADR-009: Collision-Safe Order Numbers (Timestamp + Random)

**Status:** Accepted

**Context:** `ORD-<COUNT+1>` races under concurrent `POST /api/orders`: two requests read the same count and both produce the same number, hitting a P2002 on `@unique`.

**Decision:** `ORD-${Date.now()}-${random5}`. Work-order and transfer numbers use `COUNT+1` (`WO-00001`, `TR-00001`) because their creation is low-frequency and not the contested path.

**Reasons:** The timestamp+random suffix is statistically unique without a DB sequence or extra locking; collisions are astronomically unlikely.

**Trade-off:** Less sequential-looking than a pure sequence — acceptable for an order number that is a display identifier, not the primary key.

---

## ADR-010: JWT (HS256) with bcrypt, No Refresh

**Status:** Accepted

**Context:** The system needs stateless auth that scales without a session store.

**Decision:** `jsonwebtoken` (HS256, 8h expiry) signed with `JWT_SECRET`; passwords hashed with bcryptjs (10 rounds). No refresh token flow.

**Reasons:**
- Stateless: any task can verify a token; no shared session store needed
- bcrypt cost factor 10 is the documented default
- The production startup guard refuses to run with the dev fallback secret

**Trade-offs:**

| Trade-off | Accepted Because |
|---|---|
| No refresh → users re-login after 8h | Out of scope for the case study; flagged as an improvement |
| HS256 (symmetric) means the signer is the verifier | Fine for a single backend; no third-party verifier exists |

---

## ADR-011: Secrets via SSM SecureString in Production

**Status:** Accepted

**Context:** ECS task definition environment variables are visible in the console and in describe calls.

**Decision:** `DATABASE_URL` and `JWT_SECRET` live in SSM SecureString and are injected via the task definition `secrets` array. `lifecycle { ignore_changes = [value] }` prevents Terraform from overwriting rotated secrets.

**Reasons:** Values are encrypted at rest, IAM-controlled, and never appear in Terraform state or CI logs.

**Trade-off:** Adds an SSM round-trip at task start — negligible.

---

## ADR-012: Reuse the Express + Prisma Stack (No NestJS)

**Status:** Accepted

**Context:** A new framework is appealing but costs scaffolding time.

**Decision:** Reuse the proven Express/Prisma stack rather than introduce NestJS + TypeORM.

**Reasons:** The stack is already understood, tested, and idiomatic. Express keeps the architecture flat and auditable — every route is visible. The novelty budget is spent on the concurrency problem, not on framework scaffolding.

**Trade-off:** We forgo NestJS's module/DI ergonomics — acceptable for a flat, single-domain service.

---

## ADR-013: Incremental, Vertical-Slice Build

**Status:** Accepted

**Context:** The system has auth, inventory, work orders, transfers, orders, frontend, Docker, Terraform, and CI — a lot to integrate at once.

**Decision:** Build in vertical slices, simplest to most complex: auth → locations → items → dashboard → inventory (first transactions) → work orders (state machine) → transfers (lifecycle) → orders (concurrency) → frontend → Docker → Terraform → CI.

**Reasoning:** Each completed slice is working end-to-end before the next begins. When a later slice breaks, the earlier ones are already verified — the problem is isolated. Building everything at once means debugging ten integrated systems when one fails.

**Trade-off:** Some rework when later slices reveal earlier assumptions — worth the debugging isolation.

---

**Read next:** [04 — System Architecture →](04-System-Architecture.md)

[← Back to documentation index](README.md)
