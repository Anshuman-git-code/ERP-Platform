import { Router, Response } from 'express';
import { body, param, query } from 'express-validator';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
import { Role, TransferStatus, TransactionType } from '@prisma/client';

const router = Router();
router.use(authenticate);

const ADMIN_ONLY = [Role.ADMIN];
const OPS_ADMIN = [Role.ADMIN, Role.OPERATIONS];
const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

// ─── GET /api/transfers ───────────────────────────────────────────────────────
router.get(
  '/',
  authorize(...ALL_ROLES),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(Object.values(TransferStatus)),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const page = parseInt((req.query.page as string) ?? '1', 10);
    const limit = parseInt((req.query.limit as string) ?? '20', 10);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (req.query.status) where.status = req.query.status;

    const [transfers, total] = await Promise.all([
      prisma.stockTransfer.findMany({
        where,
        skip,
        take: limit,
        include: {
          sourceLocation: { select: { id: true, name: true } },
          destLocation: { select: { id: true, name: true } },
          item: { select: { id: true, name: true, sku: true } },
          requestedBy: { select: { id: true, name: true } },
          dispatchedBy: { select: { id: true, name: true } },
          receivedBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.stockTransfer.count({ where }),
    ]);

    return res.json({
      success: true,
      data: transfers,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  }
);

// ─── POST /api/transfers ──────────────────────────────────────────────────────
router.post(
  '/',
  authorize(...OPS_ADMIN),
  [
    body('sourceLocationId').notEmpty().withMessage('sourceLocationId is required.'),
    body('destLocationId').notEmpty().withMessage('destLocationId is required.'),
    body('itemId').notEmpty().withMessage('itemId is required.'),
    body('quantity').isInt({ min: 1 }).withMessage('quantity must be a positive integer.'),
    body('notes').optional().isString().trim(),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { sourceLocationId, destLocationId, itemId, quantity, notes } = req.body as {
      sourceLocationId: string;
      destLocationId: string;
      itemId: string;
      quantity: number;
      notes?: string;
    };

    if (sourceLocationId === destLocationId) {
      throw new AppError(400, 'Source and destination locations must be different.');
    }

    const [srcLoc, dstLoc, item] = await Promise.all([
      prisma.location.findUnique({ where: { id: sourceLocationId } }),
      prisma.location.findUnique({ where: { id: destLocationId } }),
      prisma.item.findUnique({ where: { id: itemId } }),
    ]);
    if (!srcLoc) throw new AppError(404, 'Source location not found.');
    if (!dstLoc) throw new AppError(404, 'Destination location not found.');
    if (!item) throw new AppError(404, 'Item not found.');

    const count = await prisma.stockTransfer.count();
    const transferNumber = `TR-${String(count + 1).padStart(5, '0')}`;

    const transfer = await prisma.stockTransfer.create({
      data: {
        transferNumber,
        sourceLocationId,
        destLocationId,
        itemId,
        quantity,
        notes,
        requestedById: req.user!.userId,
        itemName: item.name,
        itemSku: item.sku,
      },
      include: {
        sourceLocation: { select: { id: true, name: true } },
        destLocation: { select: { id: true, name: true } },
        item: { select: { id: true, name: true, sku: true } },
        requestedBy: { select: { id: true, name: true } },
      },
    });

    return res.status(201).json({ success: true, data: transfer });
  }
);

// ─── GET /api/transfers/:id ───────────────────────────────────────────────────
router.get(
  '/:id',
  authorize(...ALL_ROLES),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const transfer = await prisma.stockTransfer.findUnique({
      where: { id: req.params.id },
      include: {
        sourceLocation: { select: { id: true, name: true } },
        destLocation: { select: { id: true, name: true } },
        item: { select: { id: true, name: true, sku: true } },
        requestedBy: { select: { id: true, name: true } },
        dispatchedBy: { select: { id: true, name: true } },
        receivedBy: { select: { id: true, name: true } },
      },
    });
    if (!transfer) throw new AppError(404, 'Transfer not found.');
    return res.json({ success: true, data: transfer });
  }
);

// ─── PATCH /api/transfers/:id/dispatch ───────────────────────────────────────
// REQUESTED → DISPATCHED
// Reduces source inventory physicalQty inside a transaction with row locking.
// Does NOT touch destination inventory.
router.patch(
  '/:id/dispatch',
  authorize(...OPS_ADMIN),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const transferId = req.params.id;

    const updated = await prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({ where: { id: transferId } });
      if (!transfer) throw new AppError(404, 'Transfer not found.');
      if (transfer.status !== TransferStatus.REQUESTED) {
        throw new AppError(
          400,
          `Transfer cannot be dispatched. Current status: ${transfer.status}.`
        );
      }

      // Lock the source inventory row(s) for this item+location
      const sourceRows = await tx.$queryRaw<Array<{
        id: string;
        physicalQty: number;
        reservedQty: number;
      }>>`
        SELECT id, "physicalQty", "reservedQty"
        FROM inventory
        WHERE "itemId" = ${transfer.itemId}
          AND "locationId" = ${transfer.sourceLocationId}
        ORDER BY id
        FOR UPDATE
      `;

      if (sourceRows.length === 0) {
        throw new AppError(
          422,
          'No inventory record found at source location for this item.'
        );
      }

      const totalAvailable = sourceRows.reduce(
        (s, r) => s + (r.physicalQty - r.reservedQty),
        0
      );

      if (totalAvailable < transfer.quantity) {
        throw new AppError(
          422,
          `Insufficient available stock at source. Available: ${totalAvailable}, requested: ${transfer.quantity}.`
        );
      }

      // Deduct from source inventory rows in order (FIFO-ish)
      let remaining = transfer.quantity;
      for (const row of sourceRows) {
        if (remaining <= 0) break;
        const available = row.physicalQty - row.reservedQty;
        const deduct = Math.min(available, remaining);
        if (deduct <= 0) continue;

        await tx.inventory.update({
          where: { id: row.id },
          data: { physicalQty: { decrement: deduct } },
        });

        // Audit transaction — referenceKey prevents duplicate dispatch
        await tx.inventoryTransaction.create({
          data: {
            inventoryId: row.id,
            transactionType: TransactionType.OUT,
            quantity: deduct,
            reason: `Transfer ${transfer.transferNumber} dispatched`,
            referenceKey: `dispatch-${transfer.id}-${row.id}`,
            createdById: req.user!.userId,
          },
        });

        remaining -= deduct;
      }

      return tx.stockTransfer.update({
        where: { id: transferId },
        data: {
          status: TransferStatus.DISPATCHED,
          dispatchedById: req.user!.userId,
          dispatchedAt: new Date(),
        },
        include: {
          sourceLocation: { select: { id: true, name: true } },
          destLocation: { select: { id: true, name: true } },
          item: { select: { id: true, name: true, sku: true } },
          requestedBy: { select: { id: true, name: true } },
          dispatchedBy: { select: { id: true, name: true } },
        },
      });
    });

    return res.json({ success: true, data: updated });
  }
);

// ─── PATCH /api/transfers/:id/receive ────────────────────────────────────────
// DISPATCHED → RECEIVED
// Increases destination inventory physicalQty inside a transaction.
// Double-receipt is prevented by requiring status === DISPATCHED.
router.patch(
  '/:id/receive',
  authorize(...OPS_ADMIN),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const transferId = req.params.id;

    const updated = await prisma.$transaction(async (tx) => {
      // Lock the transfer row itself to guard against concurrent receive calls
      const transfers = await tx.$queryRaw<Array<{
        id: string;
        status: string;
        destLocationId: string;
        itemId: string;
        quantity: number;
        transferNumber: string;
      }>>`
        SELECT id, status, "destLocationId", "itemId", quantity, "transferNumber"
        FROM stock_transfers
        WHERE id = ${transferId}
        FOR UPDATE
      `;

      if (transfers.length === 0) throw new AppError(404, 'Transfer not found.');
      const transfer = transfers[0];

      if (transfer.status !== TransferStatus.DISPATCHED) {
        throw new AppError(
          400,
          `Transfer cannot be received. Current status: ${transfer.status}. Only DISPATCHED transfers can be received.`
        );
      }

      // Find or create the destination inventory record (DEFAULT batch)
      let destInv = await tx.inventory.findFirst({
        where: {
          itemId: transfer.itemId,
          locationId: transfer.destLocationId,
          batchNumber: 'DEFAULT',
        },
      });

      if (!destInv) {
        // Create a new inventory record at the destination
        destInv = await tx.inventory.create({
          data: {
            itemId: transfer.itemId,
            locationId: transfer.destLocationId,
            batchNumber: 'DEFAULT',
            physicalQty: 0,
            reservedQty: 0,
          },
        });
      }

      // Lock and update destination inventory
      await tx.$queryRaw`
        SELECT id FROM inventory WHERE id = ${destInv.id} FOR UPDATE
      `;

      await tx.inventory.update({
        where: { id: destInv.id },
        data: { physicalQty: { increment: transfer.quantity } },
      });

      // Audit transaction — referenceKey prevents duplicate receipt
      await tx.inventoryTransaction.create({
        data: {
          inventoryId: destInv.id,
          transactionType: TransactionType.IN,
          quantity: transfer.quantity,
          reason: `Transfer ${transfer.transferNumber} received`,
          referenceKey: `receive-${transfer.id}`,
          createdById: req.user!.userId,
        },
      });

      return tx.stockTransfer.update({
        where: { id: transferId },
        data: {
          status: TransferStatus.RECEIVED,
          receivedById: req.user!.userId,
          receivedAt: new Date(),
        },
        include: {
          sourceLocation: { select: { id: true, name: true } },
          destLocation: { select: { id: true, name: true } },
          item: { select: { id: true, name: true, sku: true } },
          requestedBy: { select: { id: true, name: true } },
          dispatchedBy: { select: { id: true, name: true } },
          receivedBy: { select: { id: true, name: true } },
        },
      });
    });

    return res.json({ success: true, data: updated });
  }
);

// ─── PATCH /api/transfers/:id/cancel ─────────────────────────────────────────
// REQUESTED → CANCELLED (only ADMIN, only from REQUESTED state)
router.patch(
  '/:id/cancel',
  authorize(...ADMIN_ONLY),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const transfer = await prisma.stockTransfer.findUnique({ where: { id: req.params.id } });
    if (!transfer) throw new AppError(404, 'Transfer not found.');
    if (transfer.status !== TransferStatus.REQUESTED) {
      throw new AppError(
        400,
        `Only REQUESTED transfers can be cancelled. Current status: ${transfer.status}.`
      );
    }

    const updated = await prisma.stockTransfer.update({
      where: { id: req.params.id },
      data: { status: TransferStatus.CANCELLED },
    });

    return res.json({ success: true, data: updated });
  }
);

export default router;
