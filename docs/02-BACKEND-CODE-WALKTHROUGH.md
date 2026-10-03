# Backend Code Walkthrough

## Runtime Order: How the Backend Comes Alive

When you run `npm run dev`, the Node.js process starts at `src/index.ts`. Here is every step in the exact order it happens:

```
1. dotenv loads .env into process.env
2. JWT_SECRET guard — refuses production start with insecure secret
3. prisma.$connect() — verifies database is reachable
4. app.listen(4000) — begins accepting HTTP requests
5. SIGTERM/SIGINT handlers registered — for graceful shutdown
```

Only if ALL these steps succeed does traffic start flowing.

---

## File: `src/index.ts` — Process Entry Point

**Why this file exists:** It is the boundary between "starting the server" and "configuring the server." `app.ts` knows nothing about ports, environment variables, or startup guards. `index.ts` owns all of that.

**Line by line walkthrough:**

```typescript
import 'dotenv/config';
```
*This must be the very first import.* It reads `backend/.env` and sets all variables on `process.env`. If this line were second, any other import that reads `process.env.DATABASE_URL` would get `undefined`.

```typescript
const jwtSecret = process.env.JWT_SECRET ?? '';
if (process.env.NODE_ENV === 'production') {
  if (!jwtSecret || jwtSecret === 'dev_secret_change_in_production') {
    process.exit(1);
  }
}
```
Production security guard. If someone deploys with the fallback dev secret, the server refuses to start. This prevents a critical security vulnerability from reaching production silently.

```typescript
await prisma.$connect();
```
Explicitly verifies the database connection before the HTTP server starts. Without this, the server would start and then fail on every request with a DB error. This gives a clear startup failure rather than confusing runtime errors.

```typescript
const server = app.listen(PORT, () => { ... });
```
Only called after the DB is confirmed healthy. The callback runs when the TCP port is bound.

```typescript
process.on('SIGTERM', () => shutdown('SIGTERM'));
```
Docker sends `SIGTERM` before killing a container. This catches it, waits for in-flight requests to finish (`server.close()`), disconnects from the DB cleanly, then exits 0. Without this, mid-flight transactions could be cut off.

**Interview questions:**
- Q: Why does `dotenv` need to be the first import? A: Because other modules read `process.env` during their own initialization. If dotenv runs after them, those reads see `undefined`.
- Q: What happens if the JWT_SECRET is not set in production? A: The server calls `process.exit(1)` and refuses to start. This is intentional — a missing secret would make all JWTs unverifiable.
- Q: Why check DB connectivity before starting the server? A: So the health check immediately shows "degraded" instead of the service accepting traffic that all fails with DB errors.

---

## File: `src/app.ts` — Express Application Factory

**Why this file exists:** Separates the Express app configuration from the process lifecycle. This separation is what makes testing possible — tests import `app` directly without starting a real server.

**Block 1 — The critical first line:**
```typescript
import 'express-async-errors';
```
Express 4 does not catch errors thrown in async route handlers. Normally you'd need `try/catch` in every route and call `next(err)` manually. This package monkey-patches Express so any `throw` or rejected Promise in an async handler automatically calls `next(err)`, which flows to the central error handler. Without this, an unhandled async error would silently hang the request.

**Block 2 — Middleware registration order matters:**
```typescript
app.set('trust proxy', 1);          // Must come first — affects req.ip
app.use(cors(...));                  // Must come before routes
app.use(morgan(...));                // Logging — runs on every request
app.use(express.json({ limit: '1mb' }));  // Body parsing — must run before route handlers read req.body
```
Middleware runs in the order it's registered. If `express.json` came after a route, `req.body` would be `undefined` in that route.

**Block 3 — The health endpoint:**
```typescript
app.get('/health', async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  ...
});
```
This endpoint is special — it has NO `authenticate()` middleware. It must be publicly accessible because the ALB target group health checker, Docker health check, and monitoring tools call it without credentials. It runs a minimal `SELECT 1` to confirm the database is reachable and returns the DB latency in milliseconds.

**Block 4 — Route mounting:**
```typescript
app.use('/api/auth', authRoutes);
app.use('/api/inventory', inventoryRoutes);
...
```
Each route module is a mini Express Router. Mounting them here prefixes all routes inside with `/api/...`. For example, `router.post('/')` inside `inventory.ts` becomes `POST /api/inventory`.

**Block 5 — 404 catch-all:**
```typescript
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});
```
Must come AFTER all route registrations. If no route matched, this catches it. Returns JSON (not HTML) because API clients expect JSON.

**Block 6 — Central error handler:**
```typescript
app.use(errorHandler);
```
Must be the LAST middleware. Express identifies error-handling middleware by the 4-argument signature `(err, req, res, next)`. Any `throw` in a route handler, caught by `express-async-errors`, flows here.

**What the errorHandler does:**
1. If it's an `AppError` (our custom class) → uses `err.statusCode` and `err.message`
2. If it's a Prisma `P2002` error (unique constraint) → returns 409
3. If it's a Prisma `P2025` error (record not found) → returns 404
4. Anything else → logs the stack trace and returns 500

This means route handlers never need to handle DB errors directly. They just let Prisma throw and the error handler catches it.

---

## File: `src/lib/prisma.ts` — Singleton Prisma Client

**Why this file exists:** Creates exactly ONE PrismaClient instance for the entire process lifetime.

**The problem it solves:**
```typescript
// BAD — if done naively in every file:
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();  // Each import creates a new connection pool!
```
Creating a new PrismaClient opens a new database connection pool. If 8 route files each did this, you'd have 8 connection pools consuming your database's connection limit.

**The singleton pattern:**
```typescript
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ ... });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
```
`globalThis` persists across module re-evaluations during `ts-node-dev` hot-reloads. In development, when you save a file, ts-node-dev re-imports modules — but `globalThis.prisma` was already set, so the existing client is reused instead of a new one being created.

In production, hot-reload never happens, so we don't need to store it on `globalThis`.

**Interview question:** Q: Why store the Prisma client on `globalThis`? A: In development, module hot-reload would create a new PrismaClient on every save, eventually exhausting PostgreSQL's connection limit. Storing on `globalThis` ensures only one instance exists per process regardless of how many times modules are re-evaluated.

---

## File: `src/middleware/auth.ts` — Authentication + Authorization

**Why this file exists:** Every protected endpoint needs the same two things: (1) prove the caller has a valid JWT, (2) prove their role allows the operation. This file provides both as reusable middleware.

### `authenticate()` — Verifies identity

```typescript
export function authenticate(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError(401, 'Authentication token required.'));
  }

  const token = authHeader.slice(7);  // removes "Bearer "

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = { userId: payload.userId, email: payload.email, role: payload.role };
    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'Token expired.'));
    }
    return next(new AppError(401, 'Invalid token.'));
  }
}
```

Step by step:
1. Read the `Authorization` header
2. Verify it starts with `Bearer ` (the HTTP Bearer token scheme)
3. Extract the token after "Bearer "
4. `jwt.verify()` — cryptographically verifies the signature using `JWT_SECRET` AND checks the expiry. If the secret doesn't match or it's expired, it throws.
5. On success: attach the decoded payload to `req.user`. Every subsequent middleware and route handler can now read `req.user.userId`, `req.user.role`, etc.
6. Call `next()` to pass to the next middleware.

**Why `req.user` is typed as optional (`user?`):** TypeScript doesn't know if `authenticate` ran before a given handler. Using the `!` non-null assertion (`req.user!.userId`) explicitly tells TypeScript "I know authenticate ran first." In tests, this can be verified.

### `authorize(...roles)` — Checks permission

```typescript
export function authorize(...roles: Role[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError(401, 'Authentication required.'));
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError(403, `Access denied. Required role: ${roles.join(' or ')}.`));
    }
    return next();
  };
}
```

This is a **middleware factory** — it takes an array of allowed roles and returns a new middleware function. The roles are captured in the closure.

Usage in routes:
```typescript
router.post('/', authorize(Role.ADMIN), ...)           // ADMIN only
router.post('/', authorize(Role.ADMIN, Role.OPERATIONS), ...)  // ADMIN or OPS
```

**401 vs 403:**
- 401: "I don't know who you are" — no token or invalid token
- 403: "I know who you are, but you're not allowed" — valid token, wrong role

**Interview question:** Q: Why separate `authenticate` and `authorize`? Why not combine them?
A: Because they do different things. `authenticate` runs on every protected route and establishes identity. `authorize` runs only on routes with role restrictions and verifies permission. Many routes need auth but no specific role check. Keeping them separate means you can write `router.use(authenticate)` once at the top of a route file, then `authorize(...)` only on the specific routes that need it.

---

## File: `src/middleware/errorHandler.ts` — Error Handling

### `AppError` class

```typescript
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}
```

**Simple meaning:** A normal JavaScript Error with an HTTP status code attached.
**Why it exists:** Route handlers throw `throw new AppError(422, 'Insufficient stock', { items })` and the error handler catches it and sends the right HTTP response. Without this, you'd need `try/catch` + `res.status(422).json(...)` in every handler.

**The `details` field:** Optional extra data. Used for the insufficient stock error to return exactly which items are short:
```json
{
  "success": false,
  "message": "Insufficient available stock",
  "details": {
    "insufficientItems": [{ "itemName": "Steel Rod", "available": 5, "requested": 15 }]
  }
}
```

### `errorHandler` function

The four-argument signature `(err, req, res, next)` is how Express recognizes an error handler. It must have exactly 4 parameters — even if `next` is unused — because Express counts parameters to determine if it's an error handler.

Three cases handled:
1. `AppError` → use `err.statusCode` and `err.message`
2. Prisma `P2002` (unique constraint violated) → 409 Conflict
3. Prisma `P2025` (record not found) → 404 Not Found
4. Anything else → log full stack trace, return 500

**What would break if removed:** Every unhandled error would crash the response or hang. The 404 from `P2025` (which happens on every `findUnique` for non-existent records) would become a 500.

Great question. Let me trace this completely so you understand where `P2002` and `P2025` come from, what triggers them, and how they connect to the error handler.

## Start here: What are P2002 and P2025?

They are **Prisma error codes**. Not HTTP codes. Not our codes. They are codes that **Prisma itself assigns** when PostgreSQL refuses an operation.

Think of it as a chain:

```
PostgreSQL detects a problem
    ↓
PostgreSQL throws its own internal error
    ↓
Prisma catches it, wraps it in a PrismaClientKnownRequestError
Prisma adds a CODE to the error: "P2002" or "P2025"
    ↓
Prisma throws that error out of the query
    ↓
express-async-errors catches it (because route handlers are async)
    ↓
Express passes it to our errorHandler
    ↓
Our errorHandler reads err.code and decides what HTTP status to send
```

---

## P2002 — Unique Constraint Violation

### What PostgreSQL sees

Every unique field in your schema creates a rule in PostgreSQL:

```
Item.sku @unique  →  "No two rows in 'items' can have the same sku"
User.email @unique  →  "No two rows in 'users' can have the same email"
Inventory @@unique([itemId, locationId, batchNumber])  →  "No two rows can have the same item+location+batch combination"
```

These rules live **inside PostgreSQL**. They are enforced by the database, not by application code.

### What triggers it

```typescript
// Someone tries to create an Item with sku = "STEEL-ROD-10MM"
// but that SKU already exists in the database

await prisma.item.create({
  data: { name: 'Steel Rod', sku: 'STEEL-ROD-10MM', unitPrice: 250 }
});

// PostgreSQL says: "Nope — STEEL-ROD-10MM already exists in the sku column"
// PostgreSQL throws: ERROR 23505 unique violation
// Prisma catches it and re-throws:
//   PrismaClientKnownRequestError {
//     code: 'P2002',
//     meta: { target: ['sku'] }   ← which field violated
//   }
```

### How the error handler catches it

```typescript
if (err instanceof Prisma.PrismaClientKnownRequestError) {
  if (err.code === 'P2002') {
    return res.status(409).json({
      success: false,
      message: 'A record with this value already exists.',
      field: (err.meta as { target?: string[] })?.target,
      // field will be: ['sku'] — tells the caller which field was duplicate
    });
  }
}
```

The `err.code === 'P2002'` check is how we know this specific Prisma error is a uniqueness violation. We map it to **HTTP 409 Conflict** — which means "the request conflicts with the current state of the resource."

### Real example in this app

In `routes/inventory.ts`, when someone creates an inventory record:
```typescript
const inventory = await prisma.inventory.create({
  data: { itemId, locationId, batchNumber: 'DEFAULT', physicalQty: 100 },
});
```

If Warehouse A already has a "DEFAULT" batch for Steel Rod 10mm, PostgreSQL enforces `@@unique([itemId, locationId, batchNumber])` and rejects the insert. Prisma wraps that as `P2002`. Our error handler sends back:
```json
{
  "success": false,
  "message": "A record with this value already exists.",
  "field": ["itemId", "locationId", "batchNumber"]
}
```

The route handler never has to write any code for this. It just lets Prisma throw, and the error handler does the rest.

---

## P2025 — Record Not Found

### What PostgreSQL sees

When you try to **update or delete** a row that doesn't exist, PostgreSQL finds 0 rows to operate on. Prisma treats this as an error.

Note: This is **different** from `findUnique()` returning `null`. That's not an error — it's a normal "nothing found" result. P2025 only fires on **write operations** against a non-existent record.

### What triggers it

```typescript
// Someone calls PATCH /api/items/abc999 (id doesn't exist)
await prisma.item.update({
  where: { id: 'abc999' },
  data: { name: 'New Name' },
});

// PostgreSQL: "I looked for id='abc999' to update, found nothing"
// Prisma throws:
//   PrismaClientKnownRequestError {
//     code: 'P2025',
//     message: 'Record to update not found.'
//   }
```

### How the error handler catches it

```typescript
if (err.code === 'P2025') {
  return res.status(404).json({ success: false, message: 'Record not found.' });
}
```

Maps to **HTTP 404 Not Found**.

### Why most routes handle 404 manually instead

You'll notice that most routes in this app do their own 404 check:

```typescript
// In routes/items.ts GET /:id
const item = await prisma.item.findUnique({ where: { id: req.params.id } });
if (!item) throw new AppError(404, 'Item not found.');
```

That's because `findUnique` returns `null` (not a P2025 error) when nothing is found. P2025 only fires on `update` / `delete` operations on non-existent records.

So the P2025 handler in `errorHandler.ts` is a **safety net** — it catches cases where a route forgets to check for null first, or where an update hits a race condition (record existed when you read it but was deleted before the update ran).

---

## Visual summary of the full chain

```
POST /api/items (duplicate SKU)
│
│  prisma.item.create({ data: { sku: 'STEEL-ROD-10MM' } })
│
│  PostgreSQL: "UNIQUE constraint violation on 'sku'"
│      ↓
│  Prisma wraps it:
│  PrismaClientKnownRequestError { code: 'P2002', meta: { target: ['sku'] } }
│      ↓
│  Route handler has no try/catch
│  express-async-errors catches the thrown error
│  Passes to next(err)
│      ↓
│  errorHandler.ts runs
│  err instanceof Prisma.PrismaClientKnownRequestError → true
│  err.code === 'P2002' → true
│      ↓
│  res.status(409).json({
│    success: false,
│    message: 'A record with this value already exists.',
│    field: ['sku']
│  })
│
↓ Browser sees HTTP 409 with the JSON above
```

---

## The key insight

The numbers `P2002` and `P2025` are **Prisma's internal classification system** for database errors. Prisma gives each type of database error a predictable code so your application code can handle them consistently — regardless of which database you're using (PostgreSQL, MySQL, SQLite).

Your `errorHandler.ts` is essentially a **translation layer**: it converts Prisma's internal error codes into standard HTTP status codes that the frontend and API clients understand.

| Prisma code | Database event | HTTP status | Meaning |
|---|---|---|---|
| `P2002` | Unique constraint violated | 409 Conflict | Something already exists with that value |
| `P2025` | Record not found (on write) | 404 Not Found | Nothing to update/delete |

You can see the full list of Prisma error codes at: https://www.prisma.io/docs/reference/api-reference/error-reference — but `P2002` and `P2025` are the two most commonly encountered in any real application.

---

## File: `src/routes/auth.ts` — Authentication Routes

### `POST /api/auth/login`

```
1. express-validator validates email (must be valid email) and password (not empty)
2. validate middleware checks results — if invalid, returns 422 immediately
3. prisma.user.findUnique({ where: { email } }) — looks up user by email
4. if no user OR user.isActive === false → throw 401
   WHY same message for both cases: prevents email enumeration attacks
   (attacker cannot distinguish "email doesn't exist" from "account inactive")
5. bcrypt.compare(password, user.password) — compares plain text to stored hash
   WHY bcrypt: passwords are never stored in plain text; bcrypt adds salt + slow hash
6. jwt.sign({ userId, email, role }, JWT_SECRET, { expiresIn: '8h' })
   The token payload contains userId, email, role — enough for auth checks
   JWT_SECRET signs the token; anyone with the secret can verify it
   expiresIn: '8h' means the token stops working after 8 hours
7. Return token + user object (WITHOUT the password hash)
```

**Why `normalizeEmail()`?** Express-validator's `normalizeEmail()` lowercases the email. This is why all seed emails are lowercase (`admin@opserp.dev` not `admin@opsErp.dev`). Without normalization, `Admin@opserp.dev` and `admin@opserp.dev` would be treated as different emails.

### `GET /api/auth/me`

```typescript
router.get('/me', authenticate, (req: AuthenticatedRequest, res: Response) => {
  return res.json({ success: true, user: req.user });
});
```

Does NOT hit the database. It only returns what's already in `req.user` from the JWT payload. This is intentional — it's fast and avoids a DB round-trip for a common "who am I?" call. The tradeoff: if the user is deleted or deactivated after login, `/me` still returns them until the JWT expires.

**Interview question:** Q: What is a JWT and why is it used here?
A: A JWT (JSON Web Token) is a self-contained token that encodes claims (userId, role, expiry) and is cryptographically signed. The server can verify the token without hitting the database on every request — it just checks the signature with the secret key. This makes authentication stateless and fast.
