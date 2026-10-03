// ============================================================
// FILE: backend/src/routes/auth.ts
// CONSTRUCTION ORDER: #18 — First route file
// HOW: mkdir -p src/routes && touch src/routes/auth.ts
// WHY FIRST: Written before all other route files because:
//   1. It validates the entire JWT + bcrypt system works end to end
//   2. Every other route requires authentication — you need working auth
//      before you can test anything else
//   3. It is the simplest route: no transactions, no row locking, no pagination
// WHY SEPARATE FROM src/app.ts:
//   Each route file is a self-contained Express Router module.
//   app.ts imports all routers and mounts them at their URL prefixes.
//   This separation keeps each feature's logic isolated and testable.
// ============================================================

// Router — Express's mini-app. We register routes on `router`, not on `app`.
// Request, Response — Express types for handler parameters.
import { Router, Request, Response } from 'express';
// body — express-validator function for validating request body fields.
// body('email').isEmail() declares a rule; validate() middleware checks the results.
import { body } from 'express-validator';
// bcryptjs — password hashing. bcrypt.compare(plain, hash) → Promise<boolean>
import bcrypt from 'bcryptjs';
// jsonwebtoken — JWT creation. jwt.sign(payload, secret, options) → string
import jwt from 'jsonwebtoken';
// The Prisma singleton — our single shared database connection.
import { prisma } from '../lib/prisma';
// validate — checks express-validator results and sends 422 if any failed.
import { validate } from '../middleware/validate';
// authenticate — verifies the JWT for the /me endpoint.
import { authenticate } from '../middleware/auth';
// AppError — throws typed HTTP errors that errorHandler.ts catches.
import { AppError } from '../middleware/errorHandler';
// AuthenticatedRequest — extends Request with `user?` property (for /me endpoint).
import { AuthenticatedRequest } from '../types';

// Create the router instance.
// All routes defined on `router` will be prefixed with '/api/auth' in app.ts.
const router = Router();

// Read JWT config once at module load time.
// ?? provides fallbacks for development when .env is not configured.
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev_secret_change_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '8h';

// ── POST /api/auth/login ───────────────────────────────────────────────────────
// The login endpoint. No authentication required (this IS the auth entry point).
// Uses plain `Request` (not AuthenticatedRequest) because the user has no token yet.
router.post(
  '/login',
  // Validation chain — declares rules; does NOT yet check or reject.
  // These run as middleware BEFORE validate() checks results.
  [
    // body('email') — targets req.body.email
    // .isEmail() — rejects values that are not valid email addresses
    // .withMessage() — custom error message if the rule fails
    // .normalizeEmail() — lowercases and trims the email (a@B.COM → a@b.com)
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),

    // body('password') — targets req.body.password
    // .notEmpty() — rejects empty strings and missing values
    body('password').notEmpty().withMessage('Password is required.'),
  ],
  // validate — reads the queued results; sends 422 if any rule failed.
  // If we reach the handler below, all validation passed.
  validate,

  // The async route handler.
  // `async` is required because all database and bcrypt operations are async (return Promises).
  // express-async-errors patches Express so `throw` here automatically reaches errorHandler.ts.
  async (req: Request, res: Response) => {

    // Destructure and cast req.body to the expected shape.
    // req.body is typed as `any` by Express — casting documents what we expect.
    // This is safe because the validation chain above already confirmed
    // email and password both exist and email is a valid format.
    const { email, password } = req.body as { email: string; password: string };

    // Step 1: Find the user by email.
    // findUnique → returns null if no user has this email.
    const user = await prisma.user.findUnique({ where: { email } });
    // { email } is shorthand for { email: email } — ES6 shorthand property.

    // Step 2: Reject if user not found OR account is inactive.
    // Combining both into one 401 is intentional security design:
    // If we said "email not found" vs "account disabled" separately,
    // an attacker could enumerate which emails are registered.
    // Same error message for both cases prevents user enumeration attacks.
    if (!user || !user.isActive) {
      throw new AppError(401, 'Invalid email or password.');
    }

    // Step 3: Compare the provided password against the stored bcrypt hash.
    // bcrypt.compare(plainText, hash) → Promise<boolean>
    // bcrypt extracts the salt from the stored hash, re-hashes the plain text,
    // and compares. This is the only correct way to check bcrypt passwords.
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      throw new AppError(401, 'Invalid email or password.');
      // Same message as above — don't reveal whether it was email or password that failed.
    }

    // Step 4: Create the JWT.
    // jwt.sign(payload, secret, options) → signed JWT string
    // Payload: the data encoded in the token (readable by anyone who has the token).
    //   We include userId, email, role — exactly what AuthenticatedRequest.user expects.
    //   We do NOT include the password hash — never put secrets in a JWT payload.
    // jwt.SignOptions type cast needed because TypeScript can't infer the options type here.
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions
    );

    // Step 5: Respond with the token and a safe user object.
    // CRITICAL: DO NOT include user.password in the response.
    // We explicitly build a safe object with only the fields the frontend needs.
    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        // password: user.password  ← NEVER DO THIS
      },
    });
  }
);

// ── GET /api/auth/me ───────────────────────────────────────────────────────────
// Returns the currently logged-in user's info from their JWT.
// ZERO database queries — all data comes from the verified JWT payload.
// This is how the frontend can check "who am I?" after a page reload.
router.get(
  '/me',
  // authenticate runs first — verifies the JWT, sets req.user.
  // If the token is missing or invalid, authenticate calls next(AppError(401,...))
  // and the handler below never runs.
  authenticate,

  // Handler — synchronous (no await needed, no database call).
  // Uses AuthenticatedRequest because req.user exists after authenticate runs.
  (req: AuthenticatedRequest, res: Response) => {
    // req.user was set by authenticate(). It contains { userId, email, role }.
    return res.json({ success: true, user: req.user });
  }
);

// Export the router as the default export.
// app.ts imports this as: import authRoutes from './routes/auth'
// Then mounts it: app.use('/api/auth', authRoutes)
// The '/login' route above becomes POST /api/auth/login
// The '/me' route above becomes GET /api/auth/me
export default router;
