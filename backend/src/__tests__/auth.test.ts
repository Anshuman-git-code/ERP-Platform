/**
 * ============================================================
 * FILE: backend/src/__tests__/auth.test.ts
 * CONSTRUCTION ORDER: #29 — First test file with actual tests
 * HOW: touch src/__tests__/auth.test.ts
 * WHY FIRST: Authentication is tested first because:
 *   1. It is the simplest test — no complex setup, no transactions
 *   2. Every other test needs auth tokens — testing auth first validates
 *      the foundation that all other tests depend on
 *   3. It tests the login endpoint, which is the entry point of the app
 * HOW TESTS WORK IN THIS PROJECT:
 *   - Tests use supertest to make real HTTP requests to the Express app
 *   - Tests use Prisma directly to set up and tear down test data
 *   - Tests use a real PostgreSQL test database (NOT mocks)
 *   - `import './setup'` must be the FIRST import — it overrides DATABASE_URL
 * ============================================================
 */
// MUST be the absolute first import — overrides DATABASE_URL, JWT_SECRET, etc.
// If this is not first, Prisma client is already created with the wrong DB URL.
import './setup';
// supertest — makes HTTP requests to the Express app in-process (no network port).
// request(app).post('/path').send(body) returns a Promise<Response>.
import request from 'supertest';
// bcryptjs — used to hash passwords for test user creation.
import bcrypt from 'bcryptjs';
// The Express app (not index.ts — we don't want a real server).
import app from '../app';
// Prisma client for directly creating/deleting test data.
import { prisma } from '../lib/prisma';
// Role enum for setting user roles in test data.
import { Role } from '@prisma/client';

// Unique email for each test run — prevents conflicts if a previous run crashed
// without cleaning up (Date.now() makes it unique per millisecond).
const TEST_EMAIL = `auth-test-${Date.now()}@test.com`;
const TEST_PASSWORD = 'TestPass123!';
// Variable to store the created user's ID for cleanup in afterAll.
let userId: string;

// beforeAll — runs ONCE before any test in this file.
// Creates the test user directly in the database.
// WHY DIRECTLY (not via API): We need control over the password hash and role.
// The registration endpoint doesn't exist in this API.
beforeAll(async () => {
  // Hash the password — same as the real login flow uses.
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  const user = await prisma.user.create({
    data: { name: 'Auth Test User', email: TEST_EMAIL, password: hash, role: Role.ADMIN },
  });
  userId = user.id;  // Save for cleanup
});

// afterAll — runs ONCE after ALL tests in this file complete (pass or fail).
// Deletes the test user and disconnects Prisma.
// .catch(() => null) — if the user was already deleted (some tests delete users),
// swallow the error rather than failing the cleanup.
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } }).catch(() => null);
  // Always disconnect — Prisma keeps connections open and Jest would hang without this.
  await prisma.$disconnect();
});

// ── describe() groups related tests ───────────────────────────────────────────
// describe(name, fn) — creates a named test group. Affects:
//   1. Output formatting (indented under the group name)
//   2. Scoping for beforeAll/afterAll/beforeEach/afterEach hooks

describe('POST /api/auth/login', () => {

  // it(name, fn) — a single test case. Alias for test().
  it('returns 200 + JWT + user object on valid credentials', async () => {
    // request(app) — supertest wraps the Express app.
    // .post('/api/auth/login') — sends a POST request.
    // .send({ ... }) — sets the request body (JSON by default in supertest).
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    // expect(value).toBe(expected) — strict equality assertion.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // typeof check — token is a string, not null or number.
    expect(typeof res.body.token).toBe('string');
    // token should be substantial — not a trivially short string.
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(res.body.user.email).toBe(TEST_EMAIL);
    expect(res.body.user.role).toBe('ADMIN');
    // SECURITY CHECK: password must NEVER appear in any login response.
    // JSON.stringify converts the entire body to a string so we can search it.
    expect(JSON.stringify(res.body)).not.toContain('hash');
    expect(res.body.user.password).toBeUndefined();
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: 'WrongPassword!' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 on unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@nowhere.com', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 422 when email is missing', async () => {
    // Only send password, no email — should fail validation.
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: TEST_PASSWORD });
    expect(res.status).toBe(422);  // 422 = Validation failed (from validate middleware)
  });

  it('returns 422 when password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL });
    expect(res.status).toBe(422);
  });

  it('returns 422 when email is not a valid email address', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: TEST_PASSWORD });
    expect(res.status).toBe(422);  // body('email').isEmail() catches this
  });

  it('returns 401 for an inactive user', async () => {
    // Create a SEPARATE inactive user for this specific test.
    const hash = await bcrypt.hash(TEST_PASSWORD, 10);
    const inactive = await prisma.user.create({
      data: {
        name: 'Inactive User',
        email: `inactive-${Date.now()}@test.com`,
        password: hash,
        role: Role.SALES,
        isActive: false,  // Explicitly disabled
      },
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: inactive.email, password: TEST_PASSWORD });

    expect(res.status).toBe(401);
    // Cleanup — delete this user right after the test (not waiting for afterAll).
    await prisma.user.delete({ where: { id: inactive.id } });
  });
});

describe('GET /api/auth/me', () => {
  // token is declared in the outer describe scope so inner tests can use it.
  let token: string;

  // beforeAll scoped to THIS describe block — runs before tests in this group only.
  beforeAll(async () => {
    // Get a valid token by logging in.
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    token = res.body.token as string;
    // `as string` — type assertion. TypeScript knows res.body is `any` (HTTP response),
    // so we assert it's a string to get proper type checking on `token` usage.
  });

  it('returns 200 + user payload for a valid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      // .set(header, value) — adds an HTTP header to the request.
      // Authorization: Bearer <token> is the standard JWT authentication format.
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.email).toBe(TEST_EMAIL);
    expect(res.body.user.role).toBe('ADMIN');
  });

  it('returns 401 when Authorization header is absent', async () => {
    // No .set('Authorization', ...) — header is missing entirely.
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);  // authenticate middleware rejects this
  });

  it('returns 401 for a malformed token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer this.is.garbage');
    expect(res.status).toBe(401);  // jwt.verify throws → 'Invalid token.'
  });

  it('returns 401 when the Bearer prefix is missing', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', token);  // Token without "Bearer " prefix
    expect(res.status).toBe(401);
    // authenticate checks: !authHeader?.startsWith('Bearer ')
    // Without the prefix, this check fails and returns 401.
  });
});
