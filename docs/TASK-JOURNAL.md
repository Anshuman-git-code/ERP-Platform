# Backend Task Journal — Hands-On Learning Log

> **Purpose:** A personal log of every task completed while learning the ERP backend codebase.
> Each entry records what was done, what was observed, what broke, what was learned, and the
> exact commands and code changes made. Written for future reference — to re-read, revise, and
> build on top of.

---

## How to read this journal

Each task has the same structure:
1. **Goal** — what we were trying to learn
2. **Prerequisites** — what needed to be running before starting
3. **Steps** — exactly what was done, in order
4. **Observations** — what actually happened (terminal output, browser output)
5. **The Explanation** — why it happened, the concept behind it
6. **Key Takeaways** — the things to remember

---

## Task 1 — Break, Observe, and Enhance

**Date completed:** October 5, 2026
**File touched:** `backend/src/app.ts`
**Overall goal:** Learn the difference between TypeScript compile-time errors and Express runtime errors,
and practice reading data from a URL query string.

---

### Prerequisites

Before starting, the following needed to be true:

- A terminal open at the project root (`CASE-STUDY-2/`)
- The backend development server running via:
  ```bash
  npm run dev:backend
  ```
- The health endpoint reachable and returning a normal response at:
  ```
  http://localhost:4000/health
  ```

The normal healthy response looks like this:
```json
{
  "status": "ok",
  "timestamp": "2026-10-05T...",
  "uptime": 12,
  "version": "1.0.0",
  "environment": "development",
  "database": {
    "status": "ok",
    "latencyMs": 5
  }
}
```

---

### Step 1 — Causing a TypeScript (Compile-Time) Error

#### What was done

Inside `backend/src/app.ts`, in the `/health` route handler, this line exists:

```typescript
const healthy = dbStatus === 'ok';
```

It was changed to:

```typescript
const healthy: string = dbStatus === 'ok';
```

The file was saved.

#### What was observed

**In VS Code:** The Problems tab showed a red squiggle under `healthy` and displayed:
```
Type 'boolean' is not assignable to type 'string'
```

**In the terminal (backend server):** The server did NOT crash. It restarted normally:
```
[INFO] 08:28:32 Restarting: .../backend/src/app.ts has been modified
info: Database connection established
info: Server listening on port 4000 [development]
```

#### Why didn't the terminal crash?

This was the first big question. The code has a real TypeScript error — so why did the server keep running?

The answer is the `--transpile-only` flag in the `dev` script inside `backend/package.json`:

```json
"dev": "ts-node-dev --respawn --transpile-only src/index.ts"
```

TypeScript normally does two things when you run it:
1. **Type checking** — reads all files, checks for type errors (like assigning a boolean to a string)
2. **Transpilation** — strips all TypeScript syntax and converts the code to plain JavaScript

`--transpile-only` tells `ts-node-dev`: **skip step 1 entirely**. Only do step 2.

So when the file was saved, `ts-node-dev` just stripped the `: string` annotation (which is TypeScript syntax, not JavaScript) and ran the remaining JavaScript. The remaining JavaScript is:

```javascript
const healthy = dbStatus === 'ok';
```

That is perfectly valid JavaScript. Node.js ran it with no complaints.

VS Code catches the error because it runs the TypeScript compiler in the background as you type. But the development server does not — it is optimised for speed.

#### How to catch these errors properly

Run the type checker manually:

```bash
cd backend
npm run typecheck
```

Which runs `tsc --noEmit` — type checks everything without writing any output files.

**Terminal output:**
```
src/app.ts:52:9 - error TS2322: Type 'boolean' is not assignable to type 'string'.

52   const healthy: string = dbStatus === 'ok';
           ~~~~~~~

Found 1 error in src/app.ts:52
```

This is how CI/CD pipelines catch type errors before deployment. In the GitLab pipeline
(`.gitlab-ci.yml`), the `backend:typecheck` job runs this exact command on every push.

#### Fix

The line was reverted back to:

```typescript
const healthy = dbStatus === 'ok';
```

No type annotation needed — TypeScript infers `boolean` automatically from the comparison.

---

### Step 2 — Causing a Runtime Error

#### What was done

Inside the `/health` route handler in `backend/src/app.ts`, this line was added at the very top
of the handler function body — before any other code:

```typescript
app.get('/health', async (_req, res) => {
  throw new Error("This is a simulated runtime crash!");  // ← added here

  const start = Date.now();
  let dbStatus = 'ok';
  // ... rest of handler
```

The file was saved. The server restarted without complaint (`ts-node-dev` was happy because
`throw new Error(...)` is completely valid TypeScript syntax — no type error here).

#### What was observed

**In the browser** — visiting `http://localhost:4000/health`:
```json
{
  "success": false,
  "message": "Internal server error"
}
```

**In the terminal:**
```
error: Unhandled error This is a simulated runtime crash! {
  "stack": "Error: This is a simulated runtime crash!\n
    at .../backend/src/app.ts:43:9\n
    at newFn (.../express-async-errors/index.js:16:20)\n
    at Layer.handle_request (.../express/lib/router/layer.js:95:5)\n
    ..."
}
info: ::1 - - [05/Oct/2026] "GET /health HTTP/1.1" 500 51
```

#### Why didn't the server crash?

In many languages, an unhandled exception kills the entire process. Express does not work that way.

Near the very bottom of `backend/src/app.ts`, there is a special 4-parameter middleware:

```typescript
app.use(errorHandler);
```

And inside `backend/src/middleware/errorHandler.ts`:

```typescript
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  // ...
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  return res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
}
```

Express recognises a **Global Error Handling Middleware** by its 4-parameter signature
`(err, req, res, next)`. When any route throws an error, `express-async-errors` (imported at
the top of `app.ts`) intercepts it and passes it to this handler.

The handler does two things:
1. **Logs** the full stack trace to the terminal (for developers to debug)
2. **Sends** a clean JSON response to the browser with status 500

The server itself keeps running. Only that single request failed — all other users are unaffected.
This is the correct behaviour for a production API.

The `500` status code in the terminal log (`"GET /health HTTP/1.1" 500`) confirms HTTP 500
Internal Server Error was returned.

#### Fix

The `throw new Error(...)` line was removed.

---

### Step 3 — Reading a URL Query Parameter

#### What is a query parameter?

A query parameter is extra data passed in a URL after a `?`. For example:

```
http://localhost:4000/health?ping=true
```

- `?` marks the start of query parameters
- `ping` is the key
- `true` is the value

Express automatically parses this and makes it available as `req.query`:

```typescript
req.query = { ping: "true" }
```

Note: Everything in a URL is text. Even though `true` looks like a boolean, Express reads it
as the **string** `"true"`. That is why the comparison uses `=== 'true'` (comparing to a string).

#### What was done

**Change 1:** The route signature was updated to remove the underscore prefix from `_req`.
The underscore is a TypeScript/JavaScript convention meaning "this parameter exists but I
deliberately do not use it." Since we now need to read from the request, the underscore is removed:

```typescript
// Before:
app.get('/health', async (_req, res) => {

// After:
app.get('/health', async (req, res) => {
```

**Change 2:** A new variable was added to read the ping query parameter:

```typescript
const isPing = req.query.ping === 'true';
```

This evaluates to `true` if the URL contains `?ping=true`, and `false` for everything else.

**Change 3:** The JSON response was modified to include `pong: true` only when `isPing` is true.

The final code used was:

```typescript
return res.status(healthy ? 200 : 503).json({
  status: healthy ? 'ok' : 'degraded',
  ...isPing ? { pong: true } : {},   // ← this line was added
  timestamp: new Date().toISOString(),
  uptime: Math.floor(process.uptime()),
  version: process.env.npm_package_version ?? '1.0.0',
  environment: process.env.NODE_ENV ?? 'development',
  database: { status: dbStatus, latencyMs: dbLatencyMs },
});
```

#### Understanding the spread line

The line `...isPing ? { pong: true } : {}` uses two JavaScript concepts together:

**The ternary operator:**
```
condition ? valueIfTrue : valueIfFalse
```
So `isPing ? { pong: true } : {}` means:
- If `isPing` is `true` → give me the object `{ pong: true }`
- If `isPing` is `false` → give me an empty object `{}`

**The spread operator (`...`):**
The `...` takes all properties out of an object and places them into the surrounding object.

```javascript
const base = { a: 1 };
const result = { ...base, b: 2 };
// result = { a: 1, b: 2 }
```

Spreading an empty object `{}` adds nothing:
```javascript
const result = { ...{} };
// result = {}  — nothing added
```

Combining both:
- When `isPing` is `true`: `...{ pong: true }` → adds `pong: true` to the response
- When `isPing` is `false`: `...{}` → adds nothing to the response

This is a common pattern in JavaScript/TypeScript for conditionally including properties
in an object without using an `if` statement.

Note: The mentor originally suggested `...(isPing && { pong: true })`. The version
written independently was `...isPing ? { pong: true } : {}`. Both are correct and
produce identical output. The ternary version is arguably more readable to beginners.

#### What was observed

**Browser — visiting `http://localhost:4000/health?ping=true`:**
```json
{
  "status": "ok",
  "pong": true,
  "timestamp": "2026-10-05T04:00:01.669Z",
  "uptime": 20,
  "version": "1.0.0",
  "environment": "development",
  "database": {
    "status": "ok",
    "latencyMs": 23
  }
}
```

`"pong": true` appeared correctly in the response.

**Browser — visiting `http://localhost:4000/health` (no query param):**
The normal health response returns without any `pong` field.

---

### Key Takeaways from Task 1

| Concept | What was learned |
|---|---|
| `--transpile-only` | The development server skips type checking for speed. TypeScript errors show in VS Code but do NOT crash the dev server. |
| `npm run typecheck` | The correct command to manually run type checking. This is what CI/CD runs before every deployment. |
| Compile-time error | A mistake TypeScript catches while reading your code (wrong type assignment). |
| Runtime error | A mistake that only appears when the code actually executes (throwing an error inside a route). |
| Global Error Handler | A 4-parameter Express middleware at the bottom of `app.ts` that catches all thrown errors, logs them, and returns a clean 500 response without crashing the server. |
| `req.query` | An object Express automatically creates from URL query parameters. All values are strings. |
| Ternary operator | `condition ? ifTrue : ifFalse` — a single-line if/else |
| Spread operator in objects | `...obj` inside `{ }` copies all properties of `obj` into the surrounding object |
| Conditional spread | Combining ternary and spread to add properties to an object only when a condition is true |

---

### Final state of the modified section in `backend/src/app.ts`

```typescript
app.get('/health', async (req, res) => {
  const start = Date.now();
  let dbStatus = 'ok';
  let dbLatencyMs = 0;

  try {
    const { prisma } = await import('./lib/prisma');
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - start;
  } catch {
    dbStatus = 'unreachable';
  }

  const healthy = dbStatus === 'ok';
  const isPing = req.query.ping === 'true';

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    ...isPing ? { pong: true } : {},
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: process.env.npm_package_version ?? '1.0.0',
    environment: process.env.NODE_ENV ?? 'development',
    database: { status: dbStatus, latencyMs: dbLatencyMs },
  });
});
```

---

*Task 2 will be documented here once completed.*

---

## Task 2 — Understanding Routers, Middleware Order, Authentication and Authorization

**Date completed:** October 5, 2026
**Files touched:** `backend/src/routes/locations.ts`
**Files read for understanding:** `backend/src/app.ts`, `backend/src/middleware/auth.ts`
**Overall goal:** Understand how Express Routers work, how middleware order controls
access to routes, and how JWT authentication actually flows from login to a protected endpoint.

---

### Why this task exists

In Task 1, every change was made directly in `app.ts` — the central application file. That works for
one or two routes, but the ERP system has dozens of endpoints across 8 different feature areas.
If every endpoint lived in `app.ts`, it would become thousands of lines and impossible to maintain.

Express solves this with **Routers** — isolated mini-applications, one per feature area. This task
introduces how they work, how they connect to the main app, and how middleware behaves inside them.

---

### Background: How the application is structured

Before touching any code, it helps to understand the two-level routing system already in place.

**Level 1 — `app.ts` (the main router)**

`app.ts` mounts each feature router at a URL prefix:

```typescript
app.use('/api/locations', locationRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/inventory', inventoryRoutes);
// ...
```

This says: "Any request whose URL starts with `/api/locations` — stop looking in `app.ts`.
Send it to `locationRoutes` to handle."

**Level 2 — `locations.ts` (the feature router)**

Inside `locations.ts`, routes are defined relative to the prefix:

```typescript
router.get('/', ...)     // handles GET /api/locations
router.get('/:id', ...) // handles GET /api/locations/some-id
router.post('/', ...)   // handles POST /api/locations
```

The full URL is the prefix from `app.ts` **+** the path from the router.

This is the key mental model. Any new path added to `locations.ts` automatically inherits
the `/api/locations` prefix from `app.ts`. That is exactly why the new `/hello` route was
accessible at `/api/locations/hello` without touching `app.ts` at all.

---

### Step 1 — Adding a simple public route

#### What was done

A new route was added inside `backend/src/routes/locations.ts`, placed **above** the
`router.use(authenticate)` line:

```typescript
router.get('/hello', (_req, res: Response) => {
  return res.json({ message: "Hello from the locations router!" });
});
```

#### Code breakdown — syntax level

| Part | What it means |
|---|---|
| `router.get` | Register a handler for GET requests on this router |
| `'/hello'` | The path, relative to the router's prefix (`/api/locations`) |
| `(_req, res: Response)` | The handler function. `_req` = request (unused). `res` = response |
| `return res.json(...)` | Send a JSON body back to the client and end the request |

#### Code breakdown — behavior level

When Express receives `GET /api/locations/hello`:
1. `app.ts` sees the path starts with `/api/locations` → sends it to `locationRoutes`
2. `locationRoutes` checks its registered routes
3. Finds `router.get('/hello', ...)` → runs the handler
4. Handler calls `res.json(...)` → sends JSON, closes the response

#### Why `_req` and not just `req`?

The underscore prefix is a TypeScript and JavaScript convention meaning "this parameter
is required by the function signature but I intentionally do not use it." Without the underscore,
ESLint would flag it as an unused variable. With the underscore, it is silently ignored.

The route handler signature requires both `req` and `res` to be declared because Express always
passes both. You cannot just declare `(res)` — the framework does not work that way.

---

### Step 2 — The first test: blocked by authentication

#### What was observed

Visiting `http://localhost:4000/api/locations/hello` in the browser returned:

```json
{
  "success": false,
  "message": "Authentication token required."
}
```

#### Why this happened

The route was placed **below** this line in `locations.ts`:

```typescript
router.use(authenticate);
```

`router.use(middleware)` registers middleware that runs **before every route registered
after it in the same file**. Express processes code from top to bottom.

The execution order was:
1. Request arrives for `/api/locations/hello`
2. `router.use(authenticate)` ran first → checked for `Authorization: Bearer <token>` header
3. Browser sent no such header (browsers never send auth headers automatically)
4. `authenticate` called `next(new AppError(401, 'Authentication token required.'))`
5. The route handler never ran

#### The fix: middleware order controls access

The route was moved to **above** the `router.use(authenticate)` line:

```typescript
// ← ABOVE authenticate: public, no token needed
router.get('/hello', (_req, res: Response) => {
  return res.json({ message: "Hello from the locations router!" });
});

router.use(authenticate); // ← everything BELOW this requires a token

router.get('/', authorize(...ALL_ROLES), async (_req, res: Response) => {
  // ...
});
```

After saving, `http://localhost:4000/api/locations/hello` returned:

```json
{
  "message": "Hello from the locations router!"
}
```

This works because Express never reaches `router.use(authenticate)` when handling
the `/hello` route — the handler above it responds first and ends the request.

---

### Step 3 — Putting the route back behind authentication

The route was moved back below `router.use(authenticate)` to make it protected.
This raised two important questions.

#### Question 1: Why can't the browser test a protected route?

The browser address bar sends a simple GET request with no custom headers. The
`authenticate` middleware looks for an `Authorization` header:

```typescript
const authHeader = req.headers.authorization;
if (!authHeader?.startsWith('Bearer ')) {
  return next(new AppError(401, 'Authentication token required.'));
}
```

There is no way to type a custom header into a browser address bar. To test
authenticated routes, developers use:

- **cURL** — a terminal command-line HTTP client
- **Postman** — a GUI desktop application for API testing
- **Thunder Client / REST Client** — VS Code extensions
- **The frontend application** — which stores the token and sends it automatically

#### Question 2: The difference between `authenticate` and `authorize`

This was one of the most important questions asked during Task 2.

Looking at the existing routes in `locations.ts`:

```typescript
router.use(authenticate);           // ← applies to everything below

router.get('/', authorize(...ALL_ROLES), ...)    // ← also has authorize
router.post('/', authorize(...ADMIN_ONLY), ...)  // ← also has authorize
router.get('/:id', authorize(...ALL_ROLES), ...) // ← also has authorize
```

The new `/hello` route has `authenticate` (via `router.use`) but no `authorize`. Why?

**Authentication** answers: *"Who are you?"*
- Checks if a valid JWT token exists in the request
- Decodes the token and attaches `req.user = { userId, email, role }` to the request
- Applies to every route below `router.use(authenticate)`
- Defined in `backend/src/middleware/auth.ts` as `authenticate()`

**Authorization** answers: *"Are you allowed to do this?"*
- Checks `req.user.role` against a list of permitted roles
- Applies only to the specific route it is added to
- Defined in `backend/src/middleware/auth.ts` as `authorize(...roles)`
- `authorize(...ALL_ROLES)` means any logged-in user can access it
- `authorize(...ADMIN_ONLY)` means only admins can access it

The `/hello` route has authentication (must be logged in) but no authorization
(any role is allowed). This is valid and intentional — not every protected route
needs role restrictions.

---

### Step 4 — Logging in and getting a token with cURL

To test the protected `/hello` route, a JWT token was needed. The login endpoint was
called using cURL.

**First attempt (wrong credentials):**
```bash
curl -X POST http://localhost:4000/api/auth/login \
-H "Content-Type: application/json" \
-d '{"email":"admin@ops.local", "password":"password123"}'
```

**Response:**
```json
{"success":false,"message":"Invalid email or password."}
```

The wrong email and password were used. The seed file (`backend/prisma/seed.ts`) defines
the actual test user credentials.

**Second attempt (correct credentials from seed.ts):**
```bash
curl -X POST http://localhost:4000/api/auth/login \
-H "Content-Type: application/json" \
-d '{"email":"admin@opserp.dev", "password":"Password123!"}'
```

**Response:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJjb...",
  "user": {
    "id": "cmtlmni9u000012gpcpb6fife",
    "name": "Admin User",
    "email": "admin@opserp.dev",
    "role": "ADMIN"
  }
}
```

#### What is that token?

The token is a **JWT (JSON Web Token)**. It looks like random characters but is structured
in three parts separated by dots:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9    ← Header (base64)
.eyJ1c2VySWQiOiJjb...                    ← Payload (base64)
.y3VvESubr_b3OH4O3tP0uAwKr...           ← Signature (cryptographic)
```

The payload (middle part) contains: `{ userId, email, role, iat, exp }`.
Anyone can base64-decode it and read the contents — it is not encrypted.
But the **signature** proves it was created by your server (using `JWT_SECRET`).
If anyone tampers with the payload, the signature no longer matches and
`jwt.verify()` rejects it.

This is how the server trusts the token without needing to query the database
on every request — the signature proves authenticity.

---

### Step 5 — Using the token to access the protected route

```bash
curl -X GET http://localhost:4000/api/locations/hello \
-H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJjb..."
```

**Response:**
```json
{"message":"Hello from the locations router!"}
```

#### What happened inside the server

1. Request arrived with `Authorization: Bearer <token>` header
2. `router.use(authenticate)` ran
3. `authenticate` read `req.headers.authorization` → found the header
4. Called `jwt.verify(token, JWT_SECRET)` → valid signature, not expired
5. Decoded the payload → `{ userId, email, role: 'ADMIN' }`
6. Set `req.user = { userId, email, role }` on the request object
7. Called `next()` → passed control to the route handler
8. Route handler ran → returned the JSON message

This is the full JWT authentication flow: login → get token → send token with requests.

---

### The final state of `locations.ts` after Task 2

```typescript
const router = Router();
router.use(authenticate);  // everything below requires a valid JWT

// Custom route added in Task 2 — protected but no role restriction
router.get('/hello', (_req, res: Response) => {
  return res.json({ message: "Hello from the locations router!" });
});

// Original routes — protected AND role-restricted
router.get('/', authorize(...ALL_ROLES), async (_req, res: Response) => { ... });
router.post('/', authorize(...ADMIN_ONLY), async (req: AuthenticatedRequest, res: Response) => { ... });
router.get('/:id', authorize(...ALL_ROLES), async (req: AuthenticatedRequest, res: Response) => { ... });
```

---

### Learning Gap Analysis

These are concepts that were not explicitly asked about but are important for understanding
what happened in Task 2.

---

#### Gap 1 — How Express Router actually works under the hood

**Concept:** `Router()` creates an isolated middleware/route stack

**Why it matters:** Understanding this explains why `router.use(authenticate)` only affects
routes in `locations.ts` and not routes in `items.ts` or `orders.ts`.

**How it works:** When you call `Router()`, Express creates a completely independent
middleware and route stack. When `app.use('/api/locations', locationRoutes)` is called,
Express wraps that router and only sends requests matching `/api/locations*` into it.
Each router manages its own middleware independently.

**How it relates to this task:** This is why adding `router.use(authenticate)` in
`locations.ts` does not affect `app.ts`'s `/health` route or any other feature router.

**Common misunderstanding:** Thinking that `router.use(authenticate)` in one file
affects all routes in the entire application. It only affects routes in that specific
router, registered after that line.

---

#### Gap 2 — The HTTP Authorization header format

**Concept:** `Authorization: Bearer <token>` is a standardized HTTP header

**Why it matters:** Every authenticated API call you make (from a browser, mobile app,
or another service) must include this header. Understanding the format prevents debugging
confusion.

**How it works:**
- `Authorization` is the header name (case-insensitive in HTTP, but capitalize by convention)
- `Bearer` is the authentication scheme (there are others: `Basic`, `Digest`, `API-Key`)
- A space separates the scheme from the token
- The token follows

In the `authenticate` middleware:
```typescript
const authHeader = req.headers.authorization;
if (!authHeader?.startsWith('Bearer ')) { ... }
const token = authHeader.slice(7); // removes "Bearer " (7 characters)
```

**Common misunderstanding:** Thinking the token can be sent as a query parameter
(`?token=...`) or in the request body. While technically possible, the `Authorization`
header is the standard and is what this codebase expects.

---

#### Gap 3 — What `req.headers` actually contains

**Concept:** `req.headers` is a plain JavaScript object containing all HTTP request headers

**Why it matters:** Headers carry metadata about the request — who sent it, what format
the body is in, what the client accepts, etc.

**How it works:** When a browser or `curl` makes a request, it sends headers like:
```
GET /api/locations/hello HTTP/1.1
Host: localhost:4000
Authorization: Bearer eyJhbG...
Content-Type: application/json
```

Express parses these and makes them available as `req.headers`:
```typescript
req.headers.authorization // → "Bearer eyJhbG..."
req.headers['content-type'] // → "application/json"
req.headers.host // → "localhost:4000"
```

Note: Header names are lowercased by Express regardless of how the client sent them.

---

#### Gap 4 — The difference between `next()` and `next(err)`

**Concept:** `next()` advances to the next middleware. `next(err)` skips to the error handler.

**Why it matters:** The authenticate middleware uses both. Understanding this explains
why a failed auth check results in an error response, not just silence.

**How it works:**
```typescript
// Advance to next middleware/route:
return next();

// Skip to error handler with an AppError:
return next(new AppError(401, 'Authentication token required.'));
```

When `next(error)` is called with any argument, Express skips all remaining regular
middleware and routes and jumps directly to the error handling middleware (the 4-parameter
function at the bottom of `app.ts`).

**In this task:** When the browser hit `/hello` without a token, `authenticate` called
`next(new AppError(401, ...))` → jumped to `errorHandler` → returned `401` JSON.

---

#### Gap 5 — Why tokens expire (`exp` claim in JWT)

**Concept:** JWTs have a built-in expiration time

**Why it matters:** The token seen in the terminal has `"exp": 1791204718` in its
decoded payload. Once the current time exceeds that Unix timestamp, `jwt.verify()`
throws `TokenExpiredError`.

**How it works:** When the token is created in `auth.ts`:
```typescript
jwt.sign(
  { userId, email, role },
  JWT_SECRET,
  { expiresIn: JWT_EXPIRES_IN }  // from process.env.JWT_EXPIRES_IN — set to "8h" in .env
)
```

`expiresIn: '8h'` tells `jsonwebtoken` to add `iat` (issued at) and `exp` (expires at)
timestamps to the payload automatically.

**In the authenticate middleware:**
```typescript
} catch (err) {
  if (err instanceof jwt.TokenExpiredError) {
    return next(new AppError(401, 'Token expired.'));
  }
  return next(new AppError(401, 'Invalid token.'));
}
```

Two distinct error messages are returned — "Token expired" (user just needs to log in again)
vs "Invalid token" (something is genuinely wrong with the token structure or signature).

**Practical implication:** The token obtained during Task 2 will stop working after
8 hours. To test again after expiry, just run the login curl command again to get a new one.

---

#### Gap 6 — Why cURL flags matter

**Concept:** Each cURL flag changes how the HTTP request is constructed

**Why it matters:** In a real job, you will use cURL constantly for quick API testing.

| Flag | Meaning |
|---|---|
| `-X POST` | Set the HTTP method to POST (default is GET) |
| `-H "Content-Type: application/json"` | Add a header telling the server the body is JSON |
| `-d '{"email":...}'` | The request body (data) to send |
| `-H "Authorization: Bearer ..."` | Add the auth header |

Without `-H "Content-Type: application/json"`, the server would not know to parse the
body as JSON. Express's `express.json()` middleware only activates if this header is present.

---

### Edge Cases

**What if the token is expired?**
`jwt.verify()` throws `TokenExpiredError`. The `authenticate` middleware catches it and
returns `401 "Token expired."` — different message from an invalid token, intentionally.

**What if the `Authorization` header exists but has no `Bearer ` prefix?**
`authHeader.startsWith('Bearer ')` returns false → 401 "Authentication token required."
The token is never extracted or verified.

**What if the JWT_SECRET changes while a user is logged in?**
All existing tokens become invalid immediately. `jwt.verify()` fails because the signature
no longer matches the new secret. Every logged-in user is effectively logged out. This is
why secret rotation is a controlled, planned operation.

**What if a route path conflicts with a parameter route?**
Example: `router.get('/hello', ...)` and `router.get('/:id', ...)` both exist.
Express matches routes in the order they are registered. Since `/hello` is registered
first, a request for `/hello` matches it. The `/:id` handler never runs for that path.
If they were reversed, `/hello` would be treated as an ID — a bug. Order matters.

**What happens if someone sends `?ping=TRUE` (uppercase)?**
`req.query.ping === 'true'` returns `false` because JavaScript string comparison
is case-sensitive. `'TRUE' === 'true'` is `false`. This is an edge case from Task 1
that is worth remembering — query parameter values arrive exactly as the user typed them.

---

### Practical Experiments

**Experiment 1 — See what happens when the token is missing**
```bash
curl -X GET http://localhost:4000/api/locations/hello
```
Expected: `{"success":false,"message":"Authentication token required."}`

**Experiment 2 — See what happens with a garbage token**
```bash
curl -X GET http://localhost:4000/api/locations/hello \
-H "Authorization: Bearer thisisnotavalidtoken"
```
Expected: `{"success":false,"message":"Invalid token."}`

**Experiment 3 — See the public `/hello` route work without a token (if placed above authenticate)**
Move the route above `router.use(authenticate)`, save, then:
```bash
curl -X GET http://localhost:4000/api/locations/hello
```
Expected: `{"message":"Hello from the locations router!"}`

**Experiment 4 — Verify middleware order visually**
In `locations.ts`, place a `console.log('authenticate ran')` inside the authenticate
middleware call... actually, open `backend/src/middleware/auth.ts` and add a temporary
`console.log` at the start of the function. Then hit the route and watch the terminal
to see when it fires relative to the route handler.

---

### Key Takeaways from Task 2

| Concept | What was learned |
|---|---|
| Express Router | A mini-application that groups related routes. The full URL = prefix from `app.ts` + path from the router |
| Middleware order | In Express, code runs top to bottom. A `router.use()` call affects all routes registered **after** it in the same file |
| Public vs protected routes | Place a route **above** `router.use(authenticate)` to make it public. Place it **below** to require a token |
| Authentication | "Who are you?" — verifies the JWT and sets `req.user`. Runs once via `router.use()` |
| Authorization | "Are you allowed?" — checks the role. Added individually to routes that need role restrictions |
| JWT structure | Three base64-encoded parts: header + payload + signature. Payload is readable but tamper-proof |
| cURL | A terminal tool for making HTTP requests with custom headers, methods, and bodies. Essential for testing APIs |
| `Authorization: Bearer` | The standard HTTP header format for passing a JWT token to a server |
| Token expiry | JWTs expire automatically based on `expiresIn`. After expiry, `jwt.verify()` throws `TokenExpiredError` |
| `next()` vs `next(err)` | `next()` advances the chain. `next(err)` skips to the error handler |

---

### Self-Check Questions

Test yourself without looking at the explanations above:

1. If you add a route to `locations.ts` with path `/summary`, what full URL would a client use to reach it?
2. Why does putting a route above `router.use(authenticate)` make it publicly accessible?
3. What is the difference between `authenticate` and `authorize`? Can a route have one without the other?
4. A user logs in and gets a token. The server restarts and `JWT_SECRET` changes. What happens when that user makes their next request?
5. You want only ADMIN users to access a new route. What do you add to the route definition?
6. Why is `req.headers.authorization` read as a lowercase string even if the client sent `Authorization` with a capital A?
7. What does `authHeader.slice(7)` do? Why the number 7?
8. A request comes in with `Authorization: eyJhbGci...` (no `Bearer ` prefix). What happens?
9. You have a token that was issued 10 hours ago with `expiresIn: '8h'`. What does `jwt.verify()` do with it?
10. What would happen if you registered `router.get('/:id', ...)` before `router.get('/hello', ...)` in the same file?

---

### Engineering Perspective — Why this matters in a real project

**Separation of concerns** — Router files are one of the most fundamental patterns in backend
architecture. Every major backend framework uses this pattern (Django views, Rails controllers,
Spring controllers, Fastify plugins). Understanding it means you can navigate any backend codebase.

**Stateless authentication** — The JWT pattern is stateless: the server holds no session state.
Every request carries its own proof of identity. This is why it scales to many servers easily —
any server can verify a token without asking another server. Cloud deployments (like this ERP's
ECS setup) depend on this because requests can land on any container instance.

**The Authorization header is a security boundary** — It cannot be set by a webpage via
JavaScript fetch without explicit CORS permission. Attackers cannot trick browsers into sending
tokens to different origins. This is a fundamental browser security feature.

**Middleware ordering bugs are real production issues** — A misplaced `router.use()` or
`app.use()` can accidentally expose private routes to the public, or accidentally block
routes that should be public. This exact type of bug has caused real security incidents.
Order always matters in Express.

---

### Interview Perspective

**Common interview question:** "Explain the difference between authentication and authorization."

What the interviewer is testing: Whether you understand that these are two separate concerns
that work in sequence. Authentication verifies identity. Authorization checks permissions.
A system can authenticate without authorizing (you know who the user is, but they cannot
access this specific resource).

**Common interview question:** "Why use JWTs instead of sessions?"

What the interviewer is testing: Understanding of stateless vs stateful architecture. JWTs
allow horizontal scaling (any server can verify), while sessions require a shared session
store (like Redis) or sticky load balancing. JWTs have trade-offs too — they cannot be
invalidated before expiry without extra infrastructure.

**Common interview question:** "What happens if someone steals a JWT?"

What the interviewer is testing: Awareness of JWT limitations. A stolen JWT is valid until
it expires. Mitigation strategies: short expiry times, refresh tokens, token rotation,
HTTPS-only transmission, and storing tokens in HttpOnly cookies (not localStorage).

---

*Task 3 will be documented here once completed.*

---

## Task 3 — Talking to the Database with Prisma

**Date completed:** October 5, 2026
**File touched:** `backend/src/routes/locations.ts`
**Files read for understanding:** `backend/src/lib/prisma.ts`, `backend/prisma/schema.prisma`
**Overall goal:** Write the first route that talks directly to the PostgreSQL database
using Prisma ORM. Understand what an ORM is, what `async/await` does in this context,
and how to read the SQL Prisma generates behind the scenes.

---

### Background — What is an ORM?

Before looking at the code, it is worth understanding what Prisma actually is.

**ORM** stands for **Object-Relational Mapper**. It is a library that acts as a
translator between two worlds:

| Your world (TypeScript) | Database world (PostgreSQL) |
|---|---|
| JavaScript objects | Table rows |
| TypeScript method calls | SQL queries |
| TypeScript types | Column types |

Without an ORM, to count locations you would write raw SQL:
```sql
SELECT COUNT(*) FROM locations;
```
and then parse the result manually into a JavaScript number.

With Prisma, you write:
```typescript
const total = await prisma.location.count();
```

Prisma writes the SQL, sends it to PostgreSQL, waits for the result, and hands you
back a plain JavaScript number. You never write SQL — you write TypeScript.

The terminal output during this task proved this directly:
```
prisma:query SELECT COUNT(*) FROM (SELECT "public"."locations"."id"
  FROM "public"."locations" WHERE 1=1 OFFSET $1) AS "sub"
```

That SQL was generated entirely by Prisma from `prisma.location.count()`.

---

### The code written

```typescript
router.get('/count', async (_req, res: Response) => {
  const totalLocations = await prisma.location.count();
  return res.json({ "success": true, "totalLocations": totalLocations });
});
```

This was placed **above** `router.use(authenticate)` — making it a public endpoint,
accessible in the browser without a token.

---

### Code breakdown

#### Syntax level

| Part | What it means |
|---|---|
| `router.get('/count', ...)` | Register a handler for `GET /api/locations/count` |
| `async (_req, res: Response)` | The handler is async (because database calls are async). `_req` is unused. `res` is the Express response object |
| `await prisma.location.count()` | Ask Prisma to count all rows in the `locations` table. `await` pauses here until the database replies |
| `prisma.location` | Access the `location` model (maps to the `locations` table in PostgreSQL, as defined in `schema.prisma`) |
| `.count()` | A Prisma method that generates `SELECT COUNT(*)` SQL |
| `res.json({...})` | Send a JSON response back to the client |

#### Behavior level

When a request hits `GET /api/locations/count`:
1. Express routes it to this handler
2. Handler calls `prisma.location.count()`
3. Prisma translates that into a PostgreSQL query and sends it over the connection pool
4. PostgreSQL executes `SELECT COUNT(*)` and returns `3`
5. Prisma returns the number `3` to your code
6. `totalLocations` is now `3`
7. `res.json(...)` sends `{"success":true,"totalLocations":3}` to the browser

#### Data-flow level

```
Browser request
  → Express router in app.ts
    → locationRoutes (prefix: /api/locations)
      → router.get('/count') handler
        → prisma.location.count()
          → Prisma Client
            → PostgreSQL connection pool
              → PostgreSQL server: SELECT COUNT(*)
              ← Returns: 3
            ← Returns: 3
          ← Returns: 3 (JavaScript number)
        ← totalLocations = 3
      ← res.json({ success: true, totalLocations: 3 })
  ← HTTP 200 with JSON body
← Browser shows JSON
```

#### Framework level — how Prisma knows about `location`

The `prisma.location` object exists because of this model definition in
`backend/prisma/schema.prisma`:

```prisma
model Location {
  id        String   @id @default(cuid())
  name      String   @unique
  address   String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("locations")   // ← maps this TypeScript model to the "locations" table
}
```

When `npx prisma generate` was run, Prisma read this schema and generated
TypeScript code that provides `prisma.location.findMany()`, `prisma.location.count()`,
`prisma.location.create()`, etc. — all fully typed.

`@@map("locations")` is why the TypeScript model is called `Location` (singular,
PascalCase) but the database table is called `locations` (plural, lowercase).
Prisma generates the client using the model name, so you write `prisma.location`
(lowercase first letter, auto-applied by Prisma convention).

#### Engineering level

The `count()` method is used here instead of `findMany()` followed by `.length`
for an important reason:

```typescript
// WRONG approach for counting:
const locations = await prisma.location.findMany();
const total = locations.length;
```

vs

```typescript
// CORRECT approach:
const total = await prisma.location.count();
```

The first approach fetches **every row** — all columns, all data — transfers it all
from the database to Node.js, and then counts the array. If there were 10,000 locations,
you would transfer all 10,000 records just to get a number.

The second approach tells PostgreSQL to do the counting inside the database and
return only a single number. It is dramatically faster, uses far less memory,
and is the correct approach. Always use purpose-built methods for what you need.

---

### What `async/await` actually does here

This is the most important concept in Task 3. Without understanding it, database code
will always feel mysterious.

#### The problem: databases are slow

When Node.js calls `prisma.location.count()`:
1. It opens a connection to PostgreSQL (or reuses one from the pool)
2. Sends the SQL query over a network
3. Waits for PostgreSQL to execute the query
4. Waits for the result to travel back over the network
5. Processes the result

This takes time — typically 1–50 milliseconds. That seems fast, but Node.js executes
JavaScript in **microseconds**. One database call takes as long as thousands of
JavaScript operations.

#### The naive solution (bad): blocking

In languages like PHP or older server architectures:
```
Request comes in
→ Start database query
→ WAIT ... WAIT ... WAIT (thread is frozen, doing nothing)
→ Query returns
→ Send response
```

While waiting, the thread is completely blocked. If 100 users make requests simultaneously,
you need 100 threads — one per request. This does not scale.

#### Node.js solution: the event loop + callbacks/promises

Node.js has a **single thread** with an **event loop**. It never blocks. When you do I/O
(network, file, database), it says "go do that, tell me when you're done" and immediately
handles other requests.

```
Request 1 comes in → start DB query → "tell me when done" → handle Request 2
Request 2 comes in → start DB query → "tell me when done" → handle Request 3
Request 3 comes in → ...
DB query for Request 1 done → respond to Request 1
DB query for Request 2 done → respond to Request 2
```

A single thread handles hundreds of concurrent requests efficiently.

#### How `async/await` fits in

`async/await` is syntactic sugar over Promises. It makes asynchronous code look like
synchronous code without actually blocking.

```typescript
// What you write (looks synchronous):
const totalLocations = await prisma.location.count();

// What is actually happening (Promise-based):
prisma.location.count().then(totalLocations => {
  // continues here when done
});
```

`await` does NOT freeze the entire Node.js process. It suspends only this specific
function — yielding control back to the event loop — and resumes when the Promise resolves.

**The rule:** Any function that uses `await` must be declared `async`. That is why
the route handler is `async (_req, res: Response) => {`. Without `async`, TypeScript
would error on the `await` keyword.

---

### The terminal output explained

```
prisma:query SELECT COUNT(*) FROM (SELECT "public"."locations"."id"
  FROM "public"."locations" WHERE 1=1 OFFSET $1) AS "sub"
```

This appeared because the backend is running in development mode (`NODE_ENV=development`),
and in `backend/src/lib/prisma.ts`, the Prisma client is configured to log queries:

```typescript
new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})
```

In production, this query logging is turned off (`['error']` only) to avoid performance
overhead and sensitive data appearing in logs. In development, it is invaluable for
understanding what SQL your Prisma code generates.

The `WHERE 1=1` is a Prisma implementation detail — a always-true condition that
Prisma adds internally, which can then be extended with filters when you add a `where`
clause. `OFFSET $1` is a parameterized placeholder for pagination — even count queries
go through Prisma's full query pipeline.

```
info: ::1 - - [05/Oct/2026:06:01:37 +0000] "GET /api/locations/count HTTP/1.1" 200 35
```

This is Morgan (the HTTP request logger) recording the request. `200` is the HTTP status
code (success). `35` is the response body size in bytes.

---

### Why `prisma.location.count()` was the right guess

The hint given was: "the code to get ALL locations is `await prisma.location.findMany()`".

Prisma's API is designed to be discoverable. The methods follow a pattern:
- `findMany()` — find multiple records
- `findUnique()` — find one by a unique field
- `findFirst()` — find the first matching record
- `count()` — count matching records
- `create()` — insert a new record
- `update()` — update an existing record
- `delete()` — delete a record
- `upsert()` — create if not exists, otherwise update
- `aggregate()` — compute sum, avg, min, max, count together

All of these exist on every model: `prisma.location.*`, `prisma.item.*`,
`prisma.inventory.*`, etc.

VS Code's autocomplete (IntelliSense) shows all available methods as you type
`prisma.location.` — this is one of the biggest advantages of a typed ORM like Prisma.

---

### The final state of `locations.ts` after Task 3

```typescript
const router = Router();

// PUBLIC (above authenticate) — Task 3 addition
router.get('/count', async (_req, res: Response) => {
  const totalLocations = await prisma.location.count();
  return res.json({ "success": true, "totalLocations": totalLocations });
});

router.use(authenticate);  // everything below requires a token

// PROTECTED (below authenticate) — Task 2 addition
router.get('/hello', (_req, res: Response) => {
  return res.json({ message: "Hello from the locations router!" });
});

// PROTECTED + ROLE-RESTRICTED — original routes
router.get('/', authorize(...ALL_ROLES), async (_req, res: Response) => { ... });
router.post('/', authorize(...ADMIN_ONLY), async (req, res) => { ... });
router.get('/:id', authorize(...ALL_ROLES), async (req, res) => { ... });
```

---

### Learning Gap Analysis

---

#### Gap 1 — What the `prisma` object is and where it comes from

**Concept:** `prisma` is imported from a singleton module — not created fresh each time

At the top of `locations.ts`:
```typescript
import { prisma } from '../lib/prisma';
```

This imports the singleton instance from `backend/src/lib/prisma.ts`. The singleton
pattern ensures the entire application shares one Prisma client — and therefore one
**connection pool** — rather than creating a new database connection on every request.

A **connection pool** is a set of pre-established database connections that are reused.
Opening a new connection to PostgreSQL takes ~100ms. A connection pool keeps connections
open and ready, so queries run immediately.

If every request created `new PrismaClient()`, you would exhaust PostgreSQL's connection
limit almost immediately under any real load.

---

#### Gap 2 — The `Response` type annotation

**Concept:** `res: Response` is a TypeScript type from `@types/express`

```typescript
router.get('/count', async (_req, res: Response) => {
```

`Response` is imported at the top: `import { Router, Response } from 'express'`.

It is the TypeScript type that gives you autocomplete for `res.json()`, `res.status()`,
`res.send()`, `res.redirect()`, etc. Without it, TypeScript would type `res` as `any`
and you would get no help from the editor.

You might notice that `_req` has no type annotation. In this case TypeScript infers
its type from the `router.get()` method signature. The explicit annotation is only
needed for `res` here because Express's TypeScript definitions are complex and
explicit typing helps clarity.

---

#### Gap 3 — Why the response uses string keys `"success"` and `"totalLocations"`

**Concept:** String keys vs identifier keys in JavaScript object literals

```typescript
return res.json({ "success": true, "totalLocations": totalLocations });
```

In JavaScript and TypeScript, these are identical:
```typescript
{ "success": true }   // string key
{ success: true }     // identifier key
```

Both produce the same object. The string form is valid but unusual — identifiers
(no quotes) are the standard convention unless the key contains spaces or special
characters (e.g., `{ "content-type": "..." }`).

The existing routes in the codebase use the identifier style:
```typescript
return res.json({ success: true, data: locations });
```

For consistency, the `/count` route would ideally also use identifier style:
```typescript
return res.json({ success: true, totalLocations: totalLocations });
```

Or even shorter using **shorthand property** syntax (where key and variable name are the same):
```typescript
return res.json({ success: true, totalLocations });
// equivalent to: { success: true, totalLocations: totalLocations }
```

This is not a bug — both forms work. But in a real codebase, consistency matters
for readability.

---

#### Gap 4 — Why `count()` returns a plain number, not an object

**Concept:** Different Prisma methods return different TypeScript types

- `prisma.location.findMany()` → `Promise<Location[]>` (array of Location objects)
- `prisma.location.findUnique(...)` → `Promise<Location | null>` (one object or null)
- `prisma.location.count()` → `Promise<number>` (a plain number)

This is fully typed — TypeScript knows at compile time what type each Prisma method
returns. If you tried to do `totalLocations.name`, TypeScript would error because
`number` has no `name` property.

This is one of Prisma's biggest advantages over raw SQL — you always know the
exact TypeScript type of your query result without writing any type annotations yourself.

---

#### Gap 5 — What happens if the database is down when `/count` is called

**Concept:** Unhandled Promise rejections in async route handlers

If the database is unreachable, `prisma.location.count()` throws a
`PrismaClientInitializationError` or `PrismaClientKnownRequestError`.

Because the route is inside an `async` function and `express-async-errors` is
imported at the top of `app.ts`, the thrown error is automatically passed to the
global `errorHandler` middleware.

Without `express-async-errors`, you would need to wrap every database call in
`try/catch`:
```typescript
router.get('/count', async (_req, res) => {
  try {
    const total = await prisma.location.count();
    return res.json({ success: true, totalLocations: total });
  } catch (err) {
    return next(err);  // manually forward the error
  }
});
```

With `express-async-errors`, the `try/catch` is added automatically around every
async handler. This is why the import line in `app.ts` is:
```typescript
import 'express-async-errors';  // must be FIRST import
```

The result in both cases: if the database is down, the client gets:
```json
{"success": false, "message": "Internal server error"}
```

---

### Edge Cases

**What if there are 0 locations in the database?**
`prisma.location.count()` returns `0` — a valid number. The response would be
`{"success":true,"totalLocations":0}`. No error.

**What if someone adds a `where` filter to the URL (`/count?active=true`)?**
The current implementation ignores all query parameters. `count()` always counts
all locations. If you wanted to support filtering, you would pass a `where` clause:
```typescript
const totalLocations = await prisma.location.count({
  where: { isActive: true }  // hypothetical — Location model has no isActive field
});
```

**What if the database has millions of locations?**
`count()` is still fast — PostgreSQL computes the count efficiently using index metadata.
It does not scan every row. `findMany()` with millions of rows would be very slow, but
`count()` would not.

**What if someone calls `/count` with a POST request instead of GET?**
Express only registered a `GET` handler for `/count`. A `POST /api/locations/count`
would fall through all route handlers and reach the 404 catch-all in `app.ts`:
```json
{"success": false, "message": "Route not found"}
```

---

### Practical Experiments

**Experiment 1 — Compare `count()` vs `findMany().length`**
You can see both approaches produce the same number, but check the terminal logs
to see what SQL each generates. Add a temporary second route:
```typescript
router.get('/count-slow', async (_req, res: Response) => {
  const all = await prisma.location.findMany();
  return res.json({ success: true, totalLocations: all.length });
});
```
Compare the SQL logged for `/count` vs `/count-slow`. The `findMany` version
fetches all columns of all rows. The `count` version fetches only a number.

**Experiment 2 — See Prisma's type safety**
In the `/count` route, try writing:
```typescript
const totalLocations = await prisma.location.count();
totalLocations.name; // TypeScript error: Property 'name' does not exist on type 'number'
```
TypeScript catches this immediately. Without Prisma's types, this would be a runtime bug.

**Experiment 3 — Turn off query logging temporarily**
In `backend/src/lib/prisma.ts`, change `'development'` to `'production'` temporarily
and watch the terminal. The SQL line disappears. Change it back.

**Experiment 4 — Count a different model**
Try writing a route that counts items instead of locations:
```typescript
const totalItems = await prisma.item.count();
```
Everything works identically — same pattern, different model.

---

### Key Takeaways from Task 3

| Concept | What was learned |
|---|---|
| ORM | A library that translates TypeScript method calls into SQL queries automatically |
| `prisma.model.count()` | Generates `SELECT COUNT(*)` — always prefer over `findMany().length` |
| `async` route handler | Required whenever using `await` inside the handler |
| `await` | Pauses the current function until the Promise resolves — does NOT block Node.js |
| Event loop | Node.js handles many requests concurrently with one thread by never blocking on I/O |
| Connection pool | Pre-established database connections reused across requests — why the singleton matters |
| Prisma query logging | `log: ['query']` in the Prisma client config reveals the SQL generated. Development only |
| Prisma type safety | Every method returns a fully-typed result — TypeScript knows the shape before runtime |
| `express-async-errors` | Automatically catches errors thrown in async handlers — no manual try/catch needed |

---

### Self-Check Questions

1. Why must the route handler be declared `async` when using `prisma.location.count()`?
2. What would happen if you removed `await` and wrote `prisma.location.count()` without it?
3. Why does the terminal show a SQL query when you visit `/api/locations/count`?
4. What SQL does `prisma.location.count()` generate? Where did you see proof of this?
5. Why is `prisma.location.count()` better than `(await prisma.location.findMany()).length`?
6. Where does the `prisma` object come from in `locations.ts`?
7. If the database goes down while a request is being handled, what does the client receive?
8. What TypeScript type does `prisma.location.count()` return?
9. What is a connection pool and why does it matter?
10. If you added `router.get('/count', ...)` below `router.use(authenticate)`, what would happen when you visit it in a browser?

---

### Engineering Perspective — Why this matters in a real project

**ORMs are the standard in modern backend development.** Whether it is Prisma (TypeScript),
SQLAlchemy (Python), ActiveRecord (Ruby), or Hibernate (Java) — the same concept applies.
Understanding how an ORM translates your code into SQL, and how to read that SQL when
debugging, is a core backend engineering skill.

**Async/await is non-negotiable in Node.js backends.** Every I/O operation — database
queries, file reads, external API calls, cache lookups — is asynchronous. Without
understanding the event loop and async/await, Node.js code becomes impossible to
reason about. Every route in this codebase is async for exactly this reason.

**Query efficiency matters at scale.** The difference between `count()` and `findMany().length`
is irrelevant at 10 records. At 10 million records, it is the difference between a
2ms response and a 30-second response that crashes the server. Choosing the right
Prisma method is the first level of database performance optimization.

**Observability — seeing the SQL.** The `prisma:query` log in the terminal is a form
of observability — the ability to see what your system is doing. In production, these
logs would go to CloudWatch (as configured in the Terraform files) where engineers
can search for slow queries, unexpected queries, or query patterns during incidents.

---

### Interview Perspective

**Common question:** "What is an ORM and what are the trade-offs?"

What the interviewer is testing: Whether you understand that ORMs improve developer
productivity and type safety but can generate inefficient SQL if used carelessly.
Strong candidates also mention that raw SQL is sometimes necessary for complex queries.

**Common question:** "How does Node.js handle thousands of concurrent requests with a single thread?"

What the interviewer is testing: Understanding of the event loop. The answer: Node.js
uses non-blocking I/O. When waiting for a database or network response, the event loop
handles other requests. The single thread is only "busy" when executing JavaScript —
which is fast. Waiting for I/O does not occupy the thread.

**Common question:** "What is a database connection pool?"

What the interviewer is testing: Awareness that database connections are expensive
resources. Connection pools keep a fixed set of connections open and reuse them,
rather than opening and closing a connection on every request.

---

*Task 4 will be documented here once completed.*
