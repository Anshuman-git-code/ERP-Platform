import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import authRoutes from './routes/auth';
import locationRoutes from './routes/locations';
import itemRoutes from './routes/items';
import inventoryRoutes from './routes/inventory';
import workOrderRoutes from './routes/workOrders';
import transferRoutes from './routes/transfers';
import orderRoutes from './routes/orders';
import dashboardRoutes from './routes/dashboard';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './lib/logger';

const app = express();

// Trust proxy — required when running behind an ALB or nginx reverse proxy
app.set('trust proxy', 1);

// CORS
const allowedOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
app.use(cors({ origin: allowedOrigin, credentials: true }));

// Request logging
app.use(
  morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ──────────────────────────────────────────────────────────────
// Used by Docker, ALB target groups, and monitoring.
app.get('/health', async (_req, res) => {
  const start = Date.now();
  let dbStatus = 'ok';
  let dbLatencyMs = 0;

  try {
    const { prisma } = await import('./lib/prisma');
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - start;
  } catch {
    dbStatus = 'unreachable';
  }

  const healthy = dbStatus === 'ok';

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: process.env.npm_package_version ?? '1.0.0',
    environment: process.env.NODE_ENV ?? 'development',
    database: { status: dbStatus, latencyMs: dbLatencyMs },
  });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/work-orders', workOrderRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/dashboard', dashboardRoutes);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Centralised error handler — must be last
app.use(errorHandler);

export default app;
