# 11 — Failure Scenarios

> What can go wrong, how the system detects it, what happens to the user, and how bad it is. Each row is a real failure mode for this architecture, not a generic checklist.

---

## 1. Concurrency & Correctness Failures

| Failure | Detection | Behavior | Severity |
|---|---|---|---|
| Two confirms exceed available stock | `SELECT FOR UPDATE` + availability check | Second blocks, then 422 with `insufficientItems`; no over-reservation | Handled — correct |
| Concurrent transfer receive (double-receipt) | Transfer-row `FOR UPDATE` + `status === DISPATCHED` check | Second 400; destination unchanged | Handled — correct |
| Deadlock between two overlapping confirms | Rows locked `ORDER BY id` | Cycle cannot form; no deadlock | Prevented by design |
| Dispatch more than source available | `Σ(physical − reserved) < qty` check | 422; source unchanged; transfer stays REQUESTED | Handled |
| Adjust OUT below zero | `newPhysical < 0` check | 422 "would result in negative stock" | Handled |
| Adjust OUT below reserved | `newPhysical < reservedQty` check | 422 "release reservations first" | Handled |
| Invalid work-order transition | `transitions` map | 400 with expected next status | Handled |
| Retried idempotent operation | `referenceKey` unique constraint | 409 (treat as "already applied") | Handled |
| Concurrent `orderNumber` collision | timestamp+random suffix + `@unique` | Astronomically unlikely; caught as 409 if it ever occurs | Handled |

---

## 2. Authentication & Authorization Failures

| Failure | Detection | Behavior | Severity |
|---|---|---|---|
| No Bearer header | `authenticate` | 401 "Authentication token required." | Handled |
| Expired token | `jwt.TokenExpiredError` | 401 "Token expired." → frontend clears + redirects | Handled |
| Tampered/malformed token | `jwt.verify` throw | 401 "Invalid token." | Handled |
| Wrong role | `authorize(...roles)` | 403 "Access denied. Required role: X or Y." | Handled |
| Inactive user login | `!user.isActive` | 401 (same message as wrong password) | Handled |
| Production insecure JWT secret | startup guard | `process.exit(1)` — server never starts | Fail-closed |
| Stolen token used within 8h | — | Accepted (no revocation list) | Known gap |

---

## 3. Infrastructure Failures

| Failure | Detection | Behavior | Severity |
|---|---|---|---|
| RDS unreachable at request time | Prisma query throws → 500 envelope | User sees 500; logged with stack | Degraded |
| RDS unreachable at startup | `prisma.$connect()` fails | `process.exit(1)` — task exits, ECS restarts it | Recoverable via restart |
| RDS unreachable at health check | `/health` catches `SELECT 1` | 503 `{ status: 'degraded', database: { status: 'unreachable' } }` → ALB marks target unhealthy | Self-healing (traffic stops to bad task) |
| Backend task crash | ECS restarts (service ensures desired_count) | Brief 5xx from ALB until new task is healthy | Recoverable |
| Single-AZ RDS failure | No standby (`backup_retention=0`, no Multi-AZ) | Outage until manual restore | High — known gap |
| NAT Gateway failure | Private tasks can't pull images / reach SSM | New task starts fail; running tasks unaffected until redeploy | Medium |
| ALB 5xx spike | CloudWatch alarm `alb_5xx > 10/min` | Alarm only (no auto-remediation) | Detect-only |
| RDS CPU sustained high | CloudWatch alarm `rds_cpu > 80%` | Alarm only | Detect-only |

---

## 4. Data & Input Failures

| Failure | Detection | Behavior | Severity |
|---|---|---|---|
| Duplicate unique insert (item/location/batch, SKU, email, orderNumber) | Prisma `P2002` → 409 | "A record with this value already exists." + field | Handled |
| Update/delete on missing record | Prisma `P2025` → 404 | "Record not found." | Handled |
| Validation failure (any rule) | express-validator → `validate` | 422 with `errors` array | Handled |
| Body > 1MB | `express.json({ limit: '1mb' })` | 413 Payload Too Large | Handled |
| Referenced item/location/user missing | explicit `findUnique` check | 404 specific message | Handled |
| Malformed JSON body | Express body parser | 400 | Handled |

---

## 5. Application Lifecycle Failures

| Failure | Detection | Behavior | Severity |
|---|---|---|---|
| Unhandled async throw | `express-async-errors` patches Router | Routes to `errorHandler` → 500 envelope | Bounded (logged, no stack to client) |
| SIGTERM (ECS stop) | `process.on('SIGTERM')` | Graceful: `server.close()` then `prisma.$disconnect()` then exit 0 | Clean shutdown |
| Container OOM (512 MB) | Fargate kills task | ECS restarts the task | Recoverable |
| Prisma connection pool exhaustion | Only risk in dev hot-reload | Singleton via `globalThis` prevents new pools per reload | Prevented in dev |
| Prisma migration fails at startup | `prisma migrate deploy` in CMD | Container exit → ECS restart loop | Detect-only (check CloudWatch) |

---

## 6. Business-Logic Edge Cases

| Edge case | Behavior |
|---|---|
| Partial transfer receipt | Not supported — receipt is all-or-nothing of `quantity`. Known limitation. |
| Cancel a DISPATCHED transfer | Rejected (400) — cancellation only from REQUESTED; no stock reversal is implemented. |
| Cancel a CONFIRMED order | Releases the reservation (decrements `reservedQty`). |
| Reserve against a batch with `reservedQty = physicalQty` (available 0) | 422 with `available: 0`. |
| Work order's item removed | `itemId` reference remains; display uses the frozen `itemName`/`itemSku` snapshot. |
| Destination has no inventory row before receipt | Receipt creates one (DEFAULT batch) with `physicalQty += quantity`. |

---

## 7. The Honest Summary

The system is **correctness-first on the hot path** (reservation, dispatch, receipt, adjust) — every concurrency and invariant failure there is handled or prevented by design. Outside that path it is **detect-only or known-gap**: single-AZ RDS, no rate limiting, no HTTPS, no token revocation, single task per service, and alarms without auto-remediation. The case study prioritises "the numbers are always right" over "the system never goes down," which is the right trade-off for a data-integrity operations tool.


---

**Read next:** [12 — Observability →](12-Observability.md)

[← Back to documentation index](README.md)
