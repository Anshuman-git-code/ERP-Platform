import 'dotenv/config';
import app from './app';
import { prisma } from './lib/prisma';
import { logger } from './lib/logger';

const PORT = parseInt(process.env.PORT ?? '4000', 10);

async function main() {
  // Guard: refuse to start in production with an insecure JWT secret
  const jwtSecret = process.env.JWT_SECRET ?? '';
  if (process.env.NODE_ENV === 'production') {
    if (!jwtSecret || jwtSecret === 'dev_secret_change_in_production') {
      logger.error(
        'JWT_SECRET is not set or is using the insecure dev fallback. ' +
        'Refusing to start in production.'
      );
      process.exit(1);
    }
  } else if (!jwtSecret) {
    logger.warn('JWT_SECRET is not set — using insecure dev fallback. Never use this in production.');
  }

  // Verify database connectivity before accepting traffic
  try {
    await prisma.$connect();
    logger.info('Database connection established');
  } catch (err) {
    logger.error('Failed to connect to database', { error: err });
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT} [${process.env.NODE_ENV ?? 'development'}]`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(async () => {
      await prisma.$disconnect();
      logger.info('Database disconnected');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Startup failed', { error: err });
  process.exit(1);
});
