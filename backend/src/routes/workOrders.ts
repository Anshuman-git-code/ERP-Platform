import { Router, Response } from 'express';
import { body, param, query } from 'express-validator';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
import { Role, WorkOrderStatus } from '@prisma/client';

const router = Router();
router.use(authenticate);

const ADMIN_ONLY = [Role.ADMIN];
const OPS_ADMIN = [Role.ADMIN, Role.OPERATIONS];
const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

/** Fetch inventory at a location for an item and compute availability. */
async function getInventoryAvailability(itemId: string, locationId: string) {
  const records = await prisma.inventory.findMany({
    where: { itemId, locationId },
  });
  const physicalQty = records.reduce((s, r) => s + r.physicalQty, 0);
  const reservedQty = records.reduce((s, r) => s + r.reservedQty, 0);
  const availableQty = physicalQty - reservedQty;
  return { physicalQty, reservedQty, availableQty };
}

// ─── GET /api/work-orders ─────────────────────────────────────────────────────
router.get(
  '/',
  authorize(...ALL_ROLES),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
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

    // Compute shortage for each work order
    const enriched = await Promise.all(
      workOrders.map(async (wo) => {
        const { availableQty } = await getInventoryAvailability(wo.itemId, wo.locationId);
        return {
          ...wo,
          availableQty,
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

// ─── POST /api/work-orders ────────────────────────────────────────────────────
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

    // Verify references exist
    const [location, item, assignedUser] = await Promise.all([
      prisma.location.findUnique({ where: { id: locationId } }),
      prisma.item.findUnique({ where: { id: itemId } }),
      prisma.user.findUnique({ where: { id: assignedToId } }),
    ]);
    if (!location) throw new AppError(404, 'Location not found.');
    if (!item) throw new AppError(404, 'Item not found.');
    if (!assignedUser) throw new AppError(404, 'Assigned user not found.');

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
        // Snapshot item name/SKU at creation time
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

// ─── GET /api/work-orders/:id ─────────────────────────────────────────────────
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

// ─── PATCH /api/work-orders/:id/status ───────────────────────────────────────
// Status transitions: ASSIGNED → IN_PROGRESS → COMPLETED (forward only)
router.patch(
  '/:id/status',
  authorize(...OPS_ADMIN),
  [
    param('id').notEmpty(),
    body('status')
      .isIn(Object.values(WorkOrderStatus))
      .withMessage('Invalid status value.'),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const newStatus = req.body.status as WorkOrderStatus;

    const wo = await prisma.workOrder.findUnique({ where: { id: req.params.id } });
    if (!wo) throw new AppError(404, 'Work order not found.');

    // Enforce forward-only transitions
    const transitions: Record<WorkOrderStatus, WorkOrderStatus | null> = {
      [WorkOrderStatus.ASSIGNED]: WorkOrderStatus.IN_PROGRESS,
      [WorkOrderStatus.IN_PROGRESS]: WorkOrderStatus.COMPLETED,
      [WorkOrderStatus.COMPLETED]: null,
    };

    const allowedNext = transitions[wo.status];
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
