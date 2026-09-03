/**
 * RBAC tests — Mandatory Test 5: unauthorized user cannot perform restricted operation.
 *
 * Verifies that every role boundary defined in the RBAC matrix is enforced
 * at the HTTP level (403 Forbidden).
 */
import './setup';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../app';
import { prisma } from '../lib/prisma';
import { Role } from '@prisma/client';

const PASSWORD = 'RbacTest123!';
let adminToken: string;
let opsToken: string;
let salesToken: string;
const createdUserIds: string[] = [];

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
  createdUserIds.push(user.id);
  return user;
}

async function getToken(email: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password: PASSWORD });
  return res.body.token as string;
}

beforeAll(async () => {
  const tag = Date.now().toString();
  const admin = await createUser(Role.ADMIN, tag);
  const ops = await createUser(Role.OPERATIONS, tag);
  const sales = await createUser(Role.SALES, tag);

  [adminToken, opsToken, salesToken] = await Promise.all([
    getToken(admin.email),
    getToken(ops.email),
    getToken(sales.email),
  ]);
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

// ── Unauthenticated requests ───────────────────────────────────────────────────

describe('Unauthenticated access', () => {
  it('GET /api/locations without token → 401', async () => {
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

// ── SALES role restrictions ───────────────────────────────────────────────────

describe('SALES role restrictions', () => {
  it('SALES cannot create a location (ADMIN only) → 403', async () => {
    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ name: 'Hacked Location' });
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

// ── OPERATIONS role restrictions ──────────────────────────────────────────────

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
