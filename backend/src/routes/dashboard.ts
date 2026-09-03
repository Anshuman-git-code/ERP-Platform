import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';
import { Role, WorkOrderStatus, TransferStatus, OrderStatus } from '@prisma/client';

const router = Router();
router.use(authenticate);

const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

// ─── GET /api/dashboard ───────────────────────────────────────────────────────
router.get('/', authorize(...ALL_ROLES), async (_req: AuthenticatedRequest, res: Response) => {
  const [
    totalItems,
    totalLocations,
    totalInventoryRecords,
    openWorkOrders,
    pendingTransfers,
    dispatchedTransfers,
    pendingOrders,
    confirmedOrders,
  ] = await Promise.all([
    prisma.item.count(),
    prisma.location.count(),
    prisma.inventory.count(),
    prisma.workOrder.count({
      where: { status: { in: [WorkOrderStatus.ASSIGNED, WorkOrderStatus.IN_PROGRESS] } },
    }),
    prisma.stockTransfer.count({ where: { status: TransferStatus.REQUESTED } }),
    prisma.stockTransfer.count({ where: { status: TransferStatus.DISPATCHED } }),
    prisma.customerOrder.count({ where: { status: OrderStatus.PENDING } }),
    prisma.customerOrder.count({ where: { status: OrderStatus.CONFIRMED } }),
  ]);

  // Compute total available qty across all inventory
  const aggregates = await prisma.inventory.aggregate({
    _sum: { physicalQty: true, reservedQty: true },
  });
  const totalPhysical = aggregates._sum.physicalQty ?? 0;
  const totalReserved = aggregates._sum.reservedQty ?? 0;

  return res.json({
    success: true,
    data: {
      items: { total: totalItems },
      locations: { total: totalLocations },
      inventory: {
        records: totalInventoryRecords,
        totalPhysical,
        totalReserved,
        totalAvailable: totalPhysical - totalReserved,
      },
      workOrders: { open: openWorkOrders },
      transfers: { pending: pendingTransfers, dispatched: dispatchedTransfers },
      orders: { pending: pendingOrders, confirmed: confirmedOrders },
    },
  });
});

export default router;
