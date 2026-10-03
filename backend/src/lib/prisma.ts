// ============================================================
// FILE: backend/src/lib/prisma.ts
// CONSTRUCTION ORDER: #13
// HOW: touch src/lib/prisma.ts then filled in.
// WHY NOW: Written right after logger.ts because:
//   1. It has no project-file dependencies (only imports @prisma/client)
//   2. Every route file needs it to query the database
//   3. The singleton pattern must be established before any route creates
//      its own PrismaClient — having multiple clients exhausts the DB pool
// ============================================================

// Import PrismaClient from the generated @prisma/client package.
// This package was created by running `npx prisma generate` after writing schema.prisma.
// PrismaClient is the TypeScript database query library — it provides:
//   prisma.user.findUnique(), prisma.inventory.findMany(), prisma.$transaction(), etc.
// All these methods are fully typed based on schema.prisma.
import { PrismaClient } from '@prisma/client';

// ── The Singleton Pattern ─────────────────────────────────────────────────────
//
// PROBLEM: ts-node-dev (used for `npm run dev`) hot-reloads modules when files change.
// Each hot-reload re-executes module code from scratch.
// Without this pattern: every file save creates a NEW PrismaClient instance.
// PrismaClient opens a connection pool to PostgreSQL.
// After 10 hot-reloads → 10 connection pools → PostgreSQL's connection limit is hit.
// Result: "too many clients" error and the app crashes.
//
// SOLUTION: Store the PrismaClient on `globalThis`.
// globalThis persists across module hot-reloads in ts-node-dev.
// On first load: no prisma on globalThis → create new PrismaClient → store it
// On subsequent hot-reloads: prisma already on globalThis → reuse it
//
// In production (ECS): no hot-reloads occur, so the guard is never triggered.
// The `if (process.env.NODE_ENV !== 'production')` line below ensures we
// don't pollute globalThis in production.

// Step 1: Cast globalThis to a custom shape.
// `globalThis` is typed as `typeof globalThis` in TypeScript — it has many
// built-in properties (Math, console, etc.) but no `prisma` property.
// TypeScript refuses a direct cast because the shapes are too different.
// The solution: cast THROUGH `unknown` first:
//   `as unknown` — erases ALL type information (unsafe escape hatch)
//   `as { prisma: PrismaClient | undefined }` — re-asserts the custom shape
// This double cast is intentional — we KNOW globalThis can have a prisma
// property even though TypeScript doesn't know it by default.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;  // undefined on first load, PrismaClient after
};

// Step 2: Create or reuse the PrismaClient.
// The ?? (nullish coalescing) operator:
//   If globalForPrisma.prisma is NOT undefined → use it (reuse existing client)
//   If globalForPrisma.prisma IS undefined    → create a new PrismaClient
//
// TypeScript infers `prisma` as `PrismaClient` from the right-hand side of ??.
// (The left side is `PrismaClient | undefined`, the right side is `PrismaClient`,
// so the result type is `PrismaClient` — TypeScript knows the undefined case is handled.)
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // log — what Prisma should print to the console.
    // In development: log every SQL query AND errors AND warnings.
    //   This helps you see what SQL Prisma generates for your queries.
    //   Example: prisma:query SELECT * FROM "users" WHERE "email" = $1
    // In production: only log errors (no query spam in production logs).
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

// Step 3: Store the client on globalThis (only in non-production environments).
// In production: NODE_ENV === 'production', so this block is skipped.
//   The condition is false → prisma is NOT stored on globalThis → no global state
// In development: stores the client so hot-reloads can reuse it.
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
