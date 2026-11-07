# 13 — Production Improvements

> The system is correct on its hot path but is a case-study deployment. This is the ordered roadmap from "works as a case study" to "runs as production," grouped by the risk it removes.

---

## 1. Security (do first)

| Improvement | Why | Effort |
|---|---|---|
| Enable HTTPS at the ALB (ACM cert + 443 listener + HTTP→HTTPS redirect) | Today the JWT travels in cleartext. This is the single highest-impact fix. | Low — Terraform only |
| Add rate limiting (`express-rate-limit`) at the app or a WAF at the ALB | Brute-force login and API abuse are unthrottled | Low |
| JWT refresh-token flow + HttpOnly cookie storage | Removes forced re-login and the `localStorage` XSS-exfiltration risk | Medium |
| Short-lived deploy keys + rotation policy for the `ci_deploy` IAM user | Long-lived keys are the CI risk | Low |
| Token revocation (denylist) | A stolen token is valid for up to 8h today | Medium |
| Separate `DATABASE_URL` password into its own rotated SSM parameter | Rotation today means rewriting the whole connection string | Low |

## 2. Availability & Resilience

| Improvement | Why | Effort |
|---|---|---|
| Multi-AZ RDS standby | Single-AZ is a single point of failure; no automatic failover | Low (Terraform flag) |
| Automated RDS backups (`backup_retention_period > 0`, `skip_final_snapshot = false`) | Today there are no backups | Low |
| `desired_count = 2` + ALB deregistration delay | Zero-downtime rolling deploys; survives one task dying | Low |
| ECS service auto-scaling (average CPU) | Handles load spikes without manual resize | Low–Medium |
| Size RDS up from `db.t3.micro` for real load | Micro is a starting point | Low |
| Health-graceful degradation: keep serving reads if the DB is briefly slow | Today a DB hiccup is a hard 5xx | Medium |

## 3. Correctness Hardening

| Improvement | Why | Effort |
|---|---|---|
| Lock rows on CONFIRMED-order cancel before decrementing `reservedQty` | Today cancel is single-actor and unlocked; a stricter version removes the theoretical race | Low |
| Use a DB sequence for work-order/transfer numbers | Removes the `COUNT+1` race entirely (order numbers already use timestamp+random) | Low |
| Conditional update on confirm/cancel (`status` guard inside the UPDATE) | Defence in depth alongside the read-check | Low–Medium |
| Negative-quantity audit: reject OUT adjustments that would double-count a retried manual entry without a `referenceKey` | Manual one-offs are not idempotent by default | Low |

## 4. Missing Features (in-scope extensions)

| Improvement | Why | Effort |
|---|---|---|
| User-management UI + `/api/users` CRUD + signup (with role assignment approval) | Users are seed-only today | Medium |
| Partial transfer receipt (receive N of M) | Today receipt is all-or-nothing | Medium |
| Stock reversal on cancel of a DISPATCHED transfer (a "recall" flow) | Dispatched stock can't be un-moved today | Medium |
| `damagedQty` / damaged-stock tracking on `Inventory` | Damage is recorded only as an `OUT` transaction with a reason | Medium |
| Soft-delete / archive for items, locations, orders | Hard deletes risk referential integrity; archiving preserves history | Medium |
| Reports / export (CSV) of the audit log and reservations | The `InventoryTransaction` data exists but has no export | Low–Medium |

## 5. Testing & Quality

| Improvement | Why | Effort |
|---|---|---|
| Frontend tests (Vitest + React Testing Library) | Zero frontend tests today; backend is 74 tests | Medium |
| End-to-end tests against the compose stack | The 12 manual compose checks are not automated | Medium |
| Mutation/property tests for the concurrency invariants | Assert "reservedQty never exceeds physicalQty" over random sequences | Medium |
| Coverage gate in CI | `test:coverage` exists but is not enforced | Low |
| Load test the confirm path | Prove the locking holds under real contention | Medium |

## 6. Infrastructure Hygiene

| Improvement | Why | Effort |
|---|---|---|
| S3 + DynamoDB-lock Terraform remote state | Local state is not safe for team use | Low |
| Separate `prod` (and `staging`) Terraform workspaces with isolated state | One `dev` environment today | Low–Medium |
| ACM cert + HTTPS listener (overlaps with Security #1) | — | Low |
| Immutable ECR tags + always deploy by commit SHA | MUTABLE `:latest` can mask rollbacks | Low |
| Cost alarms | A misconfigured resource can spend unnoticed | Low |

## 7. CI/CD

| Improvement | Why | Effort |
|---|---|---|
| Add/verify the `.gitlab-ci.yml` in the repo and run the pipeline on a real runner | The pipeline is designed in docs but the file was not present in the working copy at writing time | Low–Medium |
| Automate the deploy stage (remove the manual gate) once staging exists | Manual gate is safe for dev; staging needs automation | Low |
| Add `terraform plan` to CI on PRs | Catches infra regressions before apply | Low |
| Add image-scan gating (fail pipeline on critical CVEs) | ECR scans but does not gate | Low |

---

## Prioritised Top 5

If only five things are done, in order:

1. **HTTPS at the ALB** (security, high impact, low effort)
2. **Multi-AZ RDS + automated backups** (availability, low effort)
3. **`desired_count = 2` + auto-scaling** (availability, low effort)
4. **Rate limiting** (security, low effort)
5. **S3 remote Terraform state** (team readiness, low effort)

These five move the system from "case-study correct" to "production-shaped" without touching the concurrency design, which is already production-grade.


---

**Read next:** [14 — Lessons Learned →](14-Lessons-Learned.md)

[← Back to documentation index](README.md)
