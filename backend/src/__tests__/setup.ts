// ============================================================
// FILE: backend/src/__tests__/setup.ts
// CONSTRUCTION ORDER: #28 — First test file, written before any test
// HOW: mkdir -p src/__tests__ && touch src/__tests__/setup.ts
// WHY THIS FILE EXISTS:
//   All test files import `app` from '../app'.
//   When `app` is imported, it imports `prisma` from '../lib/prisma'.
//   When `prisma` is imported, it reads `process.env.DATABASE_URL`.
//   If DATABASE_URL points to the development database, tests would:
//     1. Corrupt development data
//     2. Conflict with the running dev server
//     3. Fail when run in CI (no dev DB exists there)
//
//   This file sets the CORRECT environment variables BEFORE any module
//   reads them. Every test file starts with: import './setup'
//   which runs this file first, overriding the env vars before the
//   Prisma client is created.
//
// HOW IT WORKS:
//   JavaScript/Node.js module execution is synchronous at the top level.
//   `import './setup'` runs this entire file before the next import line.
//   process.env mutations happen immediately and affect all subsequent imports.
// ============================================================

/**
 * Global test setup — loaded first by every test file via `import './setup'`.
 * Overrides env vars so all tests run against the dedicated test DB
 * and use a known JWT secret.
 */

// ── Override DATABASE_URL to point at the TEST database ───────────────────────
// The test database (ops_erp_test) is a completely separate database from
// the development database (ops_erp). Tests create, modify, and delete real
// data — they must NOT touch development data.
//
// In CI (.gitlab-ci.yml backend:test job):
//   A fresh postgres:15-alpine container is spun up for each CI run.
//   TEST_DATABASE_URL is set as a CI variable pointing to this fresh DB.
//
// In local development:
//   The developer must have a separate ops_erp_test database.
//   The fallback URL uses 'erp_user' with devpassword123 on localhost.
//
// process.env assignment at the top level — runs before any test imports.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://erp_user:devpassword123@localhost:5432/ops_erp_test?schema=public';

// ── Override JWT_SECRET with a known test value ────────────────────────────────
// Tests need to generate JWTs (for authentication headers) and verify them.
// Using a fixed, known secret makes this deterministic and independent of .env.
// This string is hardcoded — it's NOT a security risk because it's only used
// in tests against the test database. Never deployed to production.
process.env.JWT_SECRET = 'test_secret_do_not_use_in_production_abcdef1234567890';

// ── Override NODE_ENV to 'test' ────────────────────────────────────────────────
// Some code branches on NODE_ENV:
//   - prisma.ts: 'test' is not 'production', so Prisma won't store on globalThis
//   - logger.ts: affects log level default
//   - index.ts: won't refuse to start for missing JWT_SECRET in production mode
process.env.NODE_ENV = 'test';

// ── Suppress log output during tests ──────────────────────────────────────────
// Without this, every test request would print morgan access logs and Prisma
// query logs to the terminal, making test output extremely noisy and hard to read.
// 'error' means: only show ERROR level logs (and above). No info, no debug, no warn.
process.env.LOG_LEVEL = 'error';
