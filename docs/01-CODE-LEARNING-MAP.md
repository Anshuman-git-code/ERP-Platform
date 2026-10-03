# Code Learning Map — Mini Operations ERP

## A. Complete Repository Tree

```
CASE-STUDY-2/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma          ← THE database schema — single source of truth
│   │   ├── seed.ts                ← Development seed data
│   │   └── migrations/            ← Auto-generated SQL migration history
│   ├── src/
│   │   ├── index.ts               ← Process entry point — starts the server
│   │   ├── app.ts                 ← Express app factory — middleware + routes
│   │   ├── lib/
│   │   │   ├── prisma.ts          ← Singleton Prisma client
│   │   │   └── logger.ts          ← Winston structured logger
│   │   ├── types/
│   │   │   └── index.ts           ← TypeScript interfaces shared across backend
│   │   ├── middleware/
│   │   │   ├── auth.ts            ← authenticate() + authorize() — THE security layer
│   │   │   ├── errorHandler.ts    ← AppError class + global error handler
│   │   │   └── validate.ts        ← express-validator result consumer
│   │   ├── routes/
│   │   │   ├── auth.ts            ← POST /login  GET /me
│   │   │   ├── locations.ts       ← Warehouse/location CRUD
│   │   │   ├── items.ts           ← Item catalogue CRUD
│   │   │   ├── inventory.ts       ← Inventory records + adjust (transactional)
│   │   │   ├── workOrders.ts      ← Work order CRUD + shortage calculation
│   │   │   ├── transfers.ts       ← Transfer lifecycle (dispatch/receive) — CRITICAL
│   │   │   ├── orders.ts          ← Order reservation — MOST CRITICAL (SELECT FOR UPDATE)
│   │   │   └── dashboard.ts       ← Aggregate statistics
│   │   └── __tests__/
│   │       ├── setup.ts           ← Test env overrides (test DB, JWT secret)
│   │       ├── auth.test.ts       ← 11 login/token tests
│   │       ├── rbac.test.ts       ← 18 role-boundary tests (Mandatory Test 5)
│   │       ├── transfers.test.ts  ← 13 transfer tests (Mandatory Tests 2, 3, 4)
│   │       ├── orders.test.ts     ← 14 reservation tests (Mandatory Test 1 + concurrency)
│   │       └── inventory.test.ts  ← 18 inventory/idempotency tests
│   ├── Dockerfile                 ← Multi-stage build (builder → runner, non-root)
│   ├── package.json
│   ├── tsconfig.json
│   └── jest.config.ts
│
├── frontend/
│   ├── src/
│   │   ├── main.tsx               ← React DOM entry point
│   │   ├── App.tsx                ← BrowserRouter + AuthProvider + all Routes
│   │   ├── index.css              ← Tailwind directives + component classes
│   │   ├── vite-env.d.ts          ← VITE_* env var type declarations
│   │   ├── api/
│   │   │   ├── client.ts          ← Axios instance with JWT interceptors — THE API bridge
│   │   │   ├── auth.ts            ← authApi.login(), authApi.me()
│   │   │   ├── inventory.ts       ← inventoryApi.*
│   │   │   ├── items.ts           ← itemsApi.*
│   │   │   ├── locations.ts       ← locationsApi.*
│   │   │   ├── workOrders.ts      ← workOrdersApi.*
│   │   │   ├── transfers.ts       ← transfersApi.*
│   │   │   ├── orders.ts          ← ordersApi.*
│   │   │   └── dashboard.ts       ← dashboardApi.*
│   │   ├── contexts/
│   │   │   └── AuthContext.tsx    ← Global auth state: user, token, login(), logout()
│   │   ├── components/
│   │   │   ├── Layout.tsx         ← Sidebar nav (role-filtered) + main area wrapper
│   │   │   └── ProtectedRoute.tsx ← Route guard: redirect if no user, deny if wrong role
│   │   ├── pages/
│   │   │   ├── Login.tsx          ← Screen 1: email/password form
│   │   │   ├── Inventory.tsx      ← Screen 2: physicalQty/reservedQty/availableQty table
│   │   │   ├── WorkOrders.tsx     ← Screen 3: WO list with shortage badges
│   │   │   ├── Transfers.tsx      ← Screen 4: transfer lifecycle dispatch/receive UI
│   │   │   └── Orders.tsx         ← Screen 5: reservation with live availableQty
│   │   └── types/
│   │       └── index.ts           ← Frontend TypeScript types mirroring backend models
│   ├── Dockerfile                 ← Multi-stage Vite build → nginx:1.27-alpine
│   ├── nginx.conf                 ← nginx: proxy /api/* to backend, SPA fallback
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts             ← Vite dev server config (port 3000, /api proxy)
│
├── infra/
│   └── terraform/                 ← AWS infrastructure as code
│       ├── provider.tf            ← AWS provider config
│       ├── variables.tf           ← Input variables with defaults
│       ├── networking.tf          ← VPC, subnets, NAT, route tables, security groups
│       ├── compute.tf             ← ECR, ECS cluster, ALB, task defs, ECS services
│       ├── database.tf            ← RDS PostgreSQL 15
│       ├── iam.tf                 ← Roles for ECS + least-privilege CI deploy user
│       ├── main.tf                ← SSM SecureString parameters
│       ├── monitoring.tf          ← CloudWatch log group + alarms
│       ├── outputs.tf             ← ALB DNS, ECR URLs, ECS names
│       └── terraform.tfvars.example
│
├── .ci/
│   └── update-task-def.py        ← CI helper: update ECS task def image URI
├── assets/                        ← Live screenshots + architecture diagram
├── docs/                          ← Architecture, API, decisions, learning docs
├── docker-compose.yml             ← Local multi-container stack
├── .gitlab-ci.yml                 ← 5-stage CI/CD pipeline
└── .gitignore
```

---

## B. Purpose of Every Important Directory

| Directory | What lives here | Why it exists |
|---|---|---|
| `backend/src/routes/` | One file per API domain | Keeps each business area isolated; easy to find any endpoint |
| `backend/src/middleware/` | Reusable request/response processors | auth and validation run on every request; centralizing them means no duplication |
| `backend/src/lib/` | Singleton services (Prisma, logger) | One Prisma client per process prevents connection pool exhaustion |
| `backend/src/types/` | Shared TypeScript interfaces | `AuthenticatedRequest` extends `Request` so `req.user` is typed throughout |
| `backend/src/__tests__/` | Integration tests (Jest + Supertest) | Tests run against a real PostgreSQL test database — no mocking |
| `frontend/src/api/` | One module per backend domain | Centralizes all HTTP calls; if a URL changes, only one file changes |
| `frontend/src/contexts/` | React global state | Auth state must be available everywhere without prop-drilling |
| `frontend/src/pages/` | Full screen components | Each page maps to one browser URL route |
| `infra/terraform/` | AWS infrastructure code | Everything is version-controlled and reproducible |

---

## C. Purpose of Every Important File

| File | One-sentence purpose |
|---|---|
| `backend/prisma/schema.prisma` | Defines ALL database tables, columns, types, constraints, relations, indexes — the single source of truth for the data model |
| `backend/src/index.ts` | Process entry point — validates environment, connects to DB, starts HTTP server, handles graceful shutdown |
| `backend/src/app.ts` | Registers middleware and all route modules on the Express app; does NOT start the server |
| `backend/src/lib/prisma.ts` | Exports one PrismaClient instance shared by all route files |
| `backend/src/middleware/auth.ts` | `authenticate()` verifies the JWT; `authorize(...roles)` enforces role-based access |
| `backend/src/middleware/errorHandler.ts` | `AppError` class for throwing structured errors; `errorHandler` catches everything that reaches it |
| `backend/src/middleware/validate.ts` | Reads express-validator results and returns 422 if invalid |
| `backend/src/routes/orders.ts` | MOST CRITICAL file — contains the SELECT FOR UPDATE reservation transaction |
| `backend/src/routes/transfers.ts` | SECOND MOST CRITICAL — dispatch (source decrement) and receive (dest increment + double-receipt guard) |
| `frontend/src/api/client.ts` | Axios instance that automatically attaches JWT to every request and redirects to /login on 401 |
| `frontend/src/contexts/AuthContext.tsx` | Stores user + token in state and localStorage; provides `login()` and `logout()` to the whole app |
| `frontend/src/components/ProtectedRoute.tsx` | Wrapper that redirects unauthenticated users and renders "Access Denied" for wrong roles |

---

## D. Dependency Relationships

```
index.ts
  └── app.ts                     (imports and configures Express)
       ├── lib/prisma.ts          (imported by all route files)
       ├── lib/logger.ts          (imported by app.ts, index.ts, errorHandler.ts)
       ├── middleware/auth.ts     (imported by all route files)
       │    └── middleware/errorHandler.ts (AppError used by auth.ts)
       ├── middleware/errorHandler.ts (used by all route files via throw)
       ├── middleware/validate.ts (used by all route files)
       └── routes/*.ts            (each imports prisma, auth, validate, errorHandler)
            └── prisma/schema.prisma  (defines the types Prisma client exposes)

frontend/src/main.tsx
  └── App.tsx                    (BrowserRouter + AuthProvider + Routes)
       ├── contexts/AuthContext.tsx  (provides user state to whole app)
       │    └── api/auth.ts          (calls /api/auth/login)
       │         └── api/client.ts   (Axios + interceptors)
       ├── components/ProtectedRoute.tsx  (uses useAuth from AuthContext)
       │    └── components/Layout.tsx
       └── pages/*.tsx            (each uses api/* modules and useAuth)
            └── api/client.ts     (shared Axios instance)
```

---

## E. Recommended Reading Order

This is the order I recommend for learning. Each step builds on the previous:

```
FOUNDATION (understand the data first)
  1. backend/prisma/schema.prisma       — what exists in the database
  2. backend/src/types/index.ts         — how the backend represents requests/responses

BACKEND STARTUP (understand how the server comes alive)
  3. backend/src/lib/prisma.ts          — the database connection
  4. backend/src/lib/logger.ts          — logging
  5. backend/src/index.ts               — process startup, DB connect, server listen
  6. backend/src/app.ts                 — middleware stack + route registration

SECURITY LAYER (understand auth before routes)
  7. backend/src/middleware/auth.ts         — authenticate + authorize
  8. backend/src/middleware/validate.ts     — input validation
  9. backend/src/middleware/errorHandler.ts — error handling

SIMPLE ROUTES (read/write without transactions)
  10. backend/src/routes/auth.ts        — login, JWT creation
  11. backend/src/routes/locations.ts   — simplest CRUD
  12. backend/src/routes/items.ts       — pagination + search
  13. backend/src/routes/dashboard.ts   — aggregate queries
  14. backend/src/routes/workOrders.ts  — shortage calculation

CRITICAL BUSINESS LOGIC (transactions + locking)
  15. backend/src/routes/inventory.ts   — adjust with SELECT FOR UPDATE
  16. backend/src/routes/transfers.ts   — dispatch + receive transactions
  17. backend/src/routes/orders.ts      — concurrent reservation (MOST IMPORTANT)

FRONTEND (follow data back to the screen)
  18. frontend/src/api/client.ts        — Axios + JWT interceptors
  19. frontend/src/contexts/AuthContext.tsx  — auth state management
  20. frontend/src/App.tsx              — routing
  21. frontend/src/components/ProtectedRoute.tsx + Layout.tsx
  22. frontend/src/pages/Login.tsx
  23. frontend/src/pages/Inventory.tsx
  24. frontend/src/pages/WorkOrders.tsx
  25. frontend/src/pages/Transfers.tsx
  26. frontend/src/pages/Orders.tsx

TESTS (verify what you just learned)
  27. backend/src/__tests__/setup.ts
  28. backend/src/__tests__/auth.test.ts
  29. backend/src/__tests__/rbac.test.ts
  30. backend/src/__tests__/transfers.test.ts
  31. backend/src/__tests__/orders.test.ts
  32. backend/src/__tests__/inventory.test.ts
```

---

## F. Business-Flow Mapping

```
FLOW 1 — Stock Reservation (most important)
  User (SALES) → Customer Orders page
    → ordersApi.create()          [POST /api/orders]
    → ordersApi.confirm()         [PATCH /api/orders/:id/confirm]
       → routes/orders.ts
          → authenticate() + authorize(ADMIN, SALES)
          → prisma.$transaction()
             → SELECT ... FOR UPDATE  ← row lock
             → check availableQty
             → UPDATE reservedQty += quantity
          → Response: order CONFIRMED
    → Orders page re-fetches and shows CONFIRMED badge

FLOW 2 — Transfer Dispatch → Receipt
  User (OPS) → Transfers page
    → transfersApi.dispatch()     [PATCH /api/transfers/:id/dispatch]
       → routes/transfers.ts
          → prisma.$transaction()
             → SELECT ... FOR UPDATE on source inventory
             → check availableQty
             → UPDATE physicalQty -= quantity  (source only)
          → Response: DISPATCHED (dest unchanged)
    → transfersApi.receive()      [PATCH /api/transfers/:id/receive]
       → routes/transfers.ts
          → prisma.$transaction()
             → SELECT ... FOR UPDATE on stock_transfers row
             → check status === DISPATCHED (double-receipt guard)
             → UPSERT dest inventory
             → UPDATE physicalQty += quantity  (dest only)
          → Response: RECEIVED

FLOW 3 — Work Order Shortage
  User (ADMIN) → Work Orders page
    → workOrdersApi.list()        [GET /api/work-orders]
       → routes/workOrders.ts
          → getInventoryAvailability(itemId, locationId)
          → shortageQty = max(requiredQty - availableQty, 0)
          → Response includes shortageQty computed fresh each time
```

---

## G. API-to-Code Mapping

| Frontend call | Backend route | Key function | DB model |
|---|---|---|---|
| `authApi.login()` | `POST /api/auth/login` | `bcrypt.compare` + `jwt.sign` | `users` |
| `inventoryApi.list()` | `GET /api/inventory` | `prisma.inventory.findMany` | `inventory` |
| `inventoryApi.adjust()` | `PATCH /api/inventory/:id/adjust` | `SELECT FOR UPDATE` + `UPDATE physicalQty` | `inventory`, `inventory_transactions` |
| `workOrdersApi.list()` | `GET /api/work-orders` | `getInventoryAvailability()` | `work_orders`, `inventory` |
| `transfersApi.dispatch()` | `PATCH /api/transfers/:id/dispatch` | `SELECT FOR UPDATE` on source | `inventory`, `stock_transfers`, `inventory_transactions` |
| `transfersApi.receive()` | `PATCH /api/transfers/:id/receive` | `SELECT FOR UPDATE` on transfer row | `inventory`, `stock_transfers`, `inventory_transactions` |
| `ordersApi.confirm()` | `PATCH /api/orders/:id/confirm` | `SELECT FOR UPDATE ORDER BY id` | `inventory`, `customer_orders`, `order_items` |

---

## H. Critical-Business-Rule Mapping

| Rule | Where enforced | How |
|---|---|---|
| Cannot reserve > available | `routes/orders.ts` PATCH confirm | `SELECT FOR UPDATE` + `available < requested → throw 422` |
| Cannot transfer > available | `routes/transfers.ts` PATCH dispatch | `SELECT FOR UPDATE` + `totalAvailable < quantity → throw 422` |
| Dest stock only after receipt | `routes/transfers.ts` PATCH dispatch | Transaction only touches `sourceLocation` inventory, never dest |
| No double receipt | `routes/transfers.ts` PATCH receive | `SELECT FOR UPDATE` on transfer row + `status !== DISPATCHED → throw 400` |
| Unauthorized user blocked | `middleware/auth.ts` `authorize()` | Checks `req.user.role` against allowed roles; throws `AppError(403)` |
