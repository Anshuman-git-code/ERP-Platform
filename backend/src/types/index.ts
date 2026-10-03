// ============================================================
// FILE: backend/src/types/index.ts
// CONSTRUCTION ORDER: #14
// HOW: mkdir -p src/types && touch src/types/index.ts
// WHY NOW: Written before middleware because:
//   1. auth.ts middleware imports AuthenticatedRequest and JwtPayload from here
//   2. Every protected route file imports AuthenticatedRequest from here
//   3. Having one central types file prevents type definitions from being
//      scattered across multiple files — one source of truth for shared types
// ============================================================

// Import the base Request type from Express.
// @types/express (installed as devDependency) provides this.
// Request gives us: .body, .params, .query, .headers, .method, .path, etc.
// We extend it below to add the .user property that auth middleware attaches.
import { Request } from 'express';

// Import the Role enum from the generated Prisma client.
// This enum has three values: Role.ADMIN, Role.OPERATIONS, Role.SALES
// It was defined in schema.prisma and generated into @prisma/client by `prisma generate`.
// Using this enum (not a plain string type) means TypeScript will catch typos like 'ADMN'.
import { Role } from '@prisma/client';

// ── AuthenticatedRequest ──────────────────────────────────────────────────────
// WHY THIS EXISTS:
// Express's built-in Request type does NOT have a `user` property.
// The `authenticate` middleware in auth.ts attaches the decoded JWT payload
// to req.user after verifying the token. But how does TypeScript know about that?
//
// SOLUTION: Extend the Request interface.
// `interface A extends B` creates a new type that has ALL of B's members
// plus the new ones declared in A. This is called interface extension.
//
// TypeScript's structural type system means: any function that accepts
// `AuthenticatedRequest` will also accept a plain `Request` (it has all the same
// base properties) — but any code that reads `req.user` needs AuthenticatedRequest.
//
// All protected route handlers use: async (req: AuthenticatedRequest, res: Response)
// The auth route (login) uses plain Request because users aren't authenticated yet.
export interface AuthenticatedRequest extends Request {
  // user? — the `?` makes this property OPTIONAL.
  // WHY OPTIONAL: The authenticate middleware sets req.user before the handler runs.
  // But TypeScript doesn't know that. If we made it non-optional (user: {...}),
  // TypeScript would complain that it's never initialized.
  // The trade-off: in routes where we KNOW user is set, we use `req.user!.userId`
  // (the non-null assertion `!`) to tell TypeScript "trust me, it's there."
  user?: {
    userId: string;   // The user's database ID (cuid from User.id)
    email: string;    // The user's email
    role: Role;       // The user's role (ADMIN | OPERATIONS | SALES)
  };
}

// ── JwtPayload ────────────────────────────────────────────────────────────────
// The shape of the data encoded INSIDE the JWT token.
// When the user logs in (POST /api/auth/login), we call:
//   jwt.sign({ userId, email, role }, JWT_SECRET, { expiresIn: '8h' })
// The object { userId, email, role } is the payload.
//
// When authenticate middleware verifies the token, it calls:
//   jwt.verify(token, JWT_SECRET) as JwtPayload
// The `as JwtPayload` cast tells TypeScript the decoded payload matches THIS interface.
//
// WHY NOT USE AuthenticatedRequest.user?
// jwt.verify returns the raw decoded payload, not a Request object.
// We need a standalone type to describe it before we've attached it to a request.
export interface JwtPayload {
  userId: string;
  email: string;
  role: Role;

  // iat and exp are automatically added by jsonwebtoken.
  // iat = "issued at" (Unix timestamp in seconds when the token was created)
  // exp = "expires at" (Unix timestamp when the token stops being valid)
  // They are OPTIONAL (?:) because:
  //   1. They're added by the library, not by our code
  //   2. They appear in the DECODED token but not in the PAYLOAD we pass to jwt.sign()
  //   3. If we made them required, TypeScript would demand we include them when
  //      constructing the type manually (which we never do)
  iat?: number;  // issued at — Unix timestamp
  exp?: number;  // expiration — Unix timestamp
}

// ── PaginatedResponse<T> ──────────────────────────────────────────────────────
// A generic interface for paginated API list responses.
//
// GENERICS EXPLAINED:
// <T> is a type parameter — a placeholder for whatever data type fills the list.
// When you write PaginatedResponse<Item>, TypeScript substitutes T = Item everywhere.
// So data becomes Item[] and the interface becomes specific to Items.
//
// WHY GENERIC: Without generics, you'd need:
//   interface PaginatedItems { data: Item[]; meta: {...} }
//   interface PaginatedOrders { data: Order[]; meta: {...} }
//   interface PaginatedTransfers { data: Transfer[]; meta: {...} }
// With generics, one interface works for ALL resource types.
//
// This interface is defined here but not explicitly used as a return type
// in route handlers (TypeScript infers the return type). It's available for
// frontend TypeScript code or future use.
export interface PaginatedResponse<T> {
  data: T[];          // Array of whatever type T is
  meta: {
    total: number;      // Total records in the database (for calculating total pages)
    page: number;       // Current page number (1-based)
    limit: number;      // Records per page
    totalPages: number; // Math.ceil(total / limit)
  };
}

// ── PaginationQuery ───────────────────────────────────────────────────────────
// The shape of query parameters for paginated list endpoints.
// All fields are optional (?:) because:
//   1. Query params are never guaranteed — a caller might omit them
//   2. Routes provide defaults: page=1, limit=20 when not provided
//
// All fields are string (not number) because:
//   URL query params ALWAYS arrive as strings.
//   ?page=2 arrives as the string "2", not the number 2.
//   Each route handler calls parseInt() to convert: parseInt(req.query.page as string, 10)
//
// The `as string` cast in routes is needed because TypeScript types req.query values
// as `string | string[] | ParsedQs` (could be array or nested object). The `as string`
// tells TypeScript we know it's a simple string in our case.
export interface PaginationQuery {
  page?: string;    // e.g., "1", "2", "10"
  limit?: string;   // e.g., "20", "50", "100"
  search?: string;  // e.g., "steel", "warehouse"
}
