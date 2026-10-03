// ============================================================
// FILE: backend/src/middleware/validate.ts
// CONSTRUCTION ORDER: #17
// HOW: touch src/middleware/validate.ts
// WHY NOW: Written after auth.ts, before any route files.
//          Every route file imports this function.
// WHAT THIS FILE DOES:
//   express-validator works in TWO steps:
//   Step 1 — Declare rules: body('email').isEmail().withMessage('...')
//             These are written inline in each route definition.
//             They run as middleware but only QUEUE validation results —
//             they do NOT automatically send error responses.
//   Step 2 — Check results: this validate() function reads those queued
//             results and sends a 422 response if any failed.
//
//   validate is placed as the LAST item in the validation array in each route,
//   right before the async handler. This ensures all rules run first,
//   then validate checks them all at once.
// ============================================================

// Import Express types for the middleware function signature.
import { Request, Response, NextFunction } from 'express';
// validationResult reads the queued validation errors from a request object.
// It's populated by the body(), param(), query() chains declared in route definitions.
import { validationResult } from 'express-validator';

// validate is a standard Express middleware (3 parameters, not 4 — not an error handler).
// It is exported as a named export and imported in every route file.
export function validate(req: Request, res: Response, next: NextFunction) {

  // validationResult(req) — reads all validation results that were queued
  // by the body()/param()/query() chains that ran before this middleware.
  // Returns a Result object with .isEmpty() and .array() methods.
  const errors = validationResult(req);

  // If there are NO errors → call next() to continue to the async route handler.
  if (!errors.isEmpty()) {

    // There ARE errors — respond with 422 Unprocessable Entity.
    // 422 is more specific than 400 (Bad Request):
    //   400 = "I don't understand the request syntax"
    //   422 = "I understand the request but the data is semantically invalid"
    // errors.array() returns: [{ type, msg, path, location, value }, ...]
    // Example: [{ type: 'field', msg: 'Valid email required', path: 'email', location: 'body' }]
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array(),  // Array of all validation errors with field names and messages
    });
  }

  // No validation errors — pass control to the next handler.
  return next();
}
