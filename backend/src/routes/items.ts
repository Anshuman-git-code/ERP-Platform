import { Router, Response } from 'express';
import { body, param, query } from 'express-validator';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
import { Role } from '@prisma/client';

const router = Router();
router.use(authenticate);

const OPS_ADMIN = [Role.ADMIN, Role.OPERATIONS];
const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

// ─── GET /api/items ───────────────────────────────────────────────────────────
router.get(
  '/',
  authorize(...ALL_ROLES),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().isString(),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const page = parseInt((req.query.page as string) ?? '1', 10);
    const limit = parseInt((req.query.limit as string) ?? '20', 10);
    const search = (req.query.search as string) ?? '';
    const skip = (page - 1) * limit;

    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { sku: { contains: search, mode: 'insensitive' as const } },
            { category: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      prisma.item.findMany({ where, skip, take: limit, orderBy: { name: 'asc' } }),
      prisma.item.count({ where }),
    ]);

    return res.json({
      success: true,
      data: items,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  }
);

// ─── POST /api/items ──────────────────────────────────────────────────────────
router.post(
  '/',
  authorize(...OPS_ADMIN),
  [
    body('name').notEmpty().withMessage('Item name is required.').trim(),
    body('sku').notEmpty().withMessage('SKU is required.').trim(),
    body('category').optional().isString().trim(),
    body('unitPrice')
      .isFloat({ min: 0 })
      .withMessage('Unit price must be a non-negative number.'),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { name, sku, category, unitPrice } = req.body as {
      name: string;
      sku: string;
      category?: string;
      unitPrice: number;
    };

    const item = await prisma.item.create({
      data: { name, sku, category, unitPrice },
    });

    return res.status(201).json({ success: true, data: item });
  }
);

// ─── GET /api/items/:id ───────────────────────────────────────────────────────
router.get(
  '/:id',
  authorize(...ALL_ROLES),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const item = await prisma.item.findUnique({ where: { id: req.params.id } });
    if (!item) throw new AppError(404, 'Item not found.');
    return res.json({ success: true, data: item });
  }
);

// ─── PUT /api/items/:id ───────────────────────────────────────────────────────
router.put(
  '/:id',
  authorize(...OPS_ADMIN),
  [
    param('id').notEmpty(),
    body('name').optional().notEmpty().trim(),
    body('category').optional().isString().trim(),
    body('unitPrice').optional().isFloat({ min: 0 }),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { name, category, unitPrice } = req.body as {
      name?: string;
      category?: string;
      unitPrice?: number;
    };

    const item = await prisma.item.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(category !== undefined && { category }),
        ...(unitPrice !== undefined && { unitPrice }),
      },
    });

    return res.json({ success: true, data: item });
  }
);

export default router;
