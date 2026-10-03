// ============================================================
// FILE: backend/src/routes/locations.ts
// CONSTRUCTION ORDER: #19 — Second route file
// HOW: touch src/routes/locations.ts
// WHY NOW: Written immediately after auth.ts because:
//   1. It is the simplest possible CRUD route — only 3 endpoints, no transactions
//   2. It establishes the TEMPLATE that ALL subsequent route files follow
//   3. Locations are referenced by inventory, work orders, transfers, and orders —
//      the data must exist before those routes are meaningful
// WHAT THIS FILE TEACHES:
//   - The standard route file structure (router + middleware + handler pattern)
//   - router.use(authenticate) applying middleware to all routes in one line
//   - Role-based access control with role constant arrays
//   - The authorize(...ALL_ROLES) spread pattern
//   - Basic Prisma CRUD: findMany, create, findUnique
//   - AppError for 404 responses
//   - `export default router` pattern
// ============================================================

import { Router, Response } from 'express';
// body — validates request body fields
// param — validates URL path parameters (e.g., :id)
import { body, param } from 'express-validator';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
// Role is the TypeScript enum generated from schema.prisma by `prisma generate`.
import { Role } from '@prisma/client';

// Create the router instance for this feature.
const router = Router();

// router.use(authenticate) — applies authenticate to EVERY route below this line.
// Written ONCE here instead of on every individual router.get/post/patch call.
// This means ALL location endpoints require a valid JWT.
// The one exception in the whole codebase is auth.ts (login doesn't need auth).
router.use(authenticate);

// Role constant arrays — defined once at the top of the file.
// Spreading these into authorize() makes each route's permission requirement
// immediately readable: `authorize(...ADMIN_ONLY)` tells you exactly who can access.
// Using arrays (not individual calls) makes it easy to add a role later —
// just add it to the array in one place.
const ADMIN_ONLY = [Role.ADMIN];
const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

// ── GET /api/locations ────────────────────────────────────────────────────────
// Returns ALL locations (no pagination).
// Locations are a small, stable list (tens of records, not thousands).
// Pagination would add complexity with no benefit here.
router.get(
  '/',
  // authorize(...ALL_ROLES) — EVERY logged-in user can read locations.
  // The spread `...` unpacks [Role.ADMIN, Role.OPERATIONS, Role.SALES] into
  // three arguments: authorize(Role.ADMIN, Role.OPERATIONS, Role.SALES)
  authorize(...ALL_ROLES),

  // _req — underscore prefix = intentionally unused parameter.
  // The handler receives req but doesn't use it (no filtering or req.user needed).
  // ESLint's argsIgnorePattern: "^_" rule allows this without a warning.
  async (_req, res: Response) => {
    const locations = await prisma.location.findMany({
      // orderBy: { name: 'asc' } — alphabetical order for consistent UI display
      orderBy: { name: 'asc' },
    });
    return res.json({ success: true, data: locations });
  }
);

// ── POST /api/locations ───────────────────────────────────────────────────────
// Creates a new location. ADMIN only — location setup is a system admin task.
router.post(
  '/',
  authorize(...ADMIN_ONLY),  // Only ADMIN can create locations
  [
    // body('name') — the location name is required and must not be empty.
    // .trim() — removes leading/trailing whitespace before validation and storage.
    body('name').notEmpty().withMessage('Location name is required.').trim(),
    // body('address') — optional string field.
    // .optional() tells express-validator: "skip this rule if the field is absent."
    // .isString() — if provided, must be a string (rejects numbers, arrays, etc.)
    body('address').optional().isString().trim(),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    // Destructure req.body with explicit type annotation.
    // address?: string uses optional type — it may be undefined if not sent.
    const { name, address } = req.body as { name: string; address?: string };

    // prisma.location.create() — INSERT INTO locations (name, address)
    // If `name` already exists, Prisma throws P2002 (unique constraint violation).
    // errorHandler.ts catches P2002 and returns HTTP 409 Conflict automatically.
    const location = await prisma.location.create({
      data: { name, address },
    });

    // 201 Created — standard HTTP status for successful resource creation.
    return res.status(201).json({ success: true, data: location });
  }
);

// ── GET /api/locations/:id ────────────────────────────────────────────────────
// Returns a single location by ID.
router.get(
  '/:id',  // :id is a URL path parameter — captured as req.params.id
  authorize(...ALL_ROLES),
  // param('id') — validates the :id path parameter (not body, not query).
  // .notEmpty() — rejects requests where :id is an empty string.
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    // prisma.location.findUnique() → returns the matching record or null.
    // where: { id: req.params.id } — looks up by primary key.
    const location = await prisma.location.findUnique({
      where: { id: req.params.id },
    });

    // If null → no location with this ID exists → 404 Not Found.
    // `throw` here works because express-async-errors automatically calls next(err).
    if (!location) throw new AppError(404, 'Location not found.');

    return res.json({ success: true, data: location });
  }
);

// Export the router as the default export so app.ts can import and mount it.
export default router;
