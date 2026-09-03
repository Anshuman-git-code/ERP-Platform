import { Request } from 'express';
import { Role } from '@prisma/client';

// ─── Authenticated Request ────────────────────────────────────────────────────

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
    role: Role;
  };
}

// ─── JWT Payload ──────────────────────────────────────────────────────────────

export interface JwtPayload {
  userId: string;
  email: string;
  role: Role;
  iat?: number;
  exp?: number;
}

// ─── API Response Helpers ─────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface PaginationQuery {
  page?: string;
  limit?: string;
  search?: string;
}
