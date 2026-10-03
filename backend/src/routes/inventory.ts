// ============================================================
// FILE: backend/src/routes/inventory.ts
// CONSTRUCTION ORDER: #22
// HOW: touch src/routes/inventory.ts
// WHY NOW: Written after items.ts and locations.ts because inventory records
//          reference both items and locations. The lookup validations in POST /
//          (verify item exists, verify location exists) need those tables to exist.
// WHAT THIS FILE INTRODUCES (new concepts beyond previous routes):
//   - The `withAvailable()` helper — computing derived fields without storing them
//   - `Record<string, unknown>` for dynamic where clauses
//   - `prisma.$transaction(async (tx) => {...})` — database transactions
//   - `tx.$queryRaw<T>` — raw SQL with TypeScript generics for type-safe results
//   - `FOR UPDATE` — PostgreSQL row-level locking
//   - Idempotency keys via the referenceKey field
//   - `req.user!.userId` — the non-null assertion operator
// ============================================================

import { Router, Response } from 'express';
import { body, param, query } from 'express-validator';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
// TransactionType is the Prisma enum: TransactionType.IN and TransactionType.OUT
import { Role, TransactionType } from '@prisma/client';

const router = Router();
router.use(authenticate);

const OPS_ADMIN = [Role.ADMIN, Role.OPERATIONS];
const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

// ── withAvailable() helper ────────────────────────────────────────────────────
// A pure function that adds the computed `availableQty` field to any inventory object.
//
// PARAMETER TYPE: { physicalQty: number; reservedQty: number }
// This is an INLINE OBJECT TYPE — not an interface, not a type alias.
// It is intentionally NARROW — only declares the two fields this function needs.
// TypeScript's structural typing means any object with at least these two fields
// will match, including full Inventory records from Prisma.
//
// RETURN TYPE: Inferred by TypeScript.
// The spread { ...inv } copies all of inv's fields.
// Adding availableQty creates a new object with all of inv's fields PLUS availableQty.
// TypeScript infers the full return type automatically.
//
// WHY NOT STORE availableQty IN THE DATABASE?
// Because physicalQty and reservedQty are updated independently by different operations.
// If we stored availableQty, we'd need to update THREE columns whenever stock changes.
// That risks the three values getting out of sync. Computing it on read is always correct.
function withAvailable(inv: { physicalQty: number; reservedQty: number }) {
  return { ...inv, availableQty: inv.physicalQty - inv.reservedQty };
}

// ── GET /api/inventory ────────────────────────────────────────────────────────
// Paginated list with optional filtering by locationId and/or itemId.
router.get(
  '/',
  authorize(...ALL_ROLES),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('locationId').optional().isString(),
    query('itemId').optional().isString(),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const page = parseInt((req.query.page as string) ?? '1', 10);
    const limit = parseInt((req.query.limit as string) ?? '20', 10);
    const skip = (page - 1) * limit;

    // Record<string, unknown> — a TypeScript utility type for an object
    // with string keys and values of any type.
    // We start with an empty object and add fields conditionally.
    // This is because Prisma's `where` type would need to be typed precisely,
    // but since we're building it dynamically, `Record<string, unknown>` is
    // the pragmatic choice that tells TypeScript: "this will have string keys."
    const where: Record<string, unknown> = {};
    // Only add the filter if the query param was provided.
    // If we always added them (even when undefined), Prisma would filter for undefined,
    // which isn't what we want.
    if (req.query.locationId) where.locationId = req.query.locationId;
    if (req.query.itemId) where.itemId = req.query.itemId;

    const [records, total] = await Promise.all([
      prisma.inventory.findMany({
        where,
        skip,
        take: limit,
        // `include` — JOIN related tables and include their fields in the response.
        // `select` within include — only fetch the specific fields we need (not the whole row).
        // This reduces data transfer from the database.
        include: {
          item: { select: { id: true, name: true, sku: true, category: true, unitPrice: true } },
          location: { select: { id: true, name: true } },
        },
        // orderBy with nested field — sorts by the related location's name, then item's name.
        // This gives a predictable "Warehouse A / Bolts, Warehouse A / Steel Rods, ..." order.
        orderBy: [{ location: { name: 'asc' } }, { item: { name: 'asc' } }],
      }),
      prisma.inventory.count({ where }),
    ]);

    return res.json({
      success: true,
      // .map(withAvailable) — applies withAvailable to EVERY record in the array.
      // Each record gets an added `availableQty` field before being sent.
      data: records.map(withAvailable),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  }
);

// ── POST /api/inventory ───────────────────────────────────────────────────────
// Creates a new inventory record for a specific item+location+batch combination.
router.post(
  '/',
  authorize(...OPS_ADMIN),
  [
    body('itemId').notEmpty().withMessage('itemId is required.'),
    body('locationId').notEmpty().withMessage('locationId is required.'),
    body('batchNumber').optional().isString().trim(),
    // .isInt({ min: 0 }) — physicalQty can be 0 (empty location row)
    body('physicalQty').isInt({ min: 0 }).withMessage('physicalQty must be a non-negative integer.'),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { itemId, locationId, physicalQty, batchNumber } = req.body as {
      itemId: string;
      locationId: string;
      physicalQty: number;
      batchNumber?: string;  // Optional — if not provided, defaults to 'DEFAULT'
    };

    // If batchNumber was provided but is empty string after trimming, use 'DEFAULT'.
    // ?. — optional chaining: only calls .trim() if batchNumber is not undefined.
    // || 'DEFAULT' — if result is falsy (empty string), use 'DEFAULT'.
    const batch = batchNumber?.trim() || 'DEFAULT';

    // Verify both referenced records exist BEFORE trying to create the inventory row.
    // If itemId doesn't exist, the foreign key constraint would throw an error anyway,
    // but we give a cleaner 404 response with a readable message.
    const [item, location] = await Promise.all([
      prisma.item.findUnique({ where: { id: itemId } }),
      prisma.location.findUnique({ where: { id: locationId } }),
    ]);
    if (!item) throw new AppError(404, 'Item not found.');
    if (!location) throw new AppError(404, 'Location not found.');

    // Create the inventory record.
    // If itemId+locationId+batchNumber already exists, Prisma throws P2002 → 409 Conflict.
    const inventory = await prisma.inventory.create({
      data: { itemId, locationId, batchNumber: batch, physicalQty },
      include: {
        item: { select: { id: true, name: true, sku: true } },
        location: { select: { id: true, name: true } },
      },
    });

    // Create an initial InventoryTransaction to start the audit trail.
    // Only if there is starting stock — a zero-quantity record doesn't need a transaction.
    if (physicalQty > 0) {
      await prisma.inventoryTransaction.create({
        data: {
          inventoryId: inventory.id,
          transactionType: TransactionType.IN,
          quantity: physicalQty,
          reason: 'Initial stock',
          // req.user!.userId — the `!` is a NON-NULL ASSERTION.
          // TypeScript types req.user as `{...} | undefined` (from AuthenticatedRequest).
          // We assert it's not undefined here because authenticate middleware ran first
          // and would have thrown 401 if user was missing.
          createdById: req.user!.userId,
        },
      });
    }

    return res.status(201).json({ success: true, data: withAvailable(inventory) });
  }
);

// ── GET /api/inventory/:id ────────────────────────────────────────────────────
router.get(
  '/:id',
  authorize(...ALL_ROLES),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const inv = await prisma.inventory.findUnique({
      where: { id: req.params.id },
      include: {
        item: { select: { id: true, name: true, sku: true, category: true, unitPrice: true } },
        location: { select: { id: true, name: true } },
      },
    });
    if (!inv) throw new AppError(404, 'Inventory record not found.');
    return res.json({ success: true, data: withAvailable(inv) });
  }
);

// ── PATCH /api/inventory/:id/adjust ───────────────────────────────────────────
// Manual stock adjustment (IN or OUT).
// Uses a database TRANSACTION with row locking to prevent race conditions.
// Supports an optional idempotency key (referenceKey) to prevent duplicate transactions.
router.patch(
  '/:id/adjust',
  authorize(...OPS_ADMIN),
  [
    param('id').notEmpty(),
    // .isIn(['IN', 'OUT']) validates against the string values of the enum.
    body('transactionType').isIn(['IN', 'OUT']).withMessage('transactionType must be IN or OUT.'),
    // quantity must be at least 1 — adjustments of 0 are meaningless.
    body('quantity').isInt({ min: 1 }).withMessage('quantity must be a positive integer.'),
    body('reason').optional().isString().trim(),
    body('referenceKey').optional().isString().trim(),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { transactionType, quantity, reason, referenceKey } = req.body as {
      transactionType: TransactionType;  // 'IN' | 'OUT' (string matches enum)
      quantity: number;
      reason?: string;
      referenceKey?: string;  // Optional idempotency key
    };

    // prisma.$transaction(async (tx) => {...}) — DATABASE TRANSACTION.
    // All operations inside this callback run in a single atomic unit.
    // If ANY operation throws: ALL changes are ROLLED BACK automatically.
    // If all succeed: ALL changes are COMMITTED together.
    // `tx` is the transaction client — use it instead of `prisma` inside the callback.
    const updated = await prisma.$transaction(async (tx) => {

      // ── Step 1: Lock the row with SELECT FOR UPDATE ────────────────────────
      // tx.$queryRaw<T>`` — raw SQL with type parameter.
      // <Array<{ id: string; physicalQty: number; reservedQty: number }>> tells
      // TypeScript what type to expect back from the raw query.
      // Without the type parameter, the result would be typed as `unknown[]`.
      // The template literal after the backtick IS the SQL query.
      // ${req.params.id} is automatically parameterized (safe from SQL injection).
      //
      // FOR UPDATE — acquires a PostgreSQL row-level lock.
      // Any other transaction trying to SELECT FOR UPDATE the same row will BLOCK
      // until this transaction commits or rolls back.
      // This prevents two simultaneous adjustments from both reading the same
      // physicalQty, both computing a new value, and both committing — which would
      // silently drop one of the adjustments.
      const rows = await tx.$queryRaw<Array<{
        id: string;
        physicalQty: number;
        reservedQty: number;
      }>>`
        SELECT id, "physicalQty", "reservedQty"
        FROM inventory
        WHERE id = ${req.params.id}
        FOR UPDATE
      `;

      if (rows.length === 0) throw new AppError(404, 'Inventory record not found.');
      // rows is an array; we need the first (and only) matching row.
      const inv = rows[0];

      // ── Step 2: Compute the new quantity ──────────────────────────────────
      // Ternary: if IN → add, if OUT → subtract.
      // transactionType === TransactionType.IN is a type-safe comparison.
      const newPhysicalQty =
        transactionType === TransactionType.IN
          ? inv.physicalQty + quantity
          : inv.physicalQty - quantity;

      // ── Step 3: Business rule validations ─────────────────────────────────
      // Physical stock can NEVER go below 0.
      if (newPhysicalQty < 0) {
        throw new AppError(
          422,
          `Adjustment would result in negative stock. Current physical: ${inv.physicalQty}, requested OUT: ${quantity}.`
        );
      }

      // Physical stock can NEVER go below reserved stock.
      // physicalQty < reservedQty would mean we've promised more stock than we have.
      if (newPhysicalQty < inv.reservedQty) {
        throw new AppError(
          422,
          `Adjustment would make physical stock (${newPhysicalQty}) less than reserved stock (${inv.reservedQty}). Release reservations first.`
        );
      }

      // ── Step 4: Create the audit transaction record ───────────────────────
      // If referenceKey is provided AND already exists → P2002 → 409 Conflict.
      // This is the idempotency mechanism: the same logical operation cannot be
      // recorded twice if the caller provides the same referenceKey.
      // ...(condition ? { key: value } : {}) — conditional property spread.
      // Only includes referenceKey in the data if it was provided.
      await tx.inventoryTransaction.create({
        data: {
          inventoryId: inv.id,
          transactionType,
          quantity,
          reason,
          ...(referenceKey ? { referenceKey } : {}),
          createdById: req.user!.userId,
        },
      });

      // ── Step 5: Update the inventory row ──────────────────────────────────
      // This update runs on the same locked row inside the same transaction.
      return tx.inventory.update({
        where: { id: inv.id },
        data: { physicalQty: newPhysicalQty },
        include: {
          item: { select: { id: true, name: true, sku: true } },
          location: { select: { id: true, name: true } },
        },
      });
    });

    return res.json({ success: true, data: withAvailable(updated) });
  }
);

// ── GET /api/inventory/:id/transactions ───────────────────────────────────────
// Returns the audit log (all stock movements) for a specific inventory row.
router.get(
  '/:id/transactions',
  authorize(...ALL_ROLES),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    // First verify the inventory record exists.
    const inv = await prisma.inventory.findUnique({ where: { id: req.params.id } });
    if (!inv) throw new AppError(404, 'Inventory record not found.');

    const transactions = await prisma.inventoryTransaction.findMany({
      where: { inventoryId: req.params.id },
      // Include who created each transaction for audit purposes.
      include: { createdBy: { select: { id: true, name: true } } },
      // Most recent first — standard audit log order.
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, data: transactions });
  }
);

export default router;
