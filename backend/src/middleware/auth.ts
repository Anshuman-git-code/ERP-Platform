// ============================================================
// FILE: backend/src/middleware/auth.ts
// CONSTRUCTION ORDER: #16
// HOW: touch src/middleware/auth.ts
// WHY NOW: Written after errorHandler.ts because it imports AppError from it.
//          Written before any route file because every route file imports
//          authenticate and authorize from here.
// WHAT THIS FILE DOES:
//   Exports two middleware functions:
//   1. authenticate() — verifies the JWT and attaches req.user
//   2. authorize(...roles) — checks req.user.role against allowed roles
//   These two functions are used together on EVERY protected route.
// ============================================================

// Import only the types we need from express (not Request — we use AuthenticatedRequest instead).
import { Response, NextFunction } from 'express';
// Import the jsonwebtoken library for JWT verification.
// jwt.verify() decodes and validates the token signature.
// jwt.TokenExpiredError is a specific error class we check for.
import jwt from 'jsonwebtoken';
// Import the Role enum from the generated Prisma client.
// Used as the type for the `roles` parameter in authorize().
import { Role } from '@prisma/client';
// Import our custom types — AuthenticatedRequest extends Express's Request
// with the `user?` property that this middleware attaches.
import { AuthenticatedRequest, JwtPayload } from '../types';
// Import AppError so we can throw typed HTTP errors.
// This is why errorHandler.ts had to be written BEFORE this file.
import { AppError } from './errorHandler';

// Read the JWT secret once at module load time (not on every request).
// process.env.JWT_SECRET — set in .env for development, injected from SSM in production.
// ?? 'dev_secret_...' — fallback used when JWT_SECRET is not set in .env.
// index.ts refuses to start in production if this fallback is detected.
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev_secret_change_in_production';

// ── authenticate() ────────────────────────────────────────────────────────────
// Middleware: verifies the Bearer token in the Authorization header.
// If valid: attaches decoded payload to req.user and calls next().
// If invalid: calls next(new AppError(401, ...)) to trigger error handler.
//
// Parameter types:
//   req: AuthenticatedRequest — extends Request with `user?` property
//   _res: Response — underscore prefix = intentionally unused parameter
//         (required by Express middleware signature but not used here)
//   next: NextFunction — must be called to continue the middleware chain
export function authenticate(req: AuthenticatedRequest, _res: Response, next: NextFunction) {

  // Step 1: Read the Authorization header.
  // Standard HTTP auth format: "Authorization: Bearer eyJhbGci..."
  // req.headers.authorization is `string | undefined` — it may not be present.
  const authHeader = req.headers.authorization;

  // Step 2: Check header exists and has the "Bearer " prefix.
  // Optional chaining `?.`: if authHeader is undefined, .startsWith() is not called
  //   (returns undefined), and the `!` makes the condition true → send 401.
  // Without `?.`, calling .startsWith() on undefined would throw a TypeError at runtime.
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError(401, 'Authentication token required.'));
  }

  // Step 3: Extract the token by slicing off the "Bearer " prefix (7 characters).
  // authHeader = "Bearer eyJhbGci..."
  // authHeader.slice(7) = "eyJhbGci..."
  const token = authHeader.slice(7);

  // Step 4: Verify the token signature and decode the payload.
  try {
    // jwt.verify() does two things:
    //   1. Verifies the signature using JWT_SECRET (prevents token forgery)
    //   2. Checks the `exp` claim (rejects expired tokens)
    // It throws if either check fails.
    //
    // Return type: string | JwtPayload (jsonwebtoken's generic return type)
    // `as JwtPayload` — casts to our specific interface.
    // Safe because we control what we put in the payload when signing in auth.ts.
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;

    // Step 5: Attach the decoded payload to req.user.
    // This is what every protected route handler reads:
    //   req.user!.userId, req.user!.role, etc.
    req.user = {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
    };

    // Step 6: Call next() to pass control to the next middleware or route handler.
    return next();

  } catch (err) {
    // Step 7: Handle JWT errors.
    // Under "strict": true in tsconfig.json, catch(err) types err as `unknown`.
    // We CANNOT access err.message without first narrowing the type.
    // `instanceof jwt.TokenExpiredError` narrows `unknown` to `jwt.TokenExpiredError`.
    //
    // WHY TWO DIFFERENT MESSAGES?
    // "Token expired" vs "Invalid token" gives the user actionable feedback:
    //   - "Token expired" → they need to log in again (token was valid but expired)
    //   - "Invalid token" → something is wrong with the token itself (tampered, malformed)
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'Token expired.'));
    }
    return next(new AppError(401, 'Invalid token.'));
  }
}

// ── authorize() ────────────────────────────────────────────────────────────────
// A HIGHER-ORDER FUNCTION — it takes role arguments and RETURNS a middleware function.
//
// Usage in routes:
//   router.get('/', authorize(Role.ADMIN, Role.OPERATIONS), handler)
//   authorize() is called with roles → returns a middleware → Express calls that middleware
//
// WHY HIGHER-ORDER?
// We need to configure authorize with different roles per endpoint.
// If authorize were a plain middleware, it couldn't accept configuration.
// By making it a function that returns a middleware, we can parameterize it.
//
// `...roles: Role[]` — REST PARAMETER:
//   `...` collects all arguments into an array.
//   authorize(Role.ADMIN, Role.OPERATIONS) → roles = [Role.ADMIN, Role.OPERATIONS]
//   Role[] — TypeScript type: array of Role enum values.
export function authorize(...roles: Role[]) {

  // Return the actual middleware function.
  // This inner function is what Express actually calls during request processing.
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {

    // Step 1: Verify authenticate() ran before this.
    // authenticate() sets req.user; if it's missing, something is wrong.
    // After this guard, TypeScript NARROWS req.user from
    //   `{ userId: string; email: string; role: Role } | undefined`
    // to just:
    //   `{ userId: string; email: string; role: Role }`
    // This is truthiness narrowing — the `if (!req.user)` eliminates the undefined case.
    if (!req.user) {
      return next(new AppError(401, 'Authentication required.'));
    }

    // Step 2: Check if the user's role is in the allowed roles array.
    // Array.includes() returns true if req.user.role is in the roles array.
    // If NOT included → user doesn't have permission → 403 Forbidden.
    if (!roles.includes(req.user.role)) {
      return next(
        // Template literal joins roles into a readable message:
        // authorize(Role.ADMIN, Role.OPERATIONS) →
        //   "Access denied. Required role: ADMIN or OPERATIONS."
        new AppError(403, `Access denied. Required role: ${roles.join(' or ')}.`)
      );
    }

    // Step 3: Role check passed — call next() to continue to the route handler.
    return next();
  };
}
