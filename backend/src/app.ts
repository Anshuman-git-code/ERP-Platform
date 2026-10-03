// ============================================================
// FILE: backend/src/app.ts
// CONSTRUCTION ORDER: #26 — First of the two wiring files
// HOW: touch src/app.ts
// WHY NOW: Can only be written AFTER all route files exist, because it
//          imports every route module. If any route import is missing,
//          TypeScript would error at compile time.
// WHY SEPARATE FROM index.ts:
//   app.ts creates and configures the Express application.
//   index.ts starts the server (listens on a port).
//   TESTS import `app` directly — they need the Express app but do NOT
//   want to actually start a network server. By separating them:
//     - Tests: import app from '../app'  (no server started)
//     - Production: index.ts imports app and calls app.listen()
// ============================================================

// ── VERY FIRST IMPORT: express-async-errors ───────────────────────────────────
// This MUST be the first import in the entire file, before `express` is imported.
// WHY: express-async-errors works by monkey-patching (modifying at runtime)
//      Express's Router.prototype.handle method. For the patch to take effect,
//      it must run BEFORE Express's Router is first used.
// WHAT IT DOES: Wraps every async route handler in .catch(next), so that:
//   throw new AppError(404, '...') inside an async handler automatically calls
//   next(err) which routes the error to errorHandler.ts.
//   Without this package, `throw` in an async handler would silently produce
//   an unhandled Promise rejection and Express would return nothing to the client.
import 'express-async-errors';

// Standard Express imports.
import express from 'express';
// cors — sets Access-Control-Allow-Origin headers for browser cross-origin requests.
import cors from 'cors';
// morgan — HTTP request logging middleware.
import morgan from 'morgan';

// ── Route imports (all default exports from their files) ───────────────────────
// Each route file exports `export default router`.
// Here we import them with descriptive names (not just `router`).
// These names are entirely local — they're just what we call them in this file.
import authRoutes from './routes/auth';
import locationRoutes from './routes/locations';
import itemRoutes from './routes/items';
import inventoryRoutes from './routes/inventory';
import workOrderRoutes from './routes/workOrders';
import transferRoutes from './routes/transfers';
import orderRoutes from './routes/orders';
import dashboardRoutes from './routes/dashboard';

// ── Shared module imports ──────────────────────────────────────────────────────
import { errorHandler } from './middleware/errorHandler';
import { logger } from './lib/logger';

// ── Create the Express application ────────────────────────────────────────────
// express() returns an Application instance — the central object of an Express app.
// We configure it by calling app.use(), app.set(), app.get(), etc.
const app = express();

// ── Trust proxy ───────────────────────────────────────────────────────────────
// app.set('trust proxy', 1) tells Express to trust the X-Forwarded-For header
// from the FIRST proxy in front of it (the AWS ALB in production).
// Without this:
//   - req.ip would show the ALB's private IP instead of the client's real IP
//   - Rate limiting libraries would throttle based on the ALB's IP, not the client
// The `1` means "trust exactly one hop of proxies."
app.set('trust proxy', 1);

// ── CORS middleware ────────────────────────────────────────────────────────────
// CORS (Cross-Origin Resource Sharing) — browsers enforce same-origin policy.
// Without this middleware, the React frontend (localhost:3000) cannot make
// requests to the Express backend (localhost:4000) — the browser blocks them.
// The server must explicitly allow cross-origin requests via these headers.
const allowedOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
app.use(cors({
  origin: allowedOrigin,  // Only allow requests from this specific origin
  credentials: true,       // Allow cookies and Authorization headers in cross-origin requests
}));

// ── HTTP request logging ───────────────────────────────────────────────────────
// morgan is an HTTP request logger.
// 'combined' is the Apache combined log format:
//   ::1 - - [26/Sep/2026:10:00:00 +0000] "GET /api/inventory HTTP/1.1" 200 1234
//
// stream: { write: ... } — redirects morgan's output THROUGH winston.
// Without this, morgan would call console.log directly.
// With this, all logs (HTTP + app) flow through the same structured winston pipeline.
// message.trim() removes the trailing newline that morgan appends.
app.use(
  morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

// ── Body parsing middleware ────────────────────────────────────────────────────
// express.json() — parses incoming requests with Content-Type: application/json.
// Populates req.body with the parsed JavaScript object.
// limit: '1mb' — rejects request bodies larger than 1MB (prevents memory exhaustion attacks).
// Without this middleware, req.body would always be undefined.
app.use(express.json({ limit: '1mb' }));

// express.urlencoded() — parses URL-encoded bodies (HTML form submissions).
// extended: true — uses the `qs` library which handles nested objects.
app.use(express.urlencoded({ extended: true }));

// ── Health check endpoint ──────────────────────────────────────────────────────
// GET /health — NOT behind any authentication middleware.
// Used by:
//   - Docker HEALTHCHECK (docker-compose.yml)
//   - AWS ALB target group health checks (compute.tf)
//   - ECS container health check (compute.tf container definition)
//   - Monitoring scripts
// Returns 200 when healthy, 503 when database is unreachable.
app.get('/health', async (_req, res) => {
  const start = Date.now();
  let dbStatus = 'ok';
  let dbLatencyMs = 0;

  try {
    // Dynamic import — imports prisma only when this endpoint is called.
    // WHY dynamic: avoids potential circular import issues during app startup.
    // prisma.$queryRaw`SELECT 1` is the simplest possible DB query.
    // If the DB is unreachable, this throws an error.
    const { prisma } = await import('./lib/prisma');
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - start;  // How long the DB query took in milliseconds
  } catch {
    dbStatus = 'unreachable';
    // If the DB is down, we still respond (don't throw) — just with status: 'degraded'
  }

  const healthy = dbStatus === 'ok';

  // 200 when healthy, 503 (Service Unavailable) when degraded.
  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),  // Seconds since the process started
    version: process.env.npm_package_version ?? '1.0.0',
    environment: process.env.NODE_ENV ?? 'development',
    database: { status: dbStatus, latencyMs: dbLatencyMs },
  });
});

// ── Route mounting ─────────────────────────────────────────────────────────────
// app.use(prefix, router) mounts a router at a URL prefix.
// All routes defined in the router will be prefixed with the given path.
// Example: authRoutes has router.post('/login', ...) → becomes POST /api/auth/login
// The ORDER matters only for middleware that applies broadly.
// Route handlers are specific enough that order doesn't affect correctness here.
app.use('/api/auth', authRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/work-orders', workOrderRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/dashboard', dashboardRoutes);

// ── 404 catch-all ─────────────────────────────────────────────────────────────
// This middleware runs only if NO route above matched the request.
// It MUST be registered AFTER all real routes.
// _req — underscore prefix = intentionally unused parameter (request is irrelevant here)
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ── Centralized error handler ──────────────────────────────────────────────────
// errorHandler MUST be the LAST middleware registered.
// WHY: Express identifies error handlers by the 4-parameter signature (err, req, res, next).
//      Express calls the FIRST matching error handler it finds.
//      If registered before routes, it would catch errors that haven't happened yet.
//      If registered after routes but before 404, some errors might be swallowed by 404.
//      Being LAST ensures it catches everything that routes and 404 don't handle.
app.use(errorHandler);

// Export the configured app as the default export.
// index.ts imports this and calls app.listen(PORT, ...).
// Test files import this to make HTTP requests via supertest.
export default app;
