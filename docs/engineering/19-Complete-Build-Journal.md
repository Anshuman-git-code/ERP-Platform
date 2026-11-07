# 19 — Complete Build Journal

> The story of how the system was built, phase by phase, in the order it actually happened. Each phase produced a working increment before the next began — building all systems at once would have meant debugging ten integrated layers when one broke.

---

## How to Read This

Each phase records: the design context (what was decided before code), what was created, the key commands, and the milestone (what the system could do at the end). Phases are ordered by dependency, simplest first.

---

## Phase 0: Decisions Before Code

Before any file was written, the shape was fixed:

1. **Reuse the Express + Prisma + PostgreSQL stack** (not NestJS + TypeORM) — spend novelty on the problem, not the framework.
2. **The hot path is concurrency** — design the data access around `SELECT FOR UPDATE` from the start.
3. **`availableQty` and `shortageQty` are derived**, never stored.
4. **State machines are forward functions**, not accepted-pair sets.
5. **Build in vertical slices**, simplest to most complex, so a break is always in the newest layer.

---

## Phase 1: Project Scaffolding

Created the repo, `.gitignore` (before any code so secrets/build outputs never commit), and the backend `package.json`. Installed all dependencies in two commands: runtime (`express`, `@prisma/client`, `prisma`, `bcryptjs`, `cors`, `dotenv`, `express-async-errors`, `express-validator`, `jsonwebtoken`, `morgan`, `winston`) and dev (`typescript`, `ts-node`, `ts-node-dev`, `jest`, `ts-jest`, `supertest`, type packages, eslint). Created `tsconfig.json`, `.eslintrc.json`, `.prettierrc`, `.env.example`, `jest.config.ts`.

**Milestone:** a backend folder that compiles nothing yet but is correctly configured.

---

## Phase 2: Database Schema (before any route)

`npx prisma init` created the blank `schema.prisma`. The entire schema was written first — every route later imports types that Prisma generates from it. The key decisions baked in: `batchNumber @default("DEFAULT")`, `@@unique([itemId, locationId, batchNumber])`, `InventoryTransaction.referenceKey String? @unique`, snapshot fields on work orders/transfers/order items.

```bash
npx prisma migrate dev --name init_ops_erp   # writes + applies the migration, runs prisma generate
npm run db:seed                              # 3 users, 3 locations, 5 items, inventory, 1 work order
```

**Milestone:** a populated database with the full data model; generated TypeScript types available to import.

---

## Phase 3: Shared Infrastructure (no business logic)

Three files before any route, in dependency order:

- `src/lib/logger.ts` — Winston, zero deps; everything imports it.
- `src/lib/prisma.ts` — singleton client via `globalThis` (survives `ts-node-dev` hot-reloads).
- `src/types/index.ts` — `AuthenticatedRequest`, `JwtPayload`, `PaginatedResponse<T>`, `PaginationQuery`.

**Milestone:** the imports every route will need, ready.

---

## Phase 4: Middleware

In dependency order:

- `src/middleware/errorHandler.ts` — defines `AppError` and the global handler (P2002→409, P2025→404, else 500). `auth.ts` imports `AppError`, so this came first.
- `src/middleware/auth.ts` — `authenticate` (verify JWT, set `req.user`) + `authorize(...roles)` (higher-order).
- `src/middleware/validate.ts` — reads express-validator results → 422.

**Milestone:** the cross-cutting concerns every route uses.

---

## Phase 5: Routes (simplest → most complex)

Built in this order so each layer was verified before the harder one:

1. `auth.ts` — validates the JWT system end-to-end (login + `/me`).
2. `locations.ts` — simplest CRUD; establishes the route template (`router.use(authenticate)`, `authorize`, validation chain, `validate`, handler).
3. `items.ts` — adds search and a partial `PUT`.
4. `dashboard.ts` — read-only aggregates (no writes, no locks).
5. `inventory.ts` — the first route with a transaction and `FOR UPDATE` (the adjust path). This was where the locking pattern was established.
6. `workOrders.ts` — the state-machine pattern (`transitions` map) and live shortage computation.
7. `transfers.ts` — the three-state lifecycle + the two critical transactions (dispatch FIFO deduction with row locks; receive with transfer-row lock for double-receipt guard).
8. `orders.ts` — the concurrency-critical reservation (id-ordered `FOR UPDATE`, availability check, atomic increment). The hardest path, built last when everything it depends on was verified.

**Milestone:** a complete, working backend API with all business rules enforced.

---

## Phase 6: Application Wiring

- `src/app.ts` — imports `express-async-errors` first, wires global middleware (trust proxy, CORS, morgan, JSON body limit), mounts the 8 route modules under `/api`, adds `/health`, the 404 catch-all, and `errorHandler` last.
- `src/index.ts` — the process entry: `dotenv/config` first, the production JWT-secret guard, `prisma.$connect()`, `app.listen`, and graceful shutdown on SIGTERM/SIGINT. Separated from `app.ts` so tests import `app` without starting a server.

**Milestone:** a runnable backend (`npm run dev`).

---

## Phase 7: Tests

- `src/__tests__/setup.ts` — written first; overrides `DATABASE_URL` to a test DB, sets a deterministic `JWT_SECRET`, `NODE_ENV=test`, `LOG_LEVEL=error`.
- Five suites: `auth.test.ts` (11), `rbac.test.ts` (18), `inventory.test.ts` (18), `transfers.test.ts` (13), `orders.test.ts` (14) — 74 total.
- The concurrency test (`orders.test.ts`) fires two `confirm`s with `Promise.all` and asserts exactly one 200 + one 422 and `reservedQty === 8` (not 16).

```bash
npm test          # jest --runInBand --forceExit; 74/74 pass
```

**Milestone:** all five mandatory scenarios verified by execution, including the concurrency invariant.

---

## Phase 8: Frontend

```bash
npm create vite@latest . -- --template react-ts
npm install axios react-router-dom tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

Built in order: `types/index.ts` (interfaces mirroring backend responses) → `api/client.ts` (axios instance, token injection, 401 redirect) → `api/*.ts` (one wrapper per feature) → `contexts/AuthContext.tsx` → `components/ProtectedRoute.tsx` + `Layout.tsx` → `pages/Login.tsx` → `pages/{Inventory,WorkOrders,Transfers,Orders}.tsx` → `App.tsx` (routes with `React.lazy` + `Suspense`).

**Milestone:** five role-aware screens wired to the API; the SPA navigates and gates by role.

---

## Phase 9: Containerisation

- `backend/Dockerfile` — multi-stage: builder (tsc + prisma generate) → runner (prod deps + prisma + dist, non-root `appuser`, `CMD prisma migrate deploy && node dist/index.js`).
- `frontend/Dockerfile` — multi-stage: Vite build (`VITE_API_BASE_URL=/api` baked in) → `nginx:1.27-alpine` serving `dist`; `nginx.conf` placed as a template for `envsubst` of `${BACKEND_URL}`.
- `docker-compose.yml` — postgres:15-alpine (host 5444), backend (host 4002), frontend nginx (host 3002), with healthchecks and `depends_on: service_healthy`.
- `frontend/nginx.conf` — security headers, `/api/*` and `/health` proxy to `${BACKEND_URL}`, static asset caching, SPA fallback.

```bash
docker compose up --build      # full stack up, seeded, healthy
```

**Milestone:** one command brings up the whole system locally, identical images to production.

---

## Phase 10: Infrastructure (Terraform)

Written in dependency order: `provider.tf` → `variables.tf` → `networking.tf` → `database.tf` → `iam.tf` → `main.tf` (SSM) → `compute.tf` → `monitoring.tf` → `outputs.tf`.

```bash
cd infra/terraform
terraform init && terraform plan && terraform apply
terraform output alb_dns_name     # set as CORS_ORIGIN
```

After images were pushed to ECR, set `backend_image`/`frontend_image` and `cors_origin` in tfvars and applied again.

**Milestone:** a full AWS footprint (VPC, ALB, ECS Fargate, RDS, SSM, ECR, CloudWatch) reproducible from code.

---

## Phase 11: CI/CD

The GitLab CI pipeline is designed as 5 stages — `validate` (lint + typecheck) → `test` (74 tests against a Postgres service container) → `build` → `package` (Docker images to registry) → `deploy` (ECR push + `ecs UpdateService`, manual gate on `main`). The CI variables (ECR registry/repos, ECS cluster/services, AWS keys) are set in GitLab → Settings → CI/CD → Variables (masked + protected).

> **Note:** the pipeline is described in `docs/DEPLOYMENT.md`, `docs/E2E_VERIFICATION.md`, and `README.md`. The `.gitlab-ci.yml` file itself was not present in the working copy at the time these documents were written; the pipeline is documented as designed and should be added/verified against a real runner as the first CI/CD improvement.

**Milestone:** a defined path from `main` merge to a running ECS deployment.

---

## Phase 12: Deploy & Verify

- Pushed images to ECR; Terraform applied the image URIs; ECS rolled the new tasks.
- Verified `/health` returns `{ status: 'ok', database: { status: 'ok' } }` against the live ALB.
- Smoke-tested login for all three roles, all read endpoints, the 401/403 boundaries, `availableQty` across inventory rows, and `shortageQty` on work orders.
- Typecheck passed on both backend and frontend (`tsc --noEmit`).

**Milestone:** a live, healthy deployment serving the five screens, with the concurrency invariants holding under the test suite.

---

## The Phase That Mattered Most

Phase 5, route 5 (`inventory.ts`) — the first `FOR UPDATE`. That was the moment the locking pattern was established: lock the row, check the invariant, mutate inside the transaction, commit. Every later route (`transfers`, `orders`) reused the same pattern with the same `ORDER BY id` discipline. Getting the pattern right once, on the simplest mutating path, made the hardest path (concurrent reservation) a matter of applying the same recipe — not inventing a new one under pressure.


---

**Read next:** [20 — Complete Request Flow →](20-Complete-Request-Flow.md)

[← Back to documentation index](README.md)
