/**
 * ============================================================
 * FILE: backend/src/__tests__/inventory.test.ts
 * CONSTRUCTION ORDER: #31
 * HOW: touch src/__tests__/inventory.test.ts
 * WHAT THIS FILE TESTS:
 *   - Inventory creation (201, unique constraint → 409, different batch → 201)
 *   - availableQty computed correctly at all times
 *   - IN/OUT stock adjustments
 *   - Negative stock prevention (422)
 *   - Idempotency key (referenceKey) preventing duplicate transactions
 *   - Validation rejections (422 for missing fields, wrong types)
 * ============================================================
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
// Date.now() as a unique tag prevents data collisions between test runs.
const tag = Date.now().toString();

beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const opsUser = await prisma.user.create({
    data: { name: 'Inv Ops', email: `inv-ops-${tag}@test.com`, password: hash, role: Role.OPERATIONS },
  });
  opsUserId = opsUser.id;
  // Get token by logging in via the API (tests the real login flow).
  opsToken = await request(app)
    .post('/api/auth/login')
    .send({ email: opsUser.email, password: PASSWORD })
    // .then() chains off the Promise — extracts the token string from the response.
    .then(r => r.body.token as string);

  // Create test fixtures directly via Prisma (not via API).
  const loc = await prisma.location.create({ data: { name: `INV-LOC-${tag}` } });
  locationId = loc.id;

  const item = await prisma.item.create({
    data: { name: `Inv Item ${tag}`, sku: `INV-ITEM-${tag}`, unitPrice: 10 },
  });
  itemId = item.id;
});

afterAll(async () => {
  // Cleanup in DEPENDENCY ORDER — child records before parent records.
  // Prisma enforces foreign key constraints, so deleting inventory before
  // deleting transactions would fail (transactions reference inventory rows).
  await prisma.inventoryTransaction.deleteMany({ where: { inventory: { locationId } } });
  await prisma.inventory.deleteMany({ where: { locationId } });
  await prisma.item.delete({ where: { id: itemId } }).catch(() => null);
  await prisma.location.delete({ where: { id: locationId } }).catch(() => null);
  await prisma.user.delete({ where: { id: opsUserId } }).catch(() => null);
  await prisma.$disconnect();
});

// ── Inventory creation ────────────────────────────────────────────────────────
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
    // availableQty is computed by withAvailable() in inventory.ts:
    //   availableQty = physicalQty - reservedQty = 100 - 0 = 100
    expect(res.body.data.availableQty).toBe(100);
    // Default batch when none provided.
    expect(res.body.data.batchNumber).toBe('DEFAULT');
    invId = res.body.data.id as string;
  });

  it('returns 409 when creating duplicate item/location/batch (DEFAULT)', async () => {
    // Same itemId + locationId + no batch (→ DEFAULT) = duplicate → 409 Conflict.
    // The @@unique([itemId, locationId, batchNumber]) constraint in schema.prisma
    // generates a PostgreSQL unique index → P2002 → errorHandler → 409.
    const res = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ itemId, locationId, physicalQty: 50 });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('allows a different batchNumber for same item+location', async () => {
    // Different batchNumber means the @@unique constraint is NOT violated.
    // (itemId, locationId, 'BATCH-001') ≠ (itemId, locationId, 'DEFAULT')
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
    // This assertion proves the formula is applied — not that the values are specific.
    expect(availableQty).toBe(physicalQty - reservedQty);
  });
});

// ── Stock adjustments ─────────────────────────────────────────────────────────
describe('Inventory adjustment', () => {
  let invId: string;

  beforeAll(async () => {
    // Create a fresh inventory row for adjustment tests.
    // 'ADJ-${tag}' batch ensures uniqueness from the creation tests above.
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
    // 50 + 20 = 70
    expect(res.body.data.physicalQty).toBe(70);
    expect(res.body.data.availableQty).toBe(70);
  });

  it('OUT adjustment decreases physicalQty', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ transactionType: 'OUT', quantity: 10, reason: 'Damaged' });
    expect(res.status).toBe(200);
    // 70 - 10 = 60
    expect(res.body.data.physicalQty).toBe(60);
  });

  it('OUT adjustment that would cause negative stock returns 422', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      // 999 > 60 (current physicalQty) → would go negative → 422
      .send({ transactionType: 'OUT', quantity: 999, reason: 'Impossible' });
    expect(res.status).toBe(422);
    // .toMatch(/negative/i) — regex match, case-insensitive ('i' flag).
    // Verifies the error message contains the word 'negative'.
    expect(res.body.message).toMatch(/negative/i);
  });

  it('physicalQty is unchanged after failed OUT adjustment', async () => {
    // The transaction was rolled back — physicalQty should still be 60.
    const inv = await prisma.inventory.findUnique({ where: { id: invId } });
    expect(inv!.physicalQty).toBe(60);
    // `inv!` — non-null assertion. We know the record exists (we just created it).
  });

  it('duplicate referenceKey returns 409 (idempotency key uniqueness)', async () => {
    const key = `DEDUP-${tag}`;

    // First call with this key → 200 (success)
    const res1 = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ transactionType: 'IN', quantity: 5, referenceKey: key });
    expect(res1.status).toBe(200);

    // Second call with the SAME key → 409 (P2002 unique constraint on referenceKey)
    // The InventoryTransaction table has @unique on referenceKey.
    // The second transaction create fails → whole transaction rolls back → 409.
    const res2 = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ transactionType: 'IN', quantity: 5, referenceKey: key });
    expect(res2.status).toBe(409);
  });

  it('physicalQty reflects only one of the duplicate adjustments', async () => {
    // 60 + 5 = 65 (only the first adjustment went through)
    const inv = await prisma.inventory.findUnique({ where: { id: invId } });
    expect(inv!.physicalQty).toBe(65);
  });

  it('quantity must be a positive integer — 0 returns 422', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      // isInt({ min: 1 }) rejects 0 → 422
      .send({ transactionType: 'IN', quantity: 0 });
    expect(res.status).toBe(422);
  });

  it('invalid transactionType returns 422', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${invId}/adjust`)
      .set('Authorization', `Bearer ${opsToken}`)
      // isIn(['IN', 'OUT']) rejects 'BROKEN' → 422
      .send({ transactionType: 'BROKEN', quantity: 1 });
    expect(res.status).toBe(422);
  });
});

// ── Validation edge cases ─────────────────────────────────────────────────────
describe('Inventory API validation', () => {

  it('POST /api/inventory without itemId returns 422', async () => {
    const res = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ locationId, physicalQty: 10 });  // Missing itemId
    expect(res.status).toBe(422);
  });

  it('POST /api/inventory with negative physicalQty returns 422', async () => {
    const res = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${opsToken}`)
      // isInt({ min: 0 }) rejects -1 → 422
      .send({ itemId, locationId, physicalQty: -1 });
    expect(res.status).toBe(422);
  });

  it('GET /api/inventory/:id for non-existent id returns 404', async () => {
    const res = await request(app)
      .get('/api/inventory/nonexistent-id')
      .set('Authorization', `Bearer ${opsToken}`);
    // findUnique returns null → AppError(404) → errorHandler → 404 response
    expect(res.status).toBe(404);
  });
});
