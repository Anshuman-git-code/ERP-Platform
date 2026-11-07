# 17 — System Design Overview

> A condensed walkthrough for a reader in a hurry. Read this first, then dive into the numbered documents for depth.

---

## What It Is

Mini Operations ERP is a production-oriented Operations ERP for a manufacturing/warehouse operation. It manages the flow:

> **Inventory → Work Order → Stock Check → Internal Transfer / Shortage → Customer Reservation**

Three roles use it — ADMIN, OPERATIONS, SALES — and every action is role-restricted at the backend.

## The One Big Idea

The defining engineering problem is **concurrent stock reservation**: two sales people confirming orders against the same shelf must not collectively over-promise it. The solution is `SELECT ... FOR UPDATE` inside a Prisma transaction, with rows locked in ascending `id` order to prevent deadlocks. Everything else in the system is straightforward CRUD around that one safe path.

```
Confirm order A (8)  ─┐
                      ├─ both lock the same inventory row (ORDER BY id FOR UPDATE)
Confirm order B (8)  ─┘   only 10 available → first wins, second gets 422 with insufficientItems
```

## The Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Vite + Tailwind + React Router v6 (nginx-served) |
| Backend | Node 20 + Express 4 + TypeScript |
| ORM | Prisma 5 (schema-first) |
| Database | PostgreSQL 15 (RDS) |
| Auth | JWT (jsonwebtoken) + bcryptjs |
| Validation | express-validator |
| Logging | Winston |
| Testing | Jest + ts-jest + Supertest (74 integration tests) |
| Containers | Docker + Docker Compose |
| CI/CD | GitLab CI (5 stages) |
| IaC | Terraform (VPC, ALB, ECS Fargate, RDS, SSM, ECR, CloudWatch) |

## The Architecture

```
                Internet
                   │
                   ▼
         ALB (HTTP:80, ap-south-1)
            /api/*,/health ─▶ backend (ECS Fargate, Express :4000)
            /*            ─▶ frontend (ECS Fargate, nginx :80)
                                   │
                                   ▼
                        RDS PostgreSQL 15 (private)
            secrets ← SSM SecureString (DATABASE_URL, JWT_SECRET)
            images  ← ECR (backend, frontend)
```

The backend is a flat Express app: `authenticate` → `authorize(...roles)` → `validate` → route handler → Prisma. Eight route modules under `/api`. A global error handler maps `AppError`, Prisma `P2002`/`P2025`, and unexpected errors to a stable JSON envelope.

## The Data Model

Nine tables (`users`, `locations`, `items`, `inventory`, `inventory_transactions`, `work_orders`, `stock_transfers`, `customer_orders`, `order_items`) and five enums. Two derived values — `availableQty` and `shortageQty` — are computed on read, never stored. Three state machines (work order, transfer, order) are enforced in code. An audit `InventoryTransaction` is written for every stock movement, with an idempotency `referenceKey`.

## The Three Deployment Shapes

- **Local dev:** Vite (:3000) proxies to Express (:4000) → Postgres (:5432)
- **Docker Compose:** nginx (:3002) → Express (:4000) → Postgres (:5432); host ports 3002/4002/5444
- **AWS prod:** ALB → ECS Fargate (frontend + backend) → RDS; SSM secrets; ECR images

The same Docker images run in Compose and ECS, so there is one deployment artifact.

## Status

- **Live** in ap-south-1 (commit `989f045`), healthy, 74/74 backend tests passing.
- **Correctness on the hot path** is production-grade (reservation, dispatch, receipt, adjust).
- **Operational gaps** are documented and prioritised: no HTTPS, no rate limiting, single-AZ RDS without backups, one task per service, local Terraform state, no JWT refresh, no frontend tests. None of these affect the data-integrity invariants.

## Where to Go Next

- For the concurrency design in full: [10 — Transaction & Concurrency Workflow](10-Transaction-Concurrency-Workflow.md)
- For the data model: [06 — Data Modeling](06-Data-Modeling.md)
- For the infrastructure: [08 — Infrastructure as Code](08-Infrastructure-as-Code.md)
- For the gaps and the roadmap: [13 — Production Improvements](13-Production-Improvements.md)


---

**Read next:** [18 — Requirements to Architecture →](18-Requirements-to-Architecture.md)

[← Back to documentation index](README.md)
