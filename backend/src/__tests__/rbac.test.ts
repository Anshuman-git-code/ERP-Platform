/**
 * ============================================================
 * FILE: backend/src/__tests__/rbac.test.ts
 * CONSTRUCTION ORDER: #30
 * HOW: touch src/__tests__/rbac.test.ts
 * WHY NOW: Written after auth.test.ts because it uses the same login
 *          pattern (get a token, then make requests with it).
 * WHAT THIS FILE TESTS:
 *   MANDATORY TEST 5: Unauthorized users cannot perform restricted operations.
 *   Tests EVERY role boundary in the system:
 *     - Unauthenticated requests → 401
 *     - SALES doing ADMIN/OPS operations → 403
 *     - OPERATIONS doing ADMIN/SALES operations → 403
 *     - ADMIN doing permitted operations → 200 (sanity check)
 * KEY INSIGHT: These tests don't create real data (no locations, items, etc.).
 *   They send requests to protected endpoints and check the HTTP status code.
 *   A 403 response means the role check worked BEFORE the handler ran.
 *   We don't need real data to test authorization — just a real token.
 * ============================================================
 */
import './setup';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../app';
import { prisma } from '../lib/prisma';
import { Role } from '@prisma/client';

const PASSWORD = 'RbacTest123!';
// Tokens for each role — populated in beforeAll.
let adminToken: string;
let opsToken: string;
let salesToken: string;
// Track all created user IDs for cleanup in afterAll.
const createdUserIds: string[] = [];

// Helper function: creates a user with the given role and returns it.
// Uses a unique suffix to prevent email conflicts between test runs.
async function createUser(role: Role, suffix: string) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const user = await prisma.user.create({
    data: {
      name: `RBAC ${role} ${suffix}`,
      email: `rbac-${role.toLowerCase()}-${suffix}@test.com`,
      password: hash,
      role,
    },
  });
  // Push to cleanup array — afterAll will delete all of these.
  createdUserIds.push(user.id);
  return user;
}

// Helper function: gets a JWT token for a given email/password.
async function getToken(email: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password: PASSWORD });
  // res.body.token is typed as `any` — cast to string for proper TypeScript usage.
  return res.body.token as string;
}

beforeAll(async () => {
  const tag = Date.now().toString();
  // Create one user per role, all with the same tag for easy identification.
  const admin = await createUser(Role.ADMIN, tag);
  const ops = await createUser(Role.OPERATIONS, tag);
  const sales = await createUser(Role.SALES, tag);

  // Get tokens for all three users in parallel.
  [adminToken, opsToken, salesToken] = await Promise.all([
    getToken(admin.email),
    getToken(ops.email),
    getToken(sales.email),
  ]);
});

afterAll(async () => {
  // Delete all users created in this test file.
  // deleteMany with an `in` filter deletes all matching records in one query.
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

// ── Unauthenticated requests should get 401 ───────────────────────────────────
describe('Unauthenticated access', () => {

  it('GET /api/locations without token → 401', async () => {
    // No .set('Authorization', ...) — no token at all.
    // authenticate middleware runs and returns 401 before the handler.
    const res = await request(app).get('/api/locations');
    expect(res.status).toBe(401);
  });

  it('GET /api/inventory without token → 401', async () => {
    const res = await request(app).get('/api/inventory');
    expect(res.status).toBe(401);
  });

  it('GET /api/work-orders without token → 401', async () => {
    const res = await request(app).get('/api/work-orders');
    expect(res.status).toBe(401);
  });

  it('GET /api/transfers without token → 401', async () => {
    const res = await request(app).get('/api/transfers');
    expect(res.status).toBe(401);
  });

  it('GET /api/orders without token → 401', async () => {
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(401);
  });
});

// ── SALES role restrictions ────────────────────────────────────────────────────
// SALES users can READ everything but cannot CREATE/MODIFY most things.
describe('SALES role restrictions', () => {

  it('SALES cannot create a location (ADMIN only) → 403', async () => {
    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ name: 'Hacked Location' });
    // 403 = Forbidden — authenticate passed (valid token) but authorize failed (wrong role).
    expect(res.status).toBe(403);
  });

  it('SALES cannot create an item (OPS_ADMIN only) → 403', async () => {
    const res = await request(app)
      .post('/api/items')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ name: 'Hacked Item', sku: 'HACK-001', unitPrice: 1 });
    expect(res.status).toBe(403);
  });

  it('SALES cannot adjust inventory (OPS_ADMIN only) → 403', async () => {
    // We don't need a real inventory ID — the role check happens first.
    // 403 is returned before Prisma even runs, so 'some-id' never reaches the DB.
    const res = await request(app)
      .patch('/api/inventory/some-id/adjust')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ transactionType: 'IN', quantity: 10 });
    expect(res.status).toBe(403);
  });

  it('SALES cannot create a work order (ADMIN only) → 403', async () => {
    const res = await request(app)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ locationId: 'x', itemId: 'x', requiredQty: 1, assignedToId: 'x' });
    expect(res.status).toBe(403);
  });

  it('SALES cannot update work order status (OPS_ADMIN only) → 403', async () => {
    const res = await request(app)
      .patch('/api/work-orders/some-id/status')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(403);
  });

  it('SALES cannot create a transfer (OPS_ADMIN only) → 403', async () => {
    const res = await request(app)
      .post('/api/transfers')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ sourceLocationId: 'a', destLocationId: 'b', itemId: 'x', quantity: 1 });
    expect(res.status).toBe(403);
  });

  it('SALES cannot dispatch a transfer (OPS_ADMIN only) → 403', async () => {
    const res = await request(app)
      .patch('/api/transfers/some-id/dispatch')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(403);
  });

  it('SALES cannot receive a transfer (OPS_ADMIN only) → 403', async () => {
    const res = await request(app)
      .patch('/api/transfers/some-id/receive')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(403);
  });
});

// ── OPERATIONS role restrictions ───────────────────────────────────────────────
describe('OPERATIONS role restrictions', () => {

  it('OPERATIONS cannot create a location (ADMIN only) → 403', async () => {
    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name: 'Ops Hacked Location' });
    expect(res.status).toBe(403);
  });

  it('OPERATIONS cannot create a work order (ADMIN only) → 403', async () => {
    const res = await request(app)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ locationId: 'x', itemId: 'x', requiredQty: 1, assignedToId: 'x' });
    expect(res.status).toBe(403);
  });

  it('OPERATIONS cannot confirm a customer order (SALES_ADMIN only) → 403', async () => {
    const res = await request(app)
      .patch('/api/orders/some-id/confirm')
      .set('Authorization', `Bearer ${opsToken}`);
    expect(res.status).toBe(403);
  });

  it('OPERATIONS cannot cancel a customer order (SALES_ADMIN only) → 403', async () => {
    const res = await request(app)
      .patch('/api/orders/some-id/cancel')
      .set('Authorization', `Bearer ${opsToken}`);
    expect(res.status).toBe(403);
  });
});

// ── ADMIN permitted actions (sanity check) ────────────────────────────────────
// These verify that ADMIN can READ all resources.
// They return 200 (empty list) rather than 403 — confirming ADMIN has full access.
describe('ADMIN role — permitted read operations', () => {

  it('ADMIN can GET /api/locations → 200', async () => {
    const res = await request(app)
      .get('/api/locations')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('ADMIN can GET /api/inventory → 200', async () => {
    const res = await request(app)
      .get('/api/inventory')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('ADMIN can GET /api/work-orders → 200', async () => {
    const res = await request(app)
      .get('/api/work-orders')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('ADMIN can GET /api/transfers → 200', async () => {
    const res = await request(app)
      .get('/api/transfers')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('ADMIN can GET /api/orders → 200', async () => {
    const res = await request(app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});
