import { Router, Response } from 'express';
import { body, param, query } from 'express-validator';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
import { Role, TransactionType } from '@prisma/client';

const router = Router();
router.use(authenticate);

const OPS_ADMIN = [Role.ADMIN, Role.OPERATIONS];
const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

/** Compute availableQty inline — never stored. */
function withAvailable(inv: { physicalQty: number; reservedQty: number }) {
  return { ...inv, availableQty: inv.physicalQty - inv.reservedQty };
}

// ─── GET /api/inventory ───────────────────────────────────────────────────────
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

    const where: Record<string, unknown> = {};
    if (req.query.locationId) where.locationId = req.query.locationId;
    if (req.query.itemId) where.itemId = req.query.itemId;

    const [records, total] = await Promise.all([
      prisma.inventory.findMany({
        where,
        skip,
        take: limit,
        include: {
          item: { select: { id: true, name: true, sku: true, category: true, unitPrice: true } },
          location: { select: { id: true, name: true } },
        },
        orderBy: [{ location: { name: 'asc' } }, { item: { name: 'asc' } }],
      }),
      prisma.inventory.count({ where }),
    ]);

    return res.json({
      success: true,
      data: records.map(withAvailable),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  }
);

// ─── POST /api/inventory ──────────────────────────────────────────────────────
// Create a new inventory record for an item/location/batch combination.
router.post(
  '/',
  authorize(...OPS_ADMIN),
  [
    body('itemId').notEmpty().withMessage('itemId is required.'),
    body('locationId').notEmpty().withMessage('locationId is required.'),
    body('batchNumber').optional().isString().trim(),
    body('physicalQty')
      .isInt({ min: 0 })
      .withMessage('physicalQty must be a non-negative integer.'),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { itemId, locationId, physicalQty, batchNumber } = req.body as {
      itemId: string;
      locationId: string;
      physicalQty: number;
      batchNumber?: string;
    };

    const batch = batchNumber?.trim() || 'DEFAULT';

    // Verify item and location exist
    const [item, location] = await Promise.all([
      prisma.item.findUnique({ where: { id: itemId } }),
      prisma.location.findUnique({ where: { id: locationId } }),
    ]);
    if (!item) throw new AppError(404, 'Item not found.');
    if (!location) throw new AppError(404, 'Location not found.');

    const inventory = await prisma.inventory.create({
      data: { itemId, locationId, batchNumber: batch, physicalQty },
      include: {
        item: { select: { id: true, name: true, sku: true } },
        location: { select: { id: true, name: true } },
      },
    });

    // Record the initial stock-in transaction
    if (physicalQty > 0) {
      await prisma.inventoryTransaction.create({
        data: {
          inventoryId: inventory.id,
          transactionType: TransactionType.IN,
          quantity: physicalQty,
          reason: 'Initial stock',
          createdById: req.user!.userId,
        },
      });
    }

    return res.status(201).json({ success: true, data: withAvailable(inventory) });
  }
);

// ─── GET /api/inventory/:id ───────────────────────────────────────────────────
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

// ─── PATCH /api/inventory/:id/adjust ─────────────────────────────────────────
// Manual stock adjustment. Validates that the result never goes below zero
// and uses an idempotency key to prevent duplicate transactions.
router.patch(
  '/:id/adjust',
  authorize(...OPS_ADMIN),
  [
    param('id').notEmpty(),
    body('transactionType')
      .isIn(['IN', 'OUT'])
      .withMessage('transactionType must be IN or OUT.'),
    body('quantity')
      .isInt({ min: 1 })
      .withMessage('quantity must be a positive integer.'),
    body('reason').optional().isString().trim(),
    body('referenceKey').optional().isString().trim(),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { transactionType, quantity, reason, referenceKey } = req.body as {
      transactionType: TransactionType;
      quantity: number;
      reason?: string;
      referenceKey?: string;
    };

    const updated = await prisma.$transaction(async (tx) => {
      // Lock the row for the duration of this transaction
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
      const inv = rows[0];

      const newPhysicalQty =
        transactionType === TransactionType.IN
          ? inv.physicalQty + quantity
          : inv.physicalQty - quantity;

      if (newPhysicalQty < 0) {
        throw new AppError(
          422,
          `Adjustment would result in negative stock. Current physical: ${inv.physicalQty}, requested OUT: ${quantity}.`
        );
      }

      // Ensure physicalQty never drops below reservedQty
      if (newPhysicalQty < inv.reservedQty) {
        throw new AppError(
          422,
          `Adjustment would make physical stock (${newPhysicalQty}) less than reserved stock (${inv.reservedQty}). Release reservations first.`
        );
      }

      // Record the transaction (referenceKey uniqueness prevents duplicates)
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

// ─── GET /api/inventory/:id/transactions ──────────────────────────────────────
router.get(
  '/:id/transactions',
  authorize(...ALL_ROLES),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const inv = await prisma.inventory.findUnique({ where: { id: req.params.id } });
    if (!inv) throw new AppError(404, 'Inventory record not found.');

    const transactions = await prisma.inventoryTransaction.findMany({
      where: { inventoryId: req.params.id },
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, data: transactions });
  }
);

export default router;
