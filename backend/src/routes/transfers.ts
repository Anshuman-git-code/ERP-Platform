// ============================================================
// FILE: backend/src/routes/transfers.ts
// CONSTRUCTION ORDER: #24
// HOW: touch src/routes/transfers.ts
// WHY NOW: Written after workOrders.ts. Transfers are the second most complex
//          feature — a 3-state lifecycle (REQUESTED → DISPATCHED → RECEIVED)
//          where source and destination inventory are modified in separate steps.
// KEY BUSINESS RULES ENFORCED HERE:
//   - Dispatch reduces source physicalQty (stock leaves the building)
//   - Receipt increases destination physicalQty (stock arrives)
//   - These two steps are DELIBERATELY SEPARATE — stock is "in transit" between them
//   - Double-receipt is prevented by locking the transfer row itself
//   - Dispatch uses idempotency keys to prevent duplicate stock movements
// WHAT THIS FILE INTRODUCES (new concepts beyond previous routes):
//   - Nested SELECT FOR UPDATE (locking the transfer row to prevent race conditions)
//   - FIFO-ish multi-row deduction (deducting from multiple batch rows in order)
//   - findFirst vs findUnique (for find-or-create pattern at destination)
//   - Transferring the referenceKey pattern to transfer-specific keys
// ============================================================

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

// ── GET /api/transfers ────────────────────────────────────────────────────────
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

// ── POST /api/transfers ───────────────────────────────────────────────────────
// Creates a new transfer REQUEST. No inventory changes at this stage.
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

    // Business rule: source and destination must be different locations.
    if (sourceLocationId === destLocationId) {
      throw new AppError(400, 'Source and destination locations must be different.');
    }

    // Verify all three referenced records exist concurrently.
    const [srcLoc, dstLoc, item] = await Promise.all([
      prisma.location.findUnique({ where: { id: sourceLocationId } }),
      prisma.location.findUnique({ where: { id: destLocationId } }),
      prisma.item.findUnique({ where: { id: itemId } }),
    ]);
    if (!srcLoc) throw new AppError(404, 'Source location not found.');
    if (!dstLoc) throw new AppError(404, 'Destination location not found.');
    if (!item) throw new AppError(404, 'Item not found.');

    // Generate transfer number: TR-00001, TR-00002, etc.
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
        // Snapshot item name and SKU at request time.
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

// ── GET /api/transfers/:id ────────────────────────────────────────────────────
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

// ── PATCH /api/transfers/:id/dispatch ─────────────────────────────────────────
// REQUESTED → DISPATCHED
// MANDATORY TEST 2: Cannot dispatch more than available source inventory.
// Reduces source physicalQty. Does NOT touch destination.
router.patch(
  '/:id/dispatch',
  authorize(...OPS_ADMIN),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const transferId = req.params.id;

    const updated = await prisma.$transaction(async (tx) => {

      // Step 1: Fetch the transfer record.
      const transfer = await tx.stockTransfer.findUnique({ where: { id: transferId } });
      if (!transfer) throw new AppError(404, 'Transfer not found.');

      // Step 2: Verify the transfer is in REQUESTED state.
      // Cannot dispatch a transfer that's already dispatched, received, or cancelled.
      if (transfer.status !== TransferStatus.REQUESTED) {
        throw new AppError(
          400,
          `Transfer cannot be dispatched. Current status: ${transfer.status}.`
        );
      }

      // Step 3: Lock ALL source inventory rows for this item+location.
      // ORDER BY id ensures consistent lock order to prevent deadlocks.
      // (If two dispatches compete, they both try to lock rows in the same order,
      // so one waits rather than both blocking each other forever.)
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
        throw new AppError(422, 'No inventory record found at source location for this item.');
      }

      // Step 4: Check total available across ALL source rows (all batches).
      const totalAvailable = sourceRows.reduce(
        (s, r) => s + (r.physicalQty - r.reservedQty),  // available = physical - reserved
        0
      );

      // MANDATORY TEST 2: This is where over-dispatch is prevented.
      if (totalAvailable < transfer.quantity) {
        throw new AppError(
          422,
          `Insufficient available stock at source. Available: ${totalAvailable}, requested: ${transfer.quantity}.`
        );
      }

      // Step 5: Deduct from source rows in order (FIFO-ish — first batches first).
      // `remaining` tracks how many units still need to be deducted.
      let remaining = transfer.quantity;
      for (const row of sourceRows) {
        if (remaining <= 0) break;  // All units accounted for — stop

        const available = row.physicalQty - row.reservedQty;
        // Deduct the lesser of: available in this row, OR remaining needed.
        // This handles the case where transfer.quantity spans multiple batch rows.
        const deduct = Math.min(available, remaining);
        if (deduct <= 0) continue;  // This row is fully reserved, skip it

        // Deduct from this inventory row's physicalQty.
        await tx.inventory.update({
          where: { id: row.id },
          data: { physicalQty: { decrement: deduct } },
          // `decrement` is Prisma's atomic decrement — equivalent to:
          //   UPDATE inventory SET "physicalQty" = "physicalQty" - deduct WHERE id = ...
        });

        // Create an audit transaction record for this deduction.
        // referenceKey: `dispatch-${transferId}-${rowId}` is unique per (transfer, batch row).
        // If dispatch is somehow called twice (retry), the second call will fail with P2002
        // on this unique constraint → 409 → caller knows it was already dispatched.
        await tx.inventoryTransaction.create({
          data: {
            inventoryId: row.id,
            transactionType: TransactionType.OUT,  // Stock leaving source
            quantity: deduct,
            reason: `Transfer ${transfer.transferNumber} dispatched`,
            referenceKey: `dispatch-${transfer.id}-${row.id}`,
            createdById: req.user!.userId,
          },
        });

        remaining -= deduct;  // Reduce remaining count
      }

      // Step 6: Mark the transfer as DISPATCHED.
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

// ── PATCH /api/transfers/:id/receive ──────────────────────────────────────────
// DISPATCHED → RECEIVED
// MANDATORY TEST 3: Destination stock only increases HERE (not at dispatch).
// MANDATORY TEST 4: Cannot receive the same transfer twice.
router.patch(
  '/:id/receive',
  authorize(...OPS_ADMIN),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const transferId = req.params.id;

    const updated = await prisma.$transaction(async (tx) => {

      // Step 1: Lock the TRANSFER ROW ITSELF with FOR UPDATE.
      // WHY: Without locking the transfer row, two simultaneous receive calls could
      // both read status=DISPATCHED, both pass the status check, and both increment
      // destination stock — resulting in double-receipt.
      // By locking the transfer row, the second call BLOCKS until the first commits.
      // After the first commits (status=RECEIVED), the second reads RECEIVED and fails.
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

      // Step 2: Verify status is DISPATCHED.
      // MANDATORY TEST 4: The lock above ensures only one receive can pass this check.
      if (transfer.status !== TransferStatus.DISPATCHED) {
        throw new AppError(
          400,
          `Transfer cannot be received. Current status: ${transfer.status}. Only DISPATCHED transfers can be received.`
        );
      }

      // Step 3: Find or create the destination inventory record.
      // findFirst — finds the first matching row (not findUnique — no single unique field here).
      // The destination inventory may not exist yet (e.g., first time this item arrives here).
      let destInv = await tx.inventory.findFirst({
        where: {
          itemId: transfer.itemId,
          locationId: transfer.destLocationId,
          batchNumber: 'DEFAULT',  // Transfers always go to the DEFAULT batch
        },
      });

      if (!destInv) {
        // Create the destination inventory row with physicalQty=0.
        // We'll increment it in the next step.
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

      // Step 4: Also lock the destination inventory row before updating.
      // Prevents concurrent receives (in multi-transfer scenarios) from reading
      // the same physicalQty and both incrementing from the same base.
      await tx.$queryRaw`SELECT id FROM inventory WHERE id = ${destInv.id} FOR UPDATE`;

      // MANDATORY TEST 3: This is the ONLY place destination stock increases.
      // Dispatch only touched source. This is where destination gets the stock.
      await tx.inventory.update({
        where: { id: destInv.id },
        data: { physicalQty: { increment: transfer.quantity } },
      });

      // Step 5: Create audit transaction for destination.
      // referenceKey: `receive-${transferId}` — unique per transfer.
      // A second receive call on the same transfer would fail here with P2002
      // EVEN IF the status check were somehow bypassed.
      await tx.inventoryTransaction.create({
        data: {
          inventoryId: destInv.id,
          transactionType: TransactionType.IN,  // Stock arriving at destination
          quantity: transfer.quantity,
          reason: `Transfer ${transfer.transferNumber} received`,
          referenceKey: `receive-${transfer.id}`,  // Idempotency key
          createdById: req.user!.userId,
        },
      });

      // Step 6: Mark transfer as RECEIVED.
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

// ── PATCH /api/transfers/:id/cancel ───────────────────────────────────────────
// REQUESTED → CANCELLED
// ADMIN only. Only from REQUESTED state. No inventory changes (stock never moved).
router.patch(
  '/:id/cancel',
  authorize(...ADMIN_ONLY),  // Only ADMIN can cancel transfers
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const transfer = await prisma.stockTransfer.findUnique({ where: { id: req.params.id } });
    if (!transfer) throw new AppError(404, 'Transfer not found.');

    // Can only cancel from REQUESTED — once dispatched, stock has already moved.
    if (transfer.status !== TransferStatus.REQUESTED) {
      throw new AppError(
        400,
        `Only REQUESTED transfers can be cancelled. Current status: ${transfer.status}.`
      );
    }

    // No inventory changes needed — stock was never moved in REQUESTED state.
    const updated = await prisma.stockTransfer.update({
      where: { id: req.params.id },
      data: { status: TransferStatus.CANCELLED },
    });

    return res.json({ success: true, data: updated });
  }
);

export default router;
