# 14 — Lessons Learned

> Reflections on building this system — what worked, what surprised, what to repeat, and what to do differently next time.

---

## 1. Solve the Hard Problem First

The hard problem was concurrency, not CRUD. Spending the design budget on `SELECT FOR UPDATE`, lock ordering, and the transaction boundary meant the rest of the routes were straightforward once the pattern was set. If the effort had gone into scaffolding first and concurrency last, the over-reservation bug would have been found late, under load, and would have required rethinking the data access layer.

**Repeat:** identify the one invariant that is non-negotiable, design the data access around it, and let the easy paths follow.

## 2. Derived Values Are Cheaper Than Synchronised Stored Values

Choosing to compute `availableQty` and `shortageQty` on read removed two entire classes of bugs: "the third number got out of sync" and "the stored value is stale." The cost is a few arithmetic operations per read. This trade is almost always worth it.

**Repeat:** never store what you can cheaply derive from sources of truth.

## 3. `NULL ≠ NULL` Bites Uniqueness

The `batchNumber` defaulting to `'DEFAULT'` was not a style choice — it was forced by Postgres's `NULL ≠ NULL` rule for unique constraints. A nullable batch would have allowed duplicate "no-batch" inventory rows, silently breaking the unique constraint. This is the kind of database behaviour that is invisible until it produces wrong data.

**Repeat:** when a unique constraint includes an optional field, use a non-null sentinel, not NULL.

## 4. Lock Ordering Prevents Deadlocks Before They Happen

Adding `ORDER BY id` to the `FOR UPDATE` query was a one-line change that removed an entire failure class. Without it, two transactions locking overlapping rows in opposite orders would deadlock under contention — a bug that appears only under load and is hard to reproduce. The deterministic order makes the deadlock structurally impossible.

**Repeat:** when locking multiple rows in a transaction, always lock in a single global order.

## 5. `COUNT+1` Races; Use a Sequence or Entropy

Order numbers initially used `COUNT+1`, which races under concurrent creation (two reads see the same count → duplicate → P2002). The fix was `ORD-${Date.now()}-${random}`. Work-order and transfer numbers still use `COUNT+1` because those paths are low-frequency and single-actor, but the lesson generalises: identifiers generated from a count are a race waiting to happen on any contended path.

**Repeat:** for any ID generated under concurrency, use a DB sequence, a ULID, or timestamp+entropy — never a count.

## 6. Schema-First Pays Compounding Returns

Defining the whole Prisma schema before any route meant every route imported generated types that already existed. The compiler caught mismatches; there was no "shape the response in the route, then fix the frontend" loop. The schema became the contract.

**Repeat:** in a typed stack, the schema is the contract; write it first.

## 7. Vertical Slices Make Bugs Local

Building auth → simple CRUD → dashboard → inventory (first transactions) → work orders (state machine) → transfers (lifecycle) → orders (concurrency) meant each slice worked end-to-end before the next began. When orders broke, everything before it was verified, so the bug was isolated to the new layer.

**Repeat:** order construction by dependency and difficulty, simplest first, so a failure is always in the newest layer.

## 8. Reuse the Proven Stack; Spend Novelty on the Problem

Reusing Express + Prisma + Postgres instead of introducing NestJS + TypeORM meant the time went into the concurrency design, not into framework configuration. The stack was already idiomatic; the difficulty was the domain.

**Repeat:** in a fixed-scope project, spend your novelty budget on the problem, not the tooling.

## 9. Idempotency Is a Property, Not a Feature

The `referenceKey` is not a feature a user sees — it is a property of the system that a retried request is a no-op. Designing it in (deterministic keys for system operations) made retries safe by construction. Adding it later would mean auditing every code path that moves stock.

**Repeat:** for any operation that mutates state, ask "what happens if this is submitted twice?" and make the answer "nothing the second time."

## 10. Snapshots Preserve History

Copying `itemName`/`itemSku`/`unitPrice` onto work orders, transfers, and order items means historical records describe the world as it was. It costs a few columns; it prevents "the order says Steel Rod but the item is now called Steel Rod Grade A" confusion.

**Repeat:** distinguish references (live) from descriptions (frozen).

## 11. nginx `envsubst` Lets the Container Learn Its Backend at Start

The frontend's nginx config is a template; the docker entrypoint substitutes `${BACKEND_URL}` at container start. This means the same image works in Compose (`BACKEND_URL=http://backend:4000`) and in ECS (`BACKEND_URL=http://<ALB_DNS>`) without a rebuild. Building the API base URL into the JS bundle (`VITE_API_BASE_URL=/api`) means the browser always calls `/api`, and the proxy (Vite in dev, nginx in prod) resolves it.

**Repeat:** keep runtime configuration out of the build; let the container resolve its neighbours at start.

## 12. Separate `app` from `index`

Exporting the Express `app` from `app.ts` and starting the server in `index.ts` meant tests import `app` and fire Supertest requests without binding a port or starting a real server. This made the 74 integration tests fast and isolated.

**Repeat:** separate "construct the app" from "run the server" so tests can use the former without the latter.

## 13. Honest Limitations Are Better Than Hidden Ones

Documenting the gaps (no HTTPS, no rate limiting, single task, no refresh, no partial receipt) as a known-limitations list — rather than implying the system is production-complete — keeps trust and makes the improvement roadmap obvious.

**Repeat:** name what is not done; an explicit gap list is a feature.

## 14. What I Would Do Differently

- Add HTTPS and rate limiting from day one — they are cheap and the JWT-in-cleartext gap is the one thing that is genuinely unsafe rather than merely incomplete.
- Use a Postgres sequence for all display numbers, not `COUNT+1` for any of them.
- Lock rows on CONFIRMED-order cancel, not just on confirm, for symmetry.
- Add the frontend test harness at the same time as the first page, not after — retrofitting tests onto a finished UI is slower than writing them alongside.
- Turn on S3 remote state before the second person touches the Terraform.


---

**Read next:** [15 — Interview Guide →](15-Interview-Guide.md)

[← Back to documentation index](README.md)
