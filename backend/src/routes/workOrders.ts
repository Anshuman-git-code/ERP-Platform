// ============================================================
// FILE: backend/src/routes/workOrders.ts
// CONSTRUCTION ORDER: #23
// HOW: touch src/routes/workOrders.ts
// WHY NOW: Written after inventory.ts because work orders reference items,
//          locations, AND inventory (to compute shortageQty).
// WHAT THIS FILE INTRODUCES (new concepts beyond previous routes):
//   - A private helper function for reusable business logic
//   - The `Record<Enum, Enum | null>` exhaustive state machine pattern
//   - Computed field enrichment: shortageQty = max(required - available, 0)
//   - Snapshot fields: capturing itemName/itemSku at creation time
//   - `Object.values(Enum)` for runtime enum value access
//   - Conditional spread for timestamps: startedAt, completedAt
// ============================================================

import { Router, Response } from 'express';
import { body, param, query } from 'express-validator';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
// WorkOrderStatus is the Prisma enum: ASSIGNED, IN_PROGRESS, COMPLETED
import { Role, WorkOrderStatus } from '@prisma/client';

const router = Router();
router.use(authenticate);

const ADMIN_ONLY = [Role.ADMIN];
const OPS_ADMIN = [Role.ADMIN, Role.OPERATIONS];
const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

// ── getInventoryAvailability() ────────────────────────────────────────────────
// A PRIVATE helper function — not exported, only used within this file.
// Computes the total available quantity for an item at a location,
// summing across all batch rows (there may be multiple batches for the same item+location).
//
// WHY NOT INLINE: Used in FOUR places (GET list, GET single, POST create, PATCH status).
// Extracting it avoids repeating the same 5 lines of logic in each handler.
//
// Parameter types are explicit — TypeScript requires annotations on function parameters.
// Return type is inferred: Promise<{ physicalQty: number; reservedQty: number; availableQty: number }>
async function getInventoryAvailability(itemId: string, locationId: string) {
  // findMany: finds ALL inventory rows for this item at this location (all batches).
  const records = await prisma.inventory.findMany({
    where: { itemId, locationId },
  });

  // Sum physicalQty and reservedQty across all matching rows.
  // reduce((accumulator, currentRecord) => accumulator + current, initialValue)
  // (s, r) shorthand: s = running sum, r = current row
  const physicalQty = records.reduce((s, r) => s + r.physicalQty, 0);
  const reservedQty = records.reduce((s, r) => s + r.reservedQty, 0);
  const availableQty = physicalQty - reservedQty;  // Never stored, always computed
  return { physicalQty, reservedQty, availableQty };
}

// ── GET /api/work-orders ──────────────────────────────────────────────────────
router.get(
  '/',
  authorize(...ALL_ROLES),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    // .isIn(Object.values(WorkOrderStatus)) — accepts 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'.
    // Object.values() on a Prisma enum returns the string values at runtime.
    query('status').optional().isIn(Object.values(WorkOrderStatus)),
    query('locationId').optional().isString(),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const page = parseInt((req.query.page as string) ?? '1', 10);
    const limit = parseInt((req.query.limit as string) ?? '20', 10);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.locationId) where.locationId = req.query.locationId;

    // Run the list query and count in parallel.
    const [workOrders, total] = await Promise.all([
      prisma.workOrder.findMany({
        where,
        skip,
        take: limit,
        include: {
          location: { select: { id: true, name: true } },
          item: { select: { id: true, name: true, sku: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.workOrder.count({ where }),
    ]);

    // ENRICH each work order with live availability data.
    // Promise.all on a .map of async functions runs all queries concurrently.
    // Pattern: await Promise.all(array.map(async (item) => { ... }))
    // This is the correct way to run async operations over an array in parallel.
    // (Using a plain for loop with await would be sequential — much slower.)
    const enriched = await Promise.all(
      workOrders.map(async (wo) => {
        const { availableQty } = await getInventoryAvailability(wo.itemId, wo.locationId);
        return {
          ...wo,            // All existing work order fields
          availableQty,     // Live: how much is available now
          // shortageQty: how many units are missing.
          // Math.max(x, 0) ensures we never return a negative shortage.
          // If requiredQty=20 and availableQty=25: shortage=0 (not -5)
          shortageQty: Math.max(wo.requiredQty - availableQty, 0),
        };
      })
    );

    return res.json({
      success: true,
      data: enriched,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  }
);

// ── POST /api/work-orders ─────────────────────────────────────────────────────
// ADMIN only — work order creation is a management task.
router.post(
  '/',
  authorize(...ADMIN_ONLY),
  [
    body('locationId').notEmpty().withMessage('locationId is required.'),
    body('itemId').notEmpty().withMessage('itemId is required.'),
    body('requiredQty').isInt({ min: 1 }).withMessage('requiredQty must be a positive integer.'),
    body('assignedToId').notEmpty().withMessage('assignedToId is required.'),
    body('notes').optional().isString().trim(),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { locationId, itemId, requiredQty, assignedToId, notes } = req.body as {
      locationId: string;
      itemId: string;
      requiredQty: number;
      assignedToId: string;
      notes?: string;
    };

    // Verify all three referenced records exist before creating the work order.
    // Running all three lookups concurrently with Promise.all.
    const [location, item, assignedUser] = await Promise.all([
      prisma.location.findUnique({ where: { id: locationId } }),
      prisma.item.findUnique({ where: { id: itemId } }),
      prisma.user.findUnique({ where: { id: assignedToId } }),
    ]);
    if (!location) throw new AppError(404, 'Location not found.');
    if (!item) throw new AppError(404, 'Item not found.');
    if (!assignedUser) throw new AppError(404, 'Assigned user not found.');

    // Generate the work order number: WO-00001, WO-00002, etc.
    // count() gives the total existing work orders.
    // String(count + 1).padStart(5, '0') → "00001", "00002"
    // NOTE: This has a race condition under high concurrency (two simultaneous POSTs
    // could read the same count). For work orders this is acceptable — a unique
    // constraint on workOrderNumber would catch the collision with a 409.
    const count = await prisma.workOrder.count();
    const workOrderNumber = `WO-${String(count + 1).padStart(5, '0')}`;

    const workOrder = await prisma.workOrder.create({
      data: {
        workOrderNumber,
        locationId,
        itemId,
        requiredQty,
        assignedToId,
        notes,
        createdById: req.user!.userId,
        // SNAPSHOT FIELDS: copy the item name and SKU at creation time.
        // If item.name changes later, this work order still shows the original name.
        // This is the "historical record" pattern — denormalize for auditability.
        itemName: item.name,
        itemSku: item.sku,
      },
      include: {
        location: { select: { id: true, name: true } },
        item: { select: { id: true, name: true, sku: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });

    // Compute live availability for the newly created work order.
    const { availableQty } = await getInventoryAvailability(itemId, locationId);

    return res.status(201).json({
      success: true,
      data: {
        ...workOrder,
        availableQty,
        shortageQty: Math.max(requiredQty - availableQty, 0),
      },
    });
  }
);

// ── GET /api/work-orders/:id ──────────────────────────────────────────────────
router.get(
  '/:id',
  authorize(...ALL_ROLES),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const wo = await prisma.workOrder.findUnique({
      where: { id: req.params.id },
      include: {
        location: { select: { id: true, name: true } },
        item: { select: { id: true, name: true, sku: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!wo) throw new AppError(404, 'Work order not found.');

    const { availableQty } = await getInventoryAvailability(wo.itemId, wo.locationId);

    return res.json({
      success: true,
      data: {
        ...wo,
        availableQty,
        shortageQty: Math.max(wo.requiredQty - availableQty, 0),
      },
    });
  }
);

// ── PATCH /api/work-orders/:id/status ─────────────────────────────────────────
// Advances the work order status. ENFORCES FORWARD-ONLY transitions.
// ASSIGNED → IN_PROGRESS → COMPLETED (cannot go backwards, cannot skip)
router.patch(
  '/:id/status',
  authorize(...OPS_ADMIN),
  [
    param('id').notEmpty(),
    // Validates that the provided status is one of the known enum values.
    // Object.values(WorkOrderStatus) = ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED']
    body('status').isIn(Object.values(WorkOrderStatus)).withMessage('Invalid status value.'),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    // Cast req.body.status to WorkOrderStatus.
    // This is safe because the validation above confirms it's a valid enum value.
    const newStatus = req.body.status as WorkOrderStatus;

    const wo = await prisma.workOrder.findUnique({ where: { id: req.params.id } });
    if (!wo) throw new AppError(404, 'Work order not found.');

    // ── State machine: allowed transitions ────────────────────────────────────
    // Record<WorkOrderStatus, WorkOrderStatus | null> — a TypeScript UTILITY TYPE.
    // Record<K, V> creates an object type where every key is K and every value is V.
    // Record<WorkOrderStatus, ...> means EVERY WorkOrderStatus value must be a key.
    // If you add a new status to the enum, TypeScript will ERROR here until you add
    // the new transition — this is COMPILE-TIME exhaustiveness checking.
    //
    // [WorkOrderStatus.ASSIGNED] is a COMPUTED PROPERTY KEY — the brackets evaluate
    // the expression and use its value as the object key.
    const transitions: Record<WorkOrderStatus, WorkOrderStatus | null> = {
      [WorkOrderStatus.ASSIGNED]: WorkOrderStatus.IN_PROGRESS,  // ASSIGNED can go to IN_PROGRESS
      [WorkOrderStatus.IN_PROGRESS]: WorkOrderStatus.COMPLETED,    // IN_PROGRESS can go to COMPLETED
      [WorkOrderStatus.COMPLETED]: null,                          // COMPLETED is terminal
    };

    // Look up what the allowed NEXT status is from the current status.
    // TypeScript infers allowedNext as WorkOrderStatus | null from the Record's value type.
    const allowedNext = transitions[wo.status];

    // If the requested new status doesn't match the allowed next → reject.
    if (newStatus !== allowedNext) {
      throw new AppError(
        400,
        `Invalid transition: ${wo.status} → ${newStatus}. Expected next status: ${allowedNext ?? 'none (already completed)'}.`
      );
    }

    const updated = await prisma.workOrder.update({
      where: { id: req.params.id },
      data: {
        status: newStatus,
        // Conditional spreads for timestamp fields:
        // Only set startedAt when transitioning to IN_PROGRESS.
        // Only set completedAt when transitioning to COMPLETED.
        // Pattern: ...(condition && { key: value })
        //   If condition is false → spreads false → no-op in JavaScript
        //   If condition is true → spreads { key: value } → adds field
        ...(newStatus === WorkOrderStatus.IN_PROGRESS && { startedAt: new Date() }),
        ...(newStatus === WorkOrderStatus.COMPLETED && { completedAt: new Date() }),
      },
      include: {
        location: { select: { id: true, name: true } },
        item: { select: { id: true, name: true, sku: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });

    return res.json({ success: true, data: updated });
  }
);

export default router;
