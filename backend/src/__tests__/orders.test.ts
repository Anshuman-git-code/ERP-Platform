/**
 * Customer Order / Reservation tests.
 *
 * Mandatory Test 1 — Cannot reserve more than available inventory.
 *
 * This includes the critical concurrency scenario:
 *   Two requests compete to reserve stock from the same inventory row.
 *   The combined quantity of both requests exceeds what is available.
 *   Exactly one must succeed; the other must fail with 422.
 *   The final reservedQty must never exceed the original physicalQty.
 *
 * Additional coverage:
 *   - Basic confirm happy path
 *   - Reservation increments reservedQty (availableQty decreases)
 *   - Cancel CONFIRMED order releases reservedQty
 *   - Cannot confirm an already-confirmed order
 *   - Cannot confirm when availableQty = 0
 */
import './setup';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../app';
import { prisma } from '../lib/prisma';
import { Role } from '@prisma/client';

const PASSWORD = 'OrderTest123!';
let salesToken: string;
let adminToken: string;
let salesUserId: string;
let adminUserId: string;

let locationId: string;
let itemId: string;
let inventoryId: string; // 20 units physicalQty, 0 reservedQty initially

const tag = Date.now().toString();

beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);

  const [salesUser, adminUser] = await Promise.all([
    prisma.user.create({
      data: { name: 'Order Sales', email: `ord-sales-${tag}@test.com`, password: hash, role: Role.SALES },
    }),
    prisma.user.create({
      data: { name: 'Order Admin', email: `ord-admin-${tag}@test.com`, password: hash, role: Role.ADMIN },
    }),
  ]);
  salesUserId = salesUser.id;
  adminUserId = adminUser.id;

  [salesToken, adminToken] = await Promise.all([
    request(app).post('/api/auth/login').send({ email: salesUser.email, password: PASSWORD }).then(r => r.body.token as string),
    request(app).post('/api/auth/login').send({ email: adminUser.email, password: PASSWORD }).then(r => r.body.token as string),
  ]);

  const loc = await prisma.location.create({ data: { name: `ORD-LOC-${tag}` } });
  locationId = loc.id;

  const item = await prisma.item.create({
    data: { name: `Order Item ${tag}`, sku: `ORD-ITEM-${tag}`, unitPrice: 50 },
  });
  itemId = item.id;

  // 20 units available, 0 reserved
  const inv = await prisma.inventory.create({
    data: { itemId, locationId, batchNumber: 'DEFAULT', physicalQty: 20, reservedQty: 0 },
  });
  inventoryId = inv.id;
});

afterAll(async () => {
  await prisma.orderItem.deleteMany({ where: { inventory: { id: inventoryId } } });
  await prisma.customerOrder.deleteMany({ where: { locationId } });
  await prisma.inventoryTransaction.deleteMany({ where: { inventoryId } });
  await prisma.inventory.delete({ where: { id: inventoryId } }).catch(() => null);
  await prisma.item.delete({ where: { id: itemId } }).catch(() => null);
  await prisma.location.delete({ where: { id: locationId } }).catch(() => null);
  await prisma.user.deleteMany({ where: { id: { in: [salesUserId, adminUserId] } } });
  await prisma.$disconnect();
});

// helper to reset inventory state between sub-tests
async function resetInventory(physicalQty: number, reservedQty = 0) {
  await prisma.inventory.update({ where: { id: inventoryId }, data: { physicalQty, reservedQty } });
}

// helper: create a PENDING order
async function createOrder(qty: number, token: string) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      customerName: 'Test Customer',
      locationId,
      items: [{ inventoryId, quantity: qty }],
    });
  return res;
}

// ── Basic happy path ───────────────────────────────────────────────────────────

describe('Order creation and confirmation — happy path', () => {
  let orderId: string;

  beforeAll(async () => {
    await resetInventory(20, 0);
  });

  it('creates a PENDING order (201)', async () => {
    const res = await createOrder(8, salesToken);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.totalQty).toBe(8);
    orderId = res.body.data.id as string;
  });

  it('confirms order (200) and increments reservedQty', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CONFIRMED');

    const inv = await prisma.inventory.findUnique({ where: { id: inventoryId } });
    expect(inv!.reservedQty).toBe(8);
    // availableQty = physicalQty - reservedQty = 20 - 8 = 12
    expect(inv!.physicalQty - inv!.reservedQty).toBe(12);
  });

  it('cannot confirm an already-confirmed order (400)', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(400);
  });
});

// ── Mandatory Test 1: Cannot reserve more than available ──────────────────────

describe('Mandatory Test 1 — cannot reserve more than available inventory', () => {
  beforeAll(async () => {
    await resetInventory(10, 0);
  });

  it('returns 422 when requested quantity exceeds available (10 available, request 15)', async () => {
    const createRes = await createOrder(15, salesToken); // 15 > 10
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.data.id as string;

    const confirmRes = await request(app)
      .patch(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`);

    expect(confirmRes.status).toBe(422);
    expect(confirmRes.body.success).toBe(false);
    expect(confirmRes.body.message).toMatch(/insufficient/i);
    expect(confirmRes.body.details.insufficientItems).toBeDefined();
    expect(confirmRes.body.details.insufficientItems[0].available).toBe(10);
    expect(confirmRes.body.details.insufficientItems[0].requested).toBe(15);
  });

  it('inventory reservedQty unchanged after failed reservation attempt', async () => {
    const inv = await prisma.inventory.findUnique({ where: { id: inventoryId } });
    expect(inv!.reservedQty).toBe(0); // no change
    expect(inv!.physicalQty).toBe(10);
  });

  it('reservedQty can never exceed physicalQty', async () => {
    const inv = await prisma.inventory.findUnique({ where: { id: inventoryId } });
    expect(inv!.reservedQty).toBeLessThanOrEqual(inv!.physicalQty);
  });
});

// ── Mandatory Test 1 (concurrency): two requests cannot collectively over-reserve ──

describe('Mandatory Test 1 (concurrency) — two concurrent reservations cannot exceed available stock', () => {
  /**
   * Scenario: 10 units available. Two requests each try to reserve 8.
   * Combined = 16 > 10. Exactly one must succeed; the other must fail.
   * Final reservedQty must equal exactly 8 (the one that succeeded).
   */

  beforeAll(async () => {
    await resetInventory(10, 0);
  });

  it('only one of two simultaneous reservations succeeds when combined qty > available', async () => {
    // Create two PENDING orders (creation does not reserve — that happens on confirm)
    const [createRes1, createRes2] = await Promise.all([
      createOrder(8, salesToken),
      createOrder(8, salesToken),
    ]);
    expect(createRes1.status).toBe(201);
    expect(createRes2.status).toBe(201);

    const orderId1 = createRes1.body.data.id as string;
    const orderId2 = createRes2.body.data.id as string;

    // Fire both confirms simultaneously
    const [confirmRes1, confirmRes2] = await Promise.all([
      request(app).patch(`/api/orders/${orderId1}/confirm`).set('Authorization', `Bearer ${salesToken}`),
      request(app).patch(`/api/orders/${orderId2}/confirm`).set('Authorization', `Bearer ${salesToken}`),
    ]);

    const statuses = [confirmRes1.status, confirmRes2.status];
    const successCount = statuses.filter(s => s === 200).length;
    const failCount = statuses.filter(s => s === 422).length;

    // Exactly one succeeds, exactly one fails
    expect(successCount).toBe(1);
    expect(failCount).toBe(1);
  });

  it('final reservedQty equals exactly 8 — not 16 (no over-reservation)', async () => {
    const inv = await prisma.inventory.findUnique({ where: { id: inventoryId } });
    // Only one reservation of 8 succeeded — reservedQty must be exactly 8
    expect(inv!.reservedQty).toBe(8);
    // physicalQty untouched (reservation only affects reservedQty)
    expect(inv!.physicalQty).toBe(10);
    // availableQty = 10 - 8 = 2
    expect(inv!.physicalQty - inv!.reservedQty).toBe(2);
  });
});

// ── Order cancellation releases reservation ────────────────────────────────────

describe('Order cancellation releases reserved stock', () => {
  let orderId: string;

  beforeAll(async () => {
    await resetInventory(20, 0);
    const createRes = await createOrder(10, salesToken);
    orderId = createRes.body.data.id as string;
    // Confirm first
    await request(app)
      .patch(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`);
  });

  it('before cancel: reservedQty = 10', async () => {
    const inv = await prisma.inventory.findUnique({ where: { id: inventoryId } });
    expect(inv!.reservedQty).toBe(10);
  });

  it('cancelling a CONFIRMED order releases its reservedQty', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${salesToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
  });

  it('after cancel: reservedQty returns to 0', async () => {
    const inv = await prisma.inventory.findUnique({ where: { id: inventoryId } });
    expect(inv!.reservedQty).toBe(0);
    expect(inv!.physicalQty).toBe(20);
  });

  it('cannot cancel an already-cancelled order (400)', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(400);
  });
});

// ── Cannot reserve when availableQty is zero ──────────────────────────────────

describe('Cannot confirm order when availableQty = 0', () => {
  beforeAll(async () => {
    // physicalQty = 5, reservedQty = 5 → availableQty = 0
    await resetInventory(5, 5);
  });

  it('returns 422 when availableQty is 0', async () => {
    const createRes = await createOrder(1, salesToken);
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.data.id as string;

    const res = await request(app)
      .patch(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`);

    expect(res.status).toBe(422);
    expect(res.body.details.insufficientItems[0].available).toBe(0);
  });
});
