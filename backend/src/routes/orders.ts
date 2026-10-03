// ============================================================
// FILE: backend/src/routes/orders.ts
// CONSTRUCTION ORDER: #25 — Most complex route file
// HOW: touch src/routes/orders.ts
// WHY LAST AMONG ROUTES: This file has the most complex business logic:
//   1. The stock reservation mechanism (MANDATORY TEST 1)
//   2. Deadlock-prevention via sorted lock order
//   3. Concurrent request handling verified by a concurrency test
// Writing it last means all patterns from simpler routes are already established.
// KEY BUSINESS RULE:
//   Order creation (POST) does NOT reserve stock.
//   Order confirmation (PATCH /confirm) reserves stock atomically via SELECT FOR UPDATE.
//   Order cancellation (PATCH /cancel) releases reservation if was CONFIRMED.
// ============================================================

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

const SALES_ADMIN = [Role.ADMIN, Role.SALES];  // Can create, confirm, and cancel orders
const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

// ── GET /api/orders ───────────────────────────────────────────────────────────
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
              // Nested include: items → inventory → item
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

// ── POST /api/orders ──────────────────────────────────────────────────────────
// Creates a PENDING order. Stock is NOT reserved at this step.
// Reservation only happens when PATCH /confirm is called.
router.post(
  '/',
  authorize(...SALES_ADMIN),
  [
    body('customerName').notEmpty().withMessage('customerName is required.').trim(),
    body('customerPhone').optional().isString().trim(),
    body('locationId').notEmpty().withMessage('locationId is required.'),
    body('notes').optional().isString().trim(),
    body('items').isArray({ min: 1 }).withMessage('items must be a non-empty array.'),
    // Validates nested array items. `items.*.inventoryId` means "inventoryId of each item".
    body('items.*.inventoryId').notEmpty().withMessage('Each item must have an inventoryId.'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Each item quantity must be a positive integer.'),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { customerName, customerPhone, locationId, notes, items } = req.body as {
      customerName: string;
      customerPhone?: string;
      locationId: string;
      notes?: string;
      // `items` is an array of objects — typed as Array<{...}>
      // Array<T> and T[] are equivalent in TypeScript. Array<T> is chosen here
      // because the element type spans multiple lines — it's more readable.
      items: Array<{ inventoryId: string; quantity: number }>;
    };

    // Verify the location exists.
    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) throw new AppError(404, 'Location not found.');

    // Fetch all inventory records referenced by this order IN ONE QUERY.
    // `id: { in: inventoryIds }` → WHERE id IN ('id1', 'id2', ...)
    const inventoryIds = items.map((i) => i.inventoryId);
    const inventoryRecords = await prisma.inventory.findMany({
      where: { id: { in: inventoryIds } },
      include: { item: true },  // Include full item data for the snapshot fields below
    });

    // If we got fewer records than requested, at least one ID is invalid.
    if (inventoryRecords.length !== inventoryIds.length) {
      throw new AppError(404, 'One or more inventory records not found.');
    }

    // Build a Map for O(1) lookup: inventoryId → inventory record.
    // new Map(iterable) where iterable yields [key, value] pairs.
    // .map((r) => [r.id, r]) produces an array of [id, record] tuples.
    // TypeScript infers: Map<string, Inventory & { item: Item }>
    const inventoryMap = new Map(inventoryRecords.map((r) => [r.id, r]));

    // Sum all item quantities for the totalQty field on the order.
    const totalQty = items.reduce((s, i) => s + i.quantity, 0);

    // Generate a collision-safe order number.
    // WHY NOT COUNT(*)+1? Two simultaneous POST requests would both read the same
    // count and generate the same order number, causing a P2002 unique constraint failure.
    // Date.now() gives millisecond precision timestamp.
    // Math.random().toString(36).slice(2, 7).toUpperCase() gives 5 random alphanumeric chars.
    // Combined: ORD-1720000000000-ABC12 — collision is astronomically unlikely.
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    // Create the order and all its items in a single nested write.
    // `items: { create: [...] }` is Prisma's nested create syntax —
    // creates the parent CustomerOrder AND all child OrderItems in one transaction.
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
            // inventoryMap.get(i.inventoryId)! — we know it exists because we verified above.
            // The `!` asserts non-null to TypeScript.
            const inv = inventoryMap.get(i.inventoryId)!;
            return {
              inventoryId: i.inventoryId,
              quantity: i.quantity,
              itemId: inv.itemId,
              // SNAPSHOT FIELDS: capture price and name at order creation time.
              // If the item's price changes tomorrow, this order still shows today's price.
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

// ── GET /api/orders/:id ───────────────────────────────────────────────────────
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

// ── PATCH /api/orders/:id/confirm ─────────────────────────────────────────────
// PENDING → CONFIRMED
// MANDATORY TEST 1: Cannot reserve more stock than is available.
// CONCURRENCY SAFE: Uses SELECT FOR UPDATE with sorted lock order to prevent
//   - Over-reservation (two requests both thinking they can reserve the same stock)
//   - Deadlocks (two requests trying to lock the same rows in different order)
router.patch(
  '/:id/confirm',
  authorize(...SALES_ADMIN),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const orderId = req.params.id;

    const confirmed = await prisma.$transaction(async (tx) => {

      // Step 1: Fetch the order with its items.
      const order = await tx.customerOrder.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) throw new AppError(404, 'Order not found.');

      // Reject if not PENDING — cannot confirm a CONFIRMED or CANCELLED order.
      if (order.status !== OrderStatus.PENDING) {
        throw new AppError(400, `Order is already ${order.status.toLowerCase()}.`);
      }

      // Step 2: Collect and sort inventory IDs for deterministic lock order.
      // [...new Set(array)] — spread into a Set to REMOVE DUPLICATES,
      // then spread back into an array (Set has no .sort() method).
      // WHY DEDUPLICATE: An order might have two line items from the same inventory row.
      //   Trying to lock the same row twice in the same transaction would deadlock.
      // WHY SORT: Deadlock prevention.
      //   Without sorting: Request A locks row-1 then row-2.
      //                    Request B locks row-2 then row-1.
      //                    Both are waiting for each other → DEADLOCK.
      //   With sorting:    Both requests always lock row-1 first, then row-2.
      //                    Request B blocks waiting for row-1.
      //                    No circular wait → no deadlock.
      // The ORDER BY id in the SQL below must MATCH this .sort() order.
      const inventoryIds = [...new Set(order.items.map((i) => i.inventoryId))].sort();

      // Step 3: Lock ALL required inventory rows in one query with FOR UPDATE ORDER BY id.
      // ANY(${inventoryIds}::text[]) is PostgreSQL syntax for IN with an array.
      // ::text[] casts the parameterized array to PostgreSQL text array type.
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

      // Build a Map for O(1) lookup when checking each order item below.
      const inventoryMap = new Map(lockedRows.map((r) => [r.id, r]));

      // Step 4: Check availability for EVERY order item BEFORE reserving ANY.
      // Collect ALL failures first, then report them all at once.
      // This gives the user a complete picture of what's insufficient,
      // instead of just showing the first failure.
      const insufficient: Array<{
        inventoryId: string;
        itemName: string;
        available: number;
        requested: number;
      }> = [];

      for (const item of order.items) {
        const inv = inventoryMap.get(item.inventoryId);
        if (!inv) throw new AppError(404, `Inventory record ${item.inventoryId} not found.`);

        const available = inv.physicalQty - inv.reservedQty;  // Always computed, never stored
        if (available < item.quantity) {
          insufficient.push({
            inventoryId: item.inventoryId,
            itemName: item.itemName,
            available,
            requested: item.quantity,
          });
        }
      }

      // MANDATORY TEST 1: If ANY item lacks sufficient stock, reject the ENTIRE order.
      // The third argument to AppError is `details` — carries structured data
      // that the error handler spreads into the response body.
      if (insufficient.length > 0) {
        throw new AppError(422, 'Insufficient available stock for one or more items.', {
          insufficientItems: insufficient,
        });
      }

      // Step 5: ALL items checked — reserve stock by incrementing reservedQty.
      // `increment: item.quantity` is Prisma's atomic increment:
      //   UPDATE inventory SET "reservedQty" = "reservedQty" + item.quantity WHERE id = ...
      // We only reach here if ALL checks passed — no partial reservation.
      for (const item of order.items) {
        await tx.inventory.update({
          where: { id: item.inventoryId },
          data: { reservedQty: { increment: item.quantity } },
        });
      }

      // Step 6: Mark order as CONFIRMED with a timestamp.
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

// ── PATCH /api/orders/:id/cancel ──────────────────────────────────────────────
// PENDING or CONFIRMED → CANCELLED
// If CONFIRMED: releases the reserved stock (decrements reservedQty).
// If PENDING: no inventory changes needed (stock was never reserved).
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

      // If the order was CONFIRMED, its items have been reserved.
      // We must release those reservations before cancelling.
      if (order.status === OrderStatus.CONFIRMED) {
        for (const item of order.items) {
          // `decrement: item.quantity` — atomic decrement, mirrors the increment in /confirm.
          await tx.inventory.update({
            where: { id: item.inventoryId },
            data: { reservedQty: { decrement: item.quantity } },
          });
        }
      }
      // If status was PENDING, no inventory changes needed — skip the loop above.

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
