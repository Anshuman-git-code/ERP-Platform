// ============================================================
// FILE: backend/src/index.ts
// CONSTRUCTION ORDER: #27 — The process entry point, written last among src/ files
// HOW: touch src/index.ts
// WHY LAST: Written after app.ts. This file's only job is to START the server.
//           It can only do that once app.ts (the Express app) is complete.
// WHY SEPARATE FROM app.ts:
//   This is the process entry point — it starts the OS-level server process.
//   Tests import `app` (from app.ts) WITHOUT starting a server.
//   If server startup code were inside app.ts, tests would start a real
//   network server every time they ran — causing port conflicts and slowness.
//   Keeping startup here preserves app.ts as a pure "Express app object."
// ============================================================

// FIRST IMPORT: dotenv/config — loads .env file into process.env IMMEDIATELY.
// Every subsequent import that reads process.env (logger, prisma, app) will see
// the environment variables from .env. If this import came after any of those,
// those modules would read undefined and use their fallback values instead.
import 'dotenv/config';

// Import the configured Express application (routes, middleware, error handler).
import app from './app';
// Import the singleton Prisma client for database connectivity check.
import { prisma } from './lib/prisma';
// Import the logger for startup messages.
import { logger } from './lib/logger';

// Read the PORT from environment variables.
// parseInt(value, 10) converts the string "4000" to the number 4000.
// ?? '4000' — default to port 4000 if PORT is not set.
const PORT = parseInt(process.env.PORT ?? '4000', 10);

// ── main() — the startup function ─────────────────────────────────────────────
// WHY async: We need to await the database connection check before starting.
// WHY named `main()`: Convention for the top-level entry function in Node.js scripts.
// WHY NOT top-level await: This project uses CommonJS modules
//   ("module": "commonjs" in tsconfig.json).
//   Top-level await only works in ES modules (type: "module" in package.json).
//   In CommonJS, the entire file must be synchronous at the top level.
//   Wrapping in an async function and calling it is the standard workaround.
async function main() {

  // ── Step 1: Security check ─────────────────────────────────────────────────
  // Refuse to start in production with an insecure JWT secret.
  // The dev fallback string is hardcoded in auth.ts and auth middleware —
  // using it in production would mean anyone who reads the source code
  // could forge valid JWTs for any user.
  const jwtSecret = process.env.JWT_SECRET ?? '';
  if (process.env.NODE_ENV === 'production') {
    if (!jwtSecret || jwtSecret === 'dev_secret_change_in_production') {
      logger.error(
        'JWT_SECRET is not set or is using the insecure dev fallback. ' +
        'Refusing to start in production.'
      );
      // process.exit(1) terminates the Node.js process with error code 1.
      // Code 1 signals failure to the shell, Docker, and ECS health checks.
      process.exit(1);
    }
  } else if (!jwtSecret) {
    // In development, allow missing JWT_SECRET but log a warning.
    logger.warn('JWT_SECRET is not set — using insecure dev fallback. Never use this in production.');
  }

  // ── Step 2: Database connectivity check ───────────────────────────────────
  // Verify the database is reachable BEFORE starting the HTTP server.
  // Without this check, the server might start and immediately fail every
  // request with a Prisma connection error, which is harder to diagnose.
  try {
    // prisma.$connect() — explicitly opens the database connection pool.
    // Prisma normally connects lazily on first query, but connecting explicitly
    // here lets us catch connection failures early, before accepting traffic.
    await prisma.$connect();
    logger.info('Database connection established');
  } catch (err) {
    logger.error('Failed to connect to database', { error: err });
    process.exit(1);  // Exit with error — no point starting a server without a database
  }

  // ── Step 3: Start the HTTP server ─────────────────────────────────────────
  // app.listen(PORT, callback) starts the server.
  // The callback runs once the server is ready to accept connections.
  // `server` is the http.Server instance (used for graceful shutdown below).
  const server = app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT} [${process.env.NODE_ENV ?? 'development'}]`);
  });

  // ── Step 4: Graceful shutdown ──────────────────────────────────────────────
  // WHY GRACEFUL SHUTDOWN:
  //   When Docker stops a container (docker stop), ECS scales down a task,
  //   or a deployment replaces old containers, the OS sends SIGTERM to the process.
  //   A naive process.exit() would kill in-flight requests mid-response.
  //   Graceful shutdown:
  //     1. Stops accepting new connections
  //     2. Waits for existing requests to finish
  //     3. Closes the database connection pool cleanly
  //     4. THEN exits
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully`);

    // server.close(callback) — stops accepting new HTTP connections.
    // The callback fires once all existing connections are finished.
    server.close(async () => {
      await prisma.$disconnect();  // Return DB connections to the pool and close
      logger.info('Database disconnected');
      process.exit(0);  // Exit with code 0 = success (clean shutdown)
    });
  };

  // SIGTERM — sent by Docker/ECS when stopping a container (docker stop, ECS scaling)
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // SIGINT — sent by Ctrl+C in the terminal during development
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ── Execute main() ─────────────────────────────────────────────────────────────
// Call main() immediately. It returns a Promise.
// .catch() handles any error thrown during startup that wasn't caught inside main().
// This is the outermost error boundary for the entire startup sequence.
main().catch((err) => {
  logger.error('Startup failed', { error: err });
  process.exit(1);
});
