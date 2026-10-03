// ============================================================
// FILE: backend/src/middleware/errorHandler.ts
// CONSTRUCTION ORDER: #15 — First middleware file
// HOW: mkdir -p src/middleware && touch src/middleware/errorHandler.ts
// WHY FIRST AMONG MIDDLEWARE:
//   auth.ts (written next) imports AppError from this file.
//   If we wrote auth.ts first, the import would fail because AppError
//   doesn't exist yet. Dependencies dictate order.
// WHY THIS FILE EXISTS:
//   Without a centralized error handler, every route would need to
//   manually catch errors and send responses. With one error handler:
//   1. Routes can `throw new AppError(404, 'Not found.')` and it's handled automatically
//   2. Prisma errors (P2002, P2025) are translated to HTTP responses in one place
//   3. Unexpected errors are logged and return a safe 500 response (no stack trace to client)
// ============================================================

// Import the Express types used in the error handler function signature.
import { Request, Response, NextFunction } from 'express';
// Import our logger for logging unexpected errors.
import { logger } from '../lib/logger';
// Import the Prisma namespace for error type checking.
// `Prisma` (not `PrismaClient`) is the namespace that contains error classes.
// Prisma.PrismaClientKnownRequestError is the error type for DB constraint violations.
import { Prisma } from '@prisma/client';

// ── AppError class ─────────────────────────────────────────────────────────────
// A custom error class that carries an HTTP status code and optional details.
//
// WHY EXTEND Error?
// JavaScript's try/catch and Express's error handling both work with Error objects.
// By extending Error, AppError:
//   1. Inherits .message, .stack, and .name from Error
//   2. Can be checked with `err instanceof AppError` in the error handler
//   3. Works with `throw new AppError(...)` just like `throw new Error(...)`
//
// WHY A CLASS (not just an object or function)?
// The `instanceof` check in errorHandler requires a class hierarchy.
// `instanceof AppError` tells TypeScript: "this is definitely an AppError,
// so .statusCode and .details are accessible without type assertion."
export class AppError extends Error {

  // Constructor with TypeScript parameter property shorthand.
  // `public statusCode: number` is a shorthand that simultaneously:
  //   1. Declares `statusCode` as a public property on the class
  //   2. Assigns the constructor argument to `this.statusCode`
  // Without the shorthand, you'd write:
  //   statusCode: number;
  //   constructor(statusCode: number) { this.statusCode = statusCode; }
  //
  // `public` means these properties are accessible from outside the class.
  // That's needed because errorHandler reads err.statusCode and err.details.
  //
  // `details?: unknown` — optional and typed as `unknown` (not `any`).
  // `unknown` is safer than `any`:
  //   - `any` would let callers access .insufficientItems without checking type first
  //   - `unknown` forces callers to type-check before accessing any property
  // The details field carries extra context (e.g., the list of items with insufficient stock).
  constructor(
    public statusCode: number,
    public message: string,
    public details?: unknown
  ) {
    // super(message) MUST be called first in any class that extends another class.
    // It calls Error's constructor, which:
    //   1. Sets this.message = message
    //   2. Captures the current call stack into this.stack
    // Without super(), the Error base class is not properly initialized.
    super(message);

    // Override the default .name property.
    // Error's default name is "Error". Setting it to 'AppError' means:
    //   - err.name === 'AppError' (useful for logging and debugging)
    //   - Stack traces show "AppError: Not found." instead of "Error: Not found."
    this.name = 'AppError';
  }
}

// ── errorHandler function ──────────────────────────────────────────────────────
// This is Express's ERROR handling middleware — it has 4 parameters.
// Express distinguishes error handlers from regular middleware by the 4th parameter.
// Regular middleware: (req, res, next) → 3 params
// Error middleware:   (err, req, res, next) → 4 params
//
// It is registered LAST in app.ts: app.use(errorHandler)
// express-async-errors patches Express so that `throw new AppError(...)` inside
// any async route handler automatically calls next(err) with that error,
// routing it here.
//
// eslint-disable-next-line comment: ESLint's no-unused-vars rule would flag `_next`
// (we receive it to satisfy Express's 4-param signature but never call it).
// The disable comment suppresses the warning for this specific line.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {

  // ── Case 1: Known application errors (AppError) ──────────────────────────
  // instanceof narrows the type: inside this block, TypeScript knows
  // err is AppError, so .statusCode and .details are accessible.
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      // Spread details into the response ONLY if they exist.
      // ...(condition ? { key: value } : {}) is the conditional spread pattern.
      // If details is undefined/null, spreads {} which adds nothing.
      // If details exists, spreads { details: err.details } into the response object.
      ...(err.details ? { details: err.details } : {}),
    });
  }

  // ── Case 2: Prisma database errors ───────────────────────────────────────
  // PrismaClientKnownRequestError covers constraint violations, not-found, etc.
  // These have a `.code` property with Prisma's documented error codes.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {

    // P2002 = Unique constraint violation.
    // Triggered when you try to insert a duplicate value into a unique column.
    // Example: creating two inventory rows with the same itemId+locationId+batchNumber.
    // We translate this to HTTP 409 Conflict.
    if (err.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: 'A record with this value already exists.',
        // err.meta contains extra info about the violation.
        // For P2002, meta.target is an array of the field names that violated the constraint.
        // Example: ["itemId", "locationId", "batchNumber"]
        // We cast err.meta to a specific shape to access .target safely.
        field: (err.meta as { target?: string[] })?.target,
      });
    }

    // P2025 = Record not found (for operations like update/delete where the record must exist).
    // Example: prisma.inventory.update({ where: { id: 'nonexistent' }, data: {...} })
    // We translate to HTTP 404.
    if (err.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Record not found.' });
    }
  }

  // ── Case 3: Unexpected errors (fallback) ─────────────────────────────────
  // Anything that doesn't match the above cases lands here.
  // We LOG the full details (message + stack) for debugging.
  // We NEVER send the stack trace to the client — it could expose implementation details.
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  return res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
}
