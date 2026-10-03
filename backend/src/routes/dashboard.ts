// ============================================================
// FILE: backend/src/routes/dashboard.ts
// CONSTRUCTION ORDER: #21
// HOW: touch src/routes/dashboard.ts
// WHY NOW: Written before the complex routes (inventory, orders, transfers)
//          because it is entirely READ-ONLY — no writes, no transactions.
//          It teaches the Promise.all pattern with many concurrent queries
//          in a safe context before applying it to business-critical routes.
// WHAT THIS FILE DOES:
//   One endpoint: GET /api/dashboard
//   Runs 8 count queries + 1 aggregate query ALL IN PARALLEL using Promise.all.
//   Returns a summary of the entire system state for the frontend dashboard.
// ============================================================

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';
// Import all the status enums needed for filtered counts.
// These come from @prisma/client, generated from schema.prisma.
import { Role, WorkOrderStatus, TransferStatus, OrderStatus } from '@prisma/client';

const router = Router();
router.use(authenticate);  // Dashboard is accessible to all authenticated users

const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

// ── GET /api/dashboard ────────────────────────────────────────────────────────
// No pagination params, no path params — just a single aggregation endpoint.
// The handler is a direct inline async function (no separate validation array needed).
router.get('/', authorize(...ALL_ROLES), async (_req: AuthenticatedRequest, res: Response) => {

  // Promise.all([p1, p2, ..., p8]) — runs ALL 8 promises concurrently.
  // Without Promise.all: each await would wait for the previous to finish.
  //   Sequential: 8 queries × ~5ms each = ~40ms total
  // With Promise.all: all queries hit the database simultaneously.
  //   Concurrent: max(query times) ≈ ~5ms total
  // The array destructuring assigns each result to a named variable.
  // The ORDER of variables must match the ORDER of promises in the array.
  const [
    totalItems,           // Total product catalog entries
    totalLocations,       // Total warehouse/location records
    totalInventoryRecords,// Total inventory rows (item+location+batch combinations)
    openWorkOrders,       // Work orders not yet COMPLETED
    pendingTransfers,     // Transfers in REQUESTED state (not dispatched yet)
    dispatchedTransfers,  // Transfers in DISPATCHED state (in transit)
    pendingOrders,        // Customer orders not yet confirmed
    confirmedOrders,      // Customer orders confirmed (stock reserved)
  ] = await Promise.all([
    prisma.item.count(),
    prisma.location.count(),
    prisma.inventory.count(),

    // Count work orders that are STILL ACTIVE (not completed).
    // { status: { in: [...] } } — Prisma's IN operator: WHERE status IN ('ASSIGNED', 'IN_PROGRESS')
    prisma.workOrder.count({
      where: { status: { in: [WorkOrderStatus.ASSIGNED, WorkOrderStatus.IN_PROGRESS] } },
    }),

    // Count transfers awaiting dispatch
    prisma.stockTransfer.count({ where: { status: TransferStatus.REQUESTED } }),

    // Count transfers currently in transit
    prisma.stockTransfer.count({ where: { status: TransferStatus.DISPATCHED } }),

    // Count orders awaiting confirmation
    prisma.customerOrder.count({ where: { status: OrderStatus.PENDING } }),

    // Count confirmed orders (these have reserved stock)
    prisma.customerOrder.count({ where: { status: OrderStatus.CONFIRMED } }),
  ]);

  // A SECOND database call — runs after the parallel block above completes.
  // aggregate() with _sum computes SUM() across all rows.
  // This gives us total physical stock and total reserved stock across ALL locations.
  const aggregates = await prisma.inventory.aggregate({
    _sum: {
      physicalQty: true,  // SUM("physicalQty") FROM inventory
      reservedQty: true,  // SUM("reservedQty") FROM inventory
    },
  });

  // _sum values can be null if the table is empty (no rows to sum).
  // ?? 0 provides a safe default of 0 in that case.
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
        // availableQty is always computed, never stored — same principle as individual rows
        totalAvailable: totalPhysical - totalReserved,
      },
      workOrders: { open: openWorkOrders },
      transfers: { pending: pendingTransfers, dispatched: dispatchedTransfers },
      orders: { pending: pendingOrders, confirmed: confirmedOrders },
    },
  });
});

export default router;
