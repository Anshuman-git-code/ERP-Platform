import { Router, Response } from 'express';
import { body, param, query } from 'express-validator';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
import { Role, OrderStatus } from '@prisma/client';

const router = Router();
router.use(authenticate);

const SALES_ADMIN = [Role.ADMIN, Role.SALES];
const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

// ─── GET /api/orders ──────────────────────────────────────────────────────────
router.get(
  '/',
  authorize(...ALL_ROLES),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(Object.values(OrderStatus)),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const page = parseInt((req.query.page as string) ?? '1', 10);
    const limit = parseInt((req.query.limit as string) ?? '20', 10);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (req.query.status) where.status = req.query.status;

    const [orders, total] = await Promise.all([
      prisma.customerOrder.findMany({
        where,
        skip,
        take: limit,
        include: {
          location: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          items: {
            include: {
              inventory: {
                include: { item: { select: { id: true, name: true, sku: true } } },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.customerOrder.count({ where }),
    ]);

    return res.json({
      success: true,
      data: orders,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  }
);

// ─── POST /api/orders ─────────────────────────────────────────────────────────
// Creates a PENDING order. Does NOT reserve stock yet.
router.post(
  '/',
  authorize(...SALES_ADMIN),
  [
    body('customerName').notEmpty().withMessage('customerName is required.').trim(),
    body('customerPhone').optional().isString().trim(),
    body('locationId').notEmpty().withMessage('locationId is required.'),
    body('notes').optional().isString().trim(),
    body('items')
      .isArray({ min: 1 })
      .withMessage('items must be a non-empty array.'),
    body('items.*.inventoryId').notEmpty().withMessage('Each item must have an inventoryId.'),
    body('items.*.quantity')
      .isInt({ min: 1 })
      .withMessage('Each item quantity must be a positive integer.'),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { customerName, customerPhone, locationId, notes, items } = req.body as {
      customerName: string;
      customerPhone?: string;
      locationId: string;
      notes?: string;
      items: Array<{ inventoryId: string; quantity: number }>;
    };

    // Verify location
    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) throw new AppError(404, 'Location not found.');

    // Verify all inventory records and fetch item snapshot data
    const inventoryIds = items.map((i) => i.inventoryId);
    const inventoryRecords = await prisma.inventory.findMany({
      where: { id: { in: inventoryIds } },
      include: { item: true },
    });

    if (inventoryRecords.length !== inventoryIds.length) {
      throw new AppError(404, 'One or more inventory records not found.');
    }

    const inventoryMap = new Map(inventoryRecords.map((r) => [r.id, r]));

    const totalQty = items.reduce((s, i) => s + i.quantity, 0);
    const count = await prisma.customerOrder.count();
    const orderNumber = `ORD-${String(count + 1).padStart(5, '0')}`;

    const order = await prisma.customerOrder.create({
      data: {
        orderNumber,
        customerName,
        customerPhone,
        locationId,
        totalQty,
        notes,
        createdById: req.user!.userId,
        items: {
          create: items.map((i) => {
            const inv = inventoryMap.get(i.inventoryId)!;
            return {
              inventoryId: i.inventoryId,
              quantity: i.quantity,
              itemId: inv.itemId,
              itemName: inv.item.name,
              itemSku: inv.item.sku,
              unitPrice: inv.item.unitPrice,
            };
          }),
        },
      },
      include: {
        location: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        items: true,
      },
    });

    return res.status(201).json({ success: true, data: order });
  }
);

// ─── GET /api/orders/:id ──────────────────────────────────────────────────────
router.get(
  '/:id',
  authorize(...ALL_ROLES),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const order = await prisma.customerOrder.findUnique({
      where: { id: req.params.id },
      include: {
        location: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        items: {
          include: {
            inventory: {
              include: {
                item: { select: { id: true, name: true, sku: true } },
                location: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });
    if (!order) throw new AppError(404, 'Order not found.');
    return res.json({ success: true, data: order });
  }
);

// ─── PATCH /api/orders/:id/confirm ───────────────────────────────────────────
// PENDING → CONFIRMED
// Atomically reserves stock by incrementing reservedQty on each Inventory row.
// Uses SELECT FOR UPDATE to prevent concurrent over-reservation.
// Inventory rows are locked in deterministic id order to prevent deadlocks.
router.patch(
  '/:id/confirm',
  authorize(...SALES_ADMIN),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const orderId = req.params.id;

    const confirmed = await prisma.$transaction(async (tx) => {
      // 1. Verify order is PENDING
      const order = await tx.customerOrder.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) throw new AppError(404, 'Order not found.');
      if (order.status !== OrderStatus.PENDING) {
        throw new AppError(400, `Order is already ${order.status.toLowerCase()}.`);
      }

      // 2. Lock all affected inventory rows in deterministic order (by id) to
      //    prevent deadlocks when two requests compete for the same rows.
      const inventoryIds = [...new Set(order.items.map((i) => i.inventoryId))].sort();

      const lockedRows = await tx.$queryRaw<Array<{
        id: string;
        physicalQty: number;
        reservedQty: number;
      }>>`
        SELECT id, "physicalQty", "reservedQty"
        FROM inventory
        WHERE id = ANY(${inventoryIds}::text[])
        ORDER BY id
        FOR UPDATE
      `;

      const inventoryMap = new Map(lockedRows.map((r) => [r.id, r]));

      // 3. Check availability for every order item
      const insufficient: Array<{
        inventoryId: string;
        itemName: string;
        available: number;
        requested: number;
      }> = [];

      for (const item of order.items) {
        const inv = inventoryMap.get(item.inventoryId);
        if (!inv) throw new AppError(404, `Inventory record ${item.inventoryId} not found.`);
        const available = inv.physicalQty - inv.reservedQty;
        if (available < item.quantity) {
          insufficient.push({
            inventoryId: item.inventoryId,
            itemName: item.itemName,
            available,
            requested: item.quantity,
          });
        }
      }

      if (insufficient.length > 0) {
        throw new AppError(422, 'Insufficient available stock for one or more items.', {
          insufficientItems: insufficient,
        });
      }

      // 4. All checks passed — reserve stock
      for (const item of order.items) {
        await tx.inventory.update({
          where: { id: item.inventoryId },
          data: { reservedQty: { increment: item.quantity } },
        });
      }

      // 5. Mark order confirmed
      return tx.customerOrder.update({
        where: { id: orderId },
        data: { status: OrderStatus.CONFIRMED, confirmedAt: new Date() },
        include: {
          location: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          items: true,
        },
      });
    });

    return res.json({ success: true, data: confirmed });
  }
);

// ─── PATCH /api/orders/:id/cancel ────────────────────────────────────────────
// PENDING or CONFIRMED → CANCELLED
// If order was CONFIRMED, releases the reserved stock (decrements reservedQty).
router.patch(
  '/:id/cancel',
  authorize(...SALES_ADMIN),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const orderId = req.params.id;

    const cancelled = await prisma.$transaction(async (tx) => {
      const order = await tx.customerOrder.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) throw new AppError(404, 'Order not found.');
      if (order.status === OrderStatus.CANCELLED) {
        throw new AppError(400, 'Order is already cancelled.');
      }

      // If it was CONFIRMED, release the reservation
      if (order.status === OrderStatus.CONFIRMED) {
        for (const item of order.items) {
          await tx.inventory.update({
            where: { id: item.inventoryId },
            data: { reservedQty: { decrement: item.quantity } },
          });
        }
      }

      return tx.customerOrder.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
        include: {
          location: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          items: true,
        },
      });
    });

    return res.json({ success: true, data: cancelled });
  }
);

export default router;
