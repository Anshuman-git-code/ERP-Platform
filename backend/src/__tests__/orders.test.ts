/**
 * ============================================================
 * FILE: backend/src/__tests__/orders.test.ts
 * CONSTRUCTION ORDER: #33 — Last test file
 * HOW: touch src/__tests__/orders.test.ts
 * MANDATORY TEST COVERED:
 *   Test 1 — Cannot reserve more than available inventory.
 *   This includes the critical CONCURRENCY SCENARIO:
 *     Two requests fire simultaneously to reserve stock.
 *     Combined quantity exceeds available.
 *     Exactly ONE must succeed; the other must get 422.
 *     Final reservedQty must equal exactly what the winner reserved.
 * WHY LAST: The most complex test — requires understanding of:
 *   - The PENDING → CONFIRMED order lifecycle
 *   - How reservedQty relates to physicalQty and availableQty
 *   - Promise.all for concurrent HTTP requests
 *   - How SELECT FOR UPDATE prevents over-reservation
 * ============================================================
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
let inventoryId: string;  // Single inventory row — 20 units initially

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

  // Initial inventory: 20 units, none reserved.
  const inv = await prisma.inventory.create({
    data: { itemId, locationId, batchNumber: 'DEFAULT', physicalQty: 20, reservedQty: 0 },
  });
  inventoryId = inv.id;
});

afterAll(async () => {
  // Clean up child records before parent records.
  await prisma.orderItem.deleteMany({ where: { inventory: { id: inventoryId } } });
  await prisma.customerOrder.deleteMany({ where: { locationId } });
  await prisma.inventoryTransaction.deleteMany({ where: { inventoryId } });
  await prisma.inventory.delete({ where: { id: inventoryId } }).catch(() => null);
  await prisma.item.delete({ where: { id: itemId } }).catch(() => null);
  await prisma.location.delete({ where: { id: locationId } }).catch(() => null);
  await prisma.user.deleteMany({ where: { id: { in: [salesUserId, adminUserId] } } });
  await prisma.$disconnect();
});

// Helper: resets the inventory row to a known state between test groups.
// Using Prisma directly — faster than going through the API.
async function resetInventory(physicalQty: number, reservedQty = 0) {
  await prisma.inventory.update({ where: { id: inventoryId }, data: { physicalQty, reservedQty } });
}

// Helper: creates a PENDING order via the API and returns the full response.
async function createOrder(qty: number, token: string) {
  return request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      customerName: 'Test Customer',
      locationId,
      items: [{ inventoryId, quantity: qty }],
    });
}

// ── Happy path ────────────────────────────────────────────────────────────────
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

    // Verify the inventory row was updated by Prisma directly.
    const inv = await prisma.inventory.findUnique({ where: { id: inventoryId } });
    expect(inv!.reservedQty).toBe(8);
    // availableQty = physicalQty - reservedQty = 20 - 8 = 12
    expect(inv!.physicalQty - inv!.reservedQty).toBe(12);
  });

  it('cannot confirm an already-confirmed order (400)', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`);
    // Order is already CONFIRMED — status check in /confirm fails with 400.
    expect(res.status).toBe(400);
  });
});

// ── MANDATORY TEST 1: Over-reservation prevention ─────────────────────────────
describe('Mandatory Test 1 — cannot reserve more than available inventory', () => {
  beforeAll(async () => {
    await resetInventory(10, 0);  // 10 available
  });

  it('returns 422 when requested quantity exceeds available (10 available, request 15)', async () => {
    const createRes = await createOrder(15, salesToken);  // 15 > 10
    expect(createRes.status).toBe(201);  // Creation succeeds
    const orderId = createRes.body.data.id as string;

    const confirmRes = await request(app)
      .patch(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`);

    // MANDATORY TEST 1: Confirmation fails because 15 > 10 available.
    expect(confirmRes.status).toBe(422);
    expect(confirmRes.body.success).toBe(false);
    expect(confirmRes.body.message).toMatch(/insufficient/i);
    // The response includes structured details about what failed.
    expect(confirmRes.body.details.insufficientItems).toBeDefined();
    expect(confirmRes.body.details.insufficientItems[0].available).toBe(10);
    expect(confirmRes.body.details.insufficientItems[0].requested).toBe(15);
  });

  it('inventory reservedQty unchanged after failed reservation attempt', async () => {
    // The transaction rolled back — reservedQty must still be 0.
    const inv = await prisma.inventory.findUnique({ where: { id: inventoryId } });
    expect(inv!.reservedQty).toBe(0);
    expect(inv!.physicalQty).toBe(10);  // physicalQty unaffected
  });

  it('reservedQty can never exceed physicalQty', async () => {
    const inv = await prisma.inventory.findUnique({ where: { id: inventoryId } });
    expect(inv!.reservedQty).toBeLessThanOrEqual(inv!.physicalQty);
  });
});

// ── MANDATORY TEST 1 (concurrency) ────────────────────────────────────────────
describe('Mandatory Test 1 (concurrency) — two concurrent reservations cannot exceed available stock', () => {
  /**
   * SCENARIO: 10 units available. Two requests each want 8 units.
   * Combined = 16 > 10. Only ONE can succeed.
   *
   * HOW THIS WORKS WITHOUT THE FIX (naive implementation):
   *   Request A reads physicalQty=10, reservedQty=0 → available=10 → 10>=8 → PASS
   *   Request B reads physicalQty=10, reservedQty=0 → available=10 → 10>=8 → PASS
   *   Request A updates reservedQty to 8
   *   Request B updates reservedQty to 8 (overwrites A's update or adds to it → 16!)
   *   Result: reservedQty=16 > physicalQty=10 → CATASTROPHIC
   *
   * HOW THIS WORKS WITH THE FIX (SELECT FOR UPDATE):
   *   Request A starts transaction, SELECT FOR UPDATE on inventory row → LOCKED
   *   Request B starts transaction, SELECT FOR UPDATE → BLOCKED (waiting for A)
   *   Request A: available=10 >= 8 → reserves 8, commits → reservedQty=8
   *   Request B: lock released, reads reservedQty=8, available=10-8=2 < 8 → 422
   *   Result: reservedQty=8 ≤ physicalQty=10 → CORRECT
   */

  beforeAll(async () => {
    await resetInventory(10, 0);
  });

  it('only one of two simultaneous reservations succeeds when combined qty > available', async () => {
    // Create two PENDING orders (creation doesn't reserve — safe to do in parallel).
    const [createRes1, createRes2] = await Promise.all([
      createOrder(8, salesToken),
      createOrder(8, salesToken),
    ]);
    expect(createRes1.status).toBe(201);
    expect(createRes2.status).toBe(201);

    const orderId1 = createRes1.body.data.id as string;
    const orderId2 = createRes2.body.data.id as string;

    // THE CRITICAL ASSERTION: fire both confirm requests SIMULTANEOUSLY.
    // Promise.all fires both before either resolves.
    // Both requests hit the Express server at nearly the same time.
    // Both enter prisma.$transaction() and both try to SELECT FOR UPDATE.
    // PostgreSQL serializes them via the row lock — one wins, one waits and then fails.
    const [confirmRes1, confirmRes2] = await Promise.all([
      request(app).patch(`/api/orders/${orderId1}/confirm`).set('Authorization', `Bearer ${salesToken}`),
      request(app).patch(`/api/orders/${orderId2}/confirm`).set('Authorization', `Bearer ${salesToken}`),
    ]);

    const statuses = [confirmRes1.status, confirmRes2.status];
    const successCount = statuses.filter(s => s === 200).length;
    const failCount = statuses.filter(s => s === 422).length;

    // Exactly one must succeed (200), exactly one must fail (422).
    expect(successCount).toBe(1);
    expect(failCount).toBe(1);
  });

  it('final reservedQty equals exactly 8 — not 16 (no over-reservation)', async () => {
    const inv = await prisma.inventory.findUnique({ where: { id: inventoryId } });
    // Only one reservation of 8 went through.
    expect(inv!.reservedQty).toBe(8);
    expect(inv!.physicalQty).toBe(10);  // physicalQty unchanged (reservation only affects reservedQty)
    // Available = 10 - 8 = 2
    expect(inv!.physicalQty - inv!.reservedQty).toBe(2);
  });
});

// ── Cancellation releases reservation ─────────────────────────────────────────
describe('Order cancellation releases reserved stock', () => {
  let orderId: string;

  beforeAll(async () => {
    await resetInventory(20, 0);
    const createRes = await createOrder(10, salesToken);
    orderId = createRes.body.data.id as string;
    // Confirm so reservedQty = 10.
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
    expect(inv!.reservedQty).toBe(0);    // Reservation released
    expect(inv!.physicalQty).toBe(20);   // Physical unchanged
  });

  it('cannot cancel an already-cancelled order (400)', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(400);
  });
});

// ── Cannot confirm when availableQty = 0 ──────────────────────────────────────
describe('Cannot confirm order when availableQty = 0', () => {
  beforeAll(async () => {
    // physicalQty=5, reservedQty=5 → availableQty=0
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
