/**
 * Inventory tests — duplicate constraint, stock adjustments, idempotency key.
 */
import './setup';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../app';
import { prisma } from '../lib/prisma';
import { Role } from '@prisma/client';

const PASSWORD = 'InvTest123!';
let opsToken: string;
let opsUserId: string;
let locationId: string;
let itemId: string;
const tag = Date.now().toString();

beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const opsUser = await prisma.user.create({
    data: { name: 'Inv Ops', email: `inv-ops-${tag}@test.com`, password: hash, role: Role.OPERATIONS },
  });
  opsUserId = opsUser.id;
  opsToken = await request(app)
    .post('/api/auth/login')
    .send({ email: opsUser.email, password: PASSWORD })
    .then(r => r.body.token as string);

  const loc = await prisma.location.create({ data: { name: `INV-LOC-${tag}` } });
  locationId = loc.id;

  const item = await prisma.item.create({
    data: { name: `Inv Item ${tag}`, sku: `INV-ITEM-${tag}`, unitPrice: 10 },
  });
  itemId = item.id;
});

afterAll(async () => {
  await prisma.inventoryTransaction.deleteMany({ where: { inventory: { locationId } } });
  await prisma.inventory.deleteMany({ where: { locationId } });
  await prisma.item.delete({ where: { id: itemId } }).catch(() => null);
  await prisma.location.delete({ where: { id: locationId } }).catch(() => null);
  await prisma.user.delete({ where: { id: opsUserId } }).catch(() => null);
  await prisma.$disconnect();
});

// ── Create inventory ───────────────────────────────────────────────────────────

describe('Inventory creation', () => {
  let invId: string;

  it('creates an inventory record (201)', async () => {
    const res = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ itemId, locationId, physicalQty: 100 });

    expect(res.status).toBe(201);
    expect(res.body.data.physicalQty).toBe(100);
    expect(res.body.data.reservedQty).toBe(0);
    expect(res.body.data.availableQty).toBe(100);
    expect(res.body.data.batchNumber).toBe('DEFAULT');
    invId = res.body.data.id as string;
  });

  it('returns 409 when creating duplicate item/location/batch (DEFAULT)', async () => {
    const res = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ itemId, locationId, physicalQty: 50 }); // same item+location, no batch → DEFAULT

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('allows a different batchNumber for same item+location', async () => {
    const res = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ itemId, locationId, physicalQty: 25, batchNumber: 'BATCH-001' });

    expect(res.status).toBe(201);
    expect(res.body.data.batchNumber).toBe('BATCH-001');
    expect(res.body.data.physicalQty).toBe(25);
  });

  it('availableQty is always physicalQty - reservedQty', async () => {
    const res = await request(app)
      .get(`/api/inventory/${invId}`)
      .set('Authorization', `Bearer ${opsToken}`);

    const { physicalQty, reservedQty, availableQty } = res.body.data;
    expect(availableQty).toBe(physicalQty - reservedQty);
  });
});

// ── Stock adjustment ───────────────────────────────────────────────────────────

describe('Inventory adjustment', () => {
  let invId: string;

  beforeAll(async () => {
    const inv = await prisma.inventory.create({
      data: { itemId, locationId, batchNumber: `ADJ-${tag}`, physicalQty: 50 },
    });
    invId = inv.id;
  });

  it('IN adjustment increases physicalQty', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ transactionType: 'IN', quantity: 20, reason: 'Restock' });

    expect(res.status).toBe(200);
    expect(res.body.data.physicalQty).toBe(70);
    expect(res.body.data.availableQty).toBe(70);
  });

  it('OUT adjustment decreases physicalQty', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ transactionType: 'OUT', quantity: 10, reason: 'Damaged' });

    expect(res.status).toBe(200);
    expect(res.body.data.physicalQty).toBe(60);
  });

  it('OUT adjustment that would cause negative stock returns 422', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ transactionType: 'OUT', quantity: 999, reason: 'Impossible' });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/negative/i);
  });

  it('physicalQty is unchanged after failed OUT adjustment', async () => {
    const inv = await prisma.inventory.findUnique({ where: { id: invId } });
    expect(inv!.physicalQty).toBe(60);
  });

  it('duplicate referenceKey returns 409 (idempotency key uniqueness)', async () => {
    const key = `DEDUP-${tag}`;

    // First call succeeds
    const res1 = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ transactionType: 'IN', quantity: 5, referenceKey: key });
    expect(res1.status).toBe(200);

    // Second call with same key → 409 (unique constraint on referenceKey)
    const res2 = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ transactionType: 'IN', quantity: 5, referenceKey: key });
    expect(res2.status).toBe(409);
  });

  it('physicalQty reflects only one of the duplicate adjustments', async () => {
    const inv = await prisma.inventory.findUnique({ where: { id: invId } });
    // 60 + 5 = 65 (only one adjustment went through)
    expect(inv!.physicalQty).toBe(65);
  });

  it('quantity must be a positive integer — 0 returns 422', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ transactionType: 'IN', quantity: 0 });
    expect(res.status).toBe(422);
  });

  it('invalid transactionType returns 422', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ transactionType: 'BROKEN', quantity: 1 });
    expect(res.status).toBe(422);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('Inventory API validation', () => {
  it('POST /api/inventory without itemId returns 422', async () => {
    const res = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ locationId, physicalQty: 10 });
    expect(res.status).toBe(422);
  });

  it('POST /api/inventory with negative physicalQty returns 422', async () => {
    const res = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ itemId, locationId, physicalQty: -1 });
    expect(res.status).toBe(422);
  });

  it('GET /api/inventory/:id for non-existent id returns 404', async () => {
    const res = await request(app)
      .get('/api/inventory/nonexistent-id')
      .set('Authorization', `Bearer ${opsToken}`);
    expect(res.status).toBe(404);
  });
});
