# 02 — Engineering Thinking

> This document records the engineering mental models that shaped the system — the principles that, once chosen, made most of the implementation decisions follow naturally.

---

## 1. The Central Problem Is Concurrency, Not CRUD

A naive Operations ERP is a CRUD app: create items, record stock, take orders. The hard part is not the data entry — it is what happens when two people act on the same stock at the same time.

```
Shelf has 10 units available.
Salesperson A confirms an order for 8 units.
Salesperson B confirms an order for 8 units.
Combined demand = 16. Stock = 10. Who wins?
```

If both reads happen before either write commits, both see "10 available" and both succeed — and `reservedQty` becomes 16 against 10 physical. The shelf is over-promised. This is the entire reason `SELECT FOR UPDATE` exists in this codebase. Every other engineering decision is in service of keeping this single invariant true:

> **`reservedQty` can never exceed `physicalQty`, even under concurrent mutations.**

Once you accept that this invariant is non-negotiable, the rest follows: you need row locks, you need deterministic lock order (to avoid deadlocks), you need the check-and-write to happen inside one transaction, and you need the database to be PostgreSQL (which has correct `SELECT FOR UPDATE` semantics under READ COMMITTED).

---

## 2. Derived Values Are More Honest Than Stored Values

The system treats `availableQty` and `shortageQty` as **derived** — computed on read, never persisted.

```
availableQty = physicalQty − reservedQty
shortageQty  = max(requiredQty − availableQty, 0)
```

A stored `availableQty` column would be a third number that has to stay consistent with two others. Every code path that changes `physicalQty` or `reservedQty` would also have to recompute and persist `availableQty`. Any bug that updates two of the three corrupts the data silently, and the corruption is invisible because the column "looks right."

By computing on read, the value is always a function of the two source-of-truth fields. There is no third number to keep in sync. The cost is a tiny amount of arithmetic per read, which is negligible.

This is the same principle as "single source of truth" in state management: don't store what you can derive.

---

## 3. State Machines Make Invalid Transitions Impossible to Express

Three entities have explicit state machines enforced in code:

```
WorkOrder:    ASSIGNED → IN_PROGRESS → COMPLETED        (forward only)
StockTransfer: REQUESTED → DISPATCHED → RECEIVED         (+ CANCELLED from REQUESTED only)
CustomerOrder: PENDING → CONFIRMED                        (+ CANCELLED from PENDING or CONFIRMED)
```

The implementation does not ask "is this status allowed?" by listing valid pairs. It computes the single allowed next status from the current status and rejects anything else:

```typescript
const transitions: Record<WorkOrderStatus, WorkOrderStatus | null> = {
  ASSIGNED:    IN_PROGRESS,
  IN_PROGRESS: COMPLETED,
  COMPLETED:   null,
};
const allowedNext = transitions[wo.status];
if (newStatus !== allowedNext) throw new AppError(400, ...);
```

This is a closed enum mapping. You cannot express "ASSIGNED → COMPLETED" because the map says `ASSIGNED` goes to `IN_PROGRESS` and only to `IN_PROGRESS`. The double-receipt guard is the same pattern: "only `DISPATCHED` can be received" means a `RECEIVED` transfer is structurally unable to be received again.

The lesson: when a domain has a lifecycle, model it as a function from current state to allowed next state, not as a set of accepted pairs. The function is harder to get wrong.

---

## 4. Idempotency Keys Turn Retries Into No-Ops

Networks retry. A client that doesn't get a response will send the same dispatch again. Without protection, the stock leaves the source twice.

The `InventoryTransaction.referenceKey` (`String? @unique`) is the idempotency mechanism. System-generated transactions use deterministic keys:

```
dispatch-<transferId>-<inventoryRowId>   ← per source row deducted
receive-<transferId>                     ← per receipt
```

A retried dispatch reuses the same key; the second insert hits the unique constraint and Prisma throws `P2002`, which the error handler maps to 409. The retry does not deduct stock a second time. Manual adjustments may supply their own key (e.g., `PO-12345`); if omitted, the transaction is recorded without idempotency protection (a one-off manual entry).

The lesson: any operation that moves stock should be idempotent by key, not by accident.

---

## 5. Snapshot at Point-in-Time for Historical Records

Work orders, transfers, and order items all carry `itemName` and `itemSku` (and order items carry `unitPrice`) copied from the `Item` at creation time, not joined from the live item.

If a Steel Rod is renamed to "Steel Rod 10mm Grade A" six months from now, a work order created today still reads "Steel Rod 10mm" — the name that was true when the work order was raised. This matters for audit: historical documents should describe the world as it was, not as it is now. The live item is still referenced by `itemId` for navigation, but the display fields are frozen.

The lesson: distinguish between "this record refers to that item" (foreign key, live) and "this record describes what was ordered" (snapshot, frozen).

---

## 6. Every Mutation Is an Audit Transaction

The `InventoryTransaction` model is not optional decoration. It is the only place the full history of a stock row lives. The `Inventory` row itself is the current state; the transactions are how it got there.

Every code path that changes `physicalQty` (initial stock, manual adjustment, transfer dispatch, transfer receipt) writes a transaction row with: the inventory row, `IN`/`OUT`, the quantity, a human reason, the acting user, and (where deterministic) a `referenceKey`. This means you can reconstruct the current `physicalQty` of any row by summing its transactions — a property that makes the system auditable and makes bugs discoverable.

---

## 7. The Backend Is the Trust Boundary, Not the Frontend

The frontend hides navigation from users who lack the role, but that is UX, not security. The real authorization is in `authorize(...roles)` on every backend route. A SALES user who crafts a `curl` to `POST /api/transfers` gets a 403 from the server regardless of what the UI shows.

This is why the role check is duplicated: the frontend filters the nav for a good experience; the backend rejects the request for safety. Neither is sufficient alone — the frontend is bypassable, and a backend-only check with no frontend filtering makes the app unusable.

---

## 8. Schema-First Means Types Flow Downhill

The Prisma schema is the single source of truth. `npx prisma generate` emits TypeScript types into `@prisma/client`. The backend imports them for handlers and validation; the frontend re-declares matching interfaces in `src/types`. They are not shared by a codegen step (a known limitation), but they mirror each other deliberately.

The advantage: the database schema, the ORM query types, and the API response shapes all derive from one definition. When the schema changes, `prisma generate` updates the backend types and the compiler finds the mismatches.

---

## 9. Transactions Are the Unit of Atomicity, Not Routes

A route handler is not atomic by itself. Several routes do reads, validation, and writes that must all succeed or all roll back. The atomicity boundary is `prisma.$transaction(async (tx) => { ... })`.

Inside that callback, every `tx.*` call is part of one database transaction. A thrown `AppError` (e.g., "insufficient stock") rolls back every write in the callback. The reservation confirm, the transfer dispatch, the transfer receive, and the manual adjust all use this pattern. Reads outside the transaction are not protected — which is why the lock (`SELECT FOR UPDATE`) is also inside the transaction, so the read sees a locked row that no one else can change until commit.

---

## 10. Failure Is a First-Class Response

Errors are not exceptions that bubble to a generic 500. They are typed responses with a stable envelope:

```json
{ "success": false, "message": "...", "details": { "insufficientItems": [...] } }
```

`AppError(statusCode, message, details?)` is the structured application error. Prisma's `P2002` (unique violation) becomes 409; `P2025` (record not found on update/delete) becomes 404. Only truly unexpected errors reach the 500 fallback. This means a client can program against status codes and a predictable `success` flag, rather than parsing strings.

---

## 11. Keep the Stack Already Proven

The single biggest process decision was to reuse a known stack (Express + Prisma + PostgreSQL) rather than introduce a new framework (NestJS + TypeORM) for a case study. A new framework would have consumed the time budget on scaffolding instead of on the actual hard problem — concurrency. The stack was already understood, tested, and idiomatic; the effort went where the difficulty was.

This is a general principle: in a fixed-scope project, spend your novelty budget on the problem, not on the tooling. Reach for a new tool only when the old one cannot solve the problem.

---

**Read next:** [03 — Architecture Decision Records →](03-Architecture-Decision-Records.md)

[← Back to documentation index](README.md)
