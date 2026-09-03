import { Router, Response } from 'express';
import { body, param } from 'express-validator';
import { prisma } from '../lib/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
import { Role } from '@prisma/client';

const router = Router();
router.use(authenticate);

const ADMIN_ONLY = [Role.ADMIN];
const ALL_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SALES];

// ─── GET /api/locations ───────────────────────────────────────────────────────
router.get('/', authorize(...ALL_ROLES), async (_req, res: Response) => {
  const locations = await prisma.location.findMany({
    orderBy: { name: 'asc' },
  });
  return res.json({ success: true, data: locations });
});

// ─── POST /api/locations ──────────────────────────────────────────────────────
router.post(
  '/',
  authorize(...ADMIN_ONLY),
  [
    body('name').notEmpty().withMessage('Location name is required.').trim(),
    body('address').optional().isString().trim(),
  ],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const { name, address } = req.body as { name: string; address?: string };

    const location = await prisma.location.create({
      data: { name, address },
    });

    return res.status(201).json({ success: true, data: location });
  }
);

// ─── GET /api/locations/:id ───────────────────────────────────────────────────
router.get(
  '/:id',
  authorize(...ALL_ROLES),
  [param('id').notEmpty()],
  validate,
  async (req: AuthenticatedRequest, res: Response) => {
    const location = await prisma.location.findUnique({
      where: { id: req.params.id },
    });
    if (!location) throw new AppError(404, 'Location not found.');
    return res.json({ success: true, data: location });
  }
);

export default router;
