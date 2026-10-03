// ============================================================
// FILE: backend/src/routes/items.ts
// CONSTRUCTION ORDER: #20
// HOW: touch src/routes/items.ts
// WHY NOW: Written after locations.ts (simpler template) but before dashboard.ts.
//          Items (the product catalog) are referenced by inventory, work orders,
//          and transfers — they need to exist before those features.
// WHAT THIS FILE ADDS BEYOND locations.ts:
//   - Paginated list with text search across multiple fields
//   - Partial update pattern (PUT with optional body fields)
//   - `mode: 'insensitive'` for case-insensitive search
//   - Dynamic `where` object for optional filters
//   - Promise.all for running two queries simultaneously
// ============================================================

import { Router, Response } from 'express';
// body — validates body fields
// param — validates URL :id parameter
// query — validates query string parameters (?page=1&limit=20&search=steel)
import { body, param, query } from 'express-validator';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
import { Role } from '@prisma/client';

const router = Router();
router.use(authenticate);  // All item endpoints require authentication

const OPS_ADMIN = [Role.ADMIN, Role.OPERATIONS];  // Can create and update items
const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];  // Can read items

// ── GET /api/items ─────────────────────────────────────────────────────────────
// Paginated list with optional text search.
router.get(
  '/',
  authorize(...ALL_ROLES),
  [
    // query('page') — validates the `page` query parameter (?page=2)
    // .optional() — if not provided, the handler uses default value '1'
    // .isInt({ min: 1 }) — if provided, must be integer >= 1
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    // .isString() — if search is provided, it must be a string (not a number/object)
    query('search').optional().isString(),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    // Parse pagination params from query strings (they arrive as strings).
    // ?? '1' — default to page 1 if not provided.
    // `as string` cast — req.query values are `string | string[] | ParsedQs`;
    // we assert it's a simple string because our validation confirmed it.
    // parseInt(value, 10) — converts "2" → 2. The second argument (radix=10) is important:
    //   parseInt('010') without radix → 8 in old browsers (octal)
    //   parseInt('010', 10) → 10 (decimal) — always correct.
    const page = parseInt((req.query.page as string) ?? '1', 10);
    const limit = parseInt((req.query.limit as string) ?? '20', 10);
    const search = (req.query.search as string) ?? '';
    const skip = (page - 1) * limit;  // How many records to skip for this page

    // Build the `where` clause conditionally.
    // If search is empty → where = {} → fetch all items
    // If search is provided → where uses OR to search across multiple fields
    const where = search
      ? {
        // OR: [...] — at least ONE of these conditions must be true.
        // This gives us cross-field text search in one query.
        OR: [
          // { fieldName: { contains: value, mode: 'insensitive' } }
          // contains: partial match (like SQL LIKE '%steel%')
          // mode: 'insensitive' — case-insensitive match (PostgreSQL: ILIKE)
          //   Without mode, Prisma uses exact case. 'insensitive' requires
          //   PostgreSQL (not SQLite) — which is why `as const` is needed:
          //   TypeScript would infer 'insensitive' as string, but Prisma
          //   expects the literal type 'insensitive'.
          { name: { contains: search, mode: 'insensitive' as const } },
          { sku: { contains: search, mode: 'insensitive' as const } },
          { category: { contains: search, mode: 'insensitive' as const } },
        ],
      }
      : {};  // Empty object = no filter = all items

    // Promise.all([p1, p2]) — runs BOTH promises simultaneously (in parallel).
    // Without Promise.all, the count query would wait for findMany to finish first.
    // With Promise.all, both queries hit the database at the same time.
    // Destructuring assigns: items = result of findMany, total = result of count.
    const [items, total] = await Promise.all([
      prisma.item.findMany({
        where,
        skip,     // OFFSET: skip (page-1)*limit records
        take: limit,  // LIMIT: return at most `limit` records
        orderBy: { name: 'asc' },  // Consistent alphabetical order
      }),
      prisma.item.count({ where }),  // Same where clause, just COUNT(*)
    ]);

    return res.json({
      success: true,
      data: items,
      // meta provides pagination info the frontend uses to render page controls
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  }
);

// ── POST /api/items ────────────────────────────────────────────────────────────
// Creates a new item in the product catalog.
router.post(
  '/',
  authorize(...OPS_ADMIN),
  [
    body('name').notEmpty().withMessage('Item name is required.').trim(),
    body('sku').notEmpty().withMessage('SKU is required.').trim(),
    body('category').optional().isString().trim(),
    // .isFloat({ min: 0 }) — price must be a non-negative number.
    // Validates both integer and decimal inputs (5, 5.50, 0, etc.)
    body('unitPrice').isFloat({ min: 0 }).withMessage('Unit price must be a non-negative number.'),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { name, sku, category, unitPrice } = req.body as {
      name: string;
      sku: string;
      category?: string;
      unitPrice: number;
    };

    // If sku already exists, Prisma throws P2002 → errorHandler returns 409 Conflict.
    const item = await prisma.item.create({
      data: { name, sku, category, unitPrice },
    });

    return res.status(201).json({ success: true, data: item });
  }
);

// ── GET /api/items/:id ─────────────────────────────────────────────────────────
router.get(
  '/:id',
  authorize(...ALL_ROLES),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const item = await prisma.item.findUnique({ where: { id: req.params.id } });
    if (!item) throw new AppError(404, 'Item not found.');
    return res.json({ success: true, data: item });
  }
);

// ── PUT /api/items/:id ─────────────────────────────────────────────────────────
// PARTIAL UPDATE — updates only the fields provided in the request body.
// Uses PUT (replace semantics) but implements PATCH behaviour (partial update)
// because only name/category/price are updatable (not sku — that's immutable).
router.put(
  '/:id',
  authorize(...OPS_ADMIN),
  [
    param('id').notEmpty(),
    // All body fields are optional — caller can update just one field.
    // .optional().notEmpty() means: "if provided, must not be empty string."
    body('name').optional().notEmpty().trim(),
    body('category').optional().isString().trim(),
    body('unitPrice').optional().isFloat({ min: 0 }),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    // All fields typed as optional — any might be undefined.
    const { name, category, unitPrice } = req.body as {
      name?: string;
      category?: string;
      unitPrice?: number;
    };

    // Build the update data object dynamically.
    // For each field: only include it if the caller provided it.
    // Pattern: ...(condition && { key: value })
    //   If name is not undefined → spread { name: value } into data
    //   If name IS undefined → spread `false` → spread of false is a no-op in JS
    // This prevents accidentally overwriting a field with undefined.
    const item = await prisma.item.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(category !== undefined && { category }),
        ...(unitPrice !== undefined && { unitPrice }),
      },
    });
    // Prisma throws P2025 if the item ID doesn't exist → errorHandler returns 404.

    return res.json({ success: true, data: item });
  }
);

export default router;
