import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { AuthenticatedRequest, JwtPayload } from '../types';
import { AppError } from './errorHandler';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev_secret_change_in_production';

/**
 * Verifies the JWT from the Authorization header and attaches the decoded
 * payload to req.user. Must be applied before authorize().
 */
export function authenticate(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError(401, 'Authentication token required.'));
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
    };
    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'Token expired.'));
    }
    return next(new AppError(401, 'Invalid token.'));
  }
}

/**
 * Factory that returns a middleware restricting access to specific roles.
 * Must be applied after authenticate().
 */
export function authorize(...roles: Role[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError(401, 'Authentication required.'));
    }
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError(403, `Access denied. Required role: ${roles.join(' or ')}.`)
      );
    }
    return next();
  };
}
