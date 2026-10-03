/**
 * ============================================================
 * FILE: backend/src/__tests__/transfers.test.ts
 * CONSTRUCTION ORDER: #32
 * HOW: touch src/__tests__/transfers.test.ts
 * MANDATORY TESTS COVERED:
 *   Test 2 — Cannot dispatch more than available source inventory
 *   Test 3 — Destination stock increases ONLY after receipt (not after dispatch)
 *   Test 4 — Same transfer cannot be received twice
 * ADDITIONAL COVERAGE:
 *   - Full REQUESTED → DISPATCHED → RECEIVED lifecycle
 *   - Source stock reduces at dispatch
 *   - Destination stock unchanged until receipt
 *   - Cancel lifecycle (REQUESTED only, ADMIN only)
 * ============================================================
 */
import './setup';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../app';
import { prisma } from '../lib/prisma';
import { Role } from '@prisma/client';

const PASSWORD = 'TransferTest123!';
let opsToken: string;
let adminToken: string;
let opsUserId: string;
let adminUserId: string;

// Shared test fixtures
let locationAId: string;  // source location
let locationBId: string;  // destination location
let itemId: string;
let sourceInvId: string;
// destInvId starts null — destination inventory doesn't exist before first receipt.
let destInvId: string | null = null;

const tag = Date.now().toString();

beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);

  // Create both test users in parallel.
  const [opsUser, adminUser] = await Promise.all([
    prisma.user.create({
      data: { name: 'Transfer Ops', email: `tr-ops-${tag}@test.com`, password: hash, role: Role.OPERATIONS },
    }),
    prisma.user.create({
      data: { name: 'Transfer Admin', email: `tr-admin-${tag}@test.com`, password: hash, role: Role.ADMIN },
    }),
  ]);
  opsUserId = opsUser.id;
  adminUserId = adminUser.id;

  // Get tokens in parallel.
  [opsToken, adminToken] = await Promise.all([
    request(app).post('/api/auth/login').send({ email: opsUser.email, password: PASSWORD }).then(r => r.body.token as string),
    request(app).post('/api/auth/login').send({ email: adminUser.email, password: PASSWORD }).then(r => r.body.token as string),
  ]);

  // Create two distinct locations for source and destination.
  const [locA, locB] = await Promise.all([
    prisma.location.create({ data: { name: `TR-Source-${tag}` } }),
    prisma.location.create({ data: { name: `TR-Dest-${tag}` } }),
  ]);
  locationAId = locA.id;
  locationBId = locB.id;

  const item = await prisma.item.create({
    data: { name: `Transfer Item ${tag}`, sku: `TR-ITEM-${tag}`, unitPrice: 100 },
  });
  itemId = item.id;

  // Source has 50 units. Destination has NO inventory record yet.
  // This is intentional — receipt must CREATE the destination record.
  const srcInv = await prisma.inventory.create({
    data: { itemId, locationId: locationAId, batchNumber: 'DEFAULT', physicalQty: 50 },
  });
  sourceInvId = srcInv.id;
});

afterAll(async () => {
  // Clean up in dependency order: transactions → inventory → items → locations → users
  await prisma.inventoryTransaction.deleteMany({
    where: { inventory: { locationId: { in: [locationAId, locationBId] } } },
  });
  await prisma.stockTransfer.deleteMany({ where: { itemId } });
  if (destInvId) await prisma.inventory.delete({ where: { id: destInvId } }).catch(() => null);
  await prisma.inventory.delete({ where: { id: sourceInvId } }).catch(() => null);
  await prisma.item.delete({ where: { id: itemId } }).catch(() => null);
  await prisma.location.deleteMany({ where: { id: { in: [locationAId, locationBId] } } }).catch(() => null);
  await prisma.user.deleteMany({ where: { id: { in: [opsUserId, adminUserId] } } });
  await prisma.$disconnect();
});

// ── MANDATORY TEST 2 ──────────────────────────────────────────────────────────
describe('Mandatory Test 2 — cannot dispatch more than available source inventory', () => {
  let transferId: string;

  beforeAll(async () => {
    // Create a transfer requesting 100 units — but source only has 50 available.
    // POST /api/transfers does NOT check availability — it just creates the request.
    // The check happens at dispatch time.
    const res = await request(app)
      .post('/api/transfers')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({
        sourceLocationId: locationAId,
        destLocationId: locationBId,
        itemId,
        quantity: 100,  // Exceeds available (50) — will fail at dispatch
        notes: 'Oversized transfer test',
      });
    expect(res.status).toBe(201);  // Creation succeeds regardless
    transferId = res.body.data.id as string;
  });

  it('dispatch returns 422 when quantity exceeds available stock', async () => {
    const res = await request(app)
      .patch(`/api/transfers/${transferId}/dispatch`)
      .set('Authorization', `Bearer ${opsToken}`);
    // MANDATORY TEST 2: 422 because 100 > 50 (available)
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/insufficient/i);
  });

  it('source stock remains unchanged after a failed dispatch', async () => {
    // The transaction was rolled back — source physicalQty should still be 50.
    const inv = await prisma.inventory.findUnique({ where: { id: sourceInvId } });
    expect(inv!.physicalQty).toBe(50);
  });

  it('transfer stays in REQUESTED status after a failed dispatch', async () => {
    // Dispatch failed → status not updated → still REQUESTED.
    const tr = await prisma.stockTransfer.findUnique({ where: { id: transferId } });
    expect(tr!.status).toBe('REQUESTED');
  });
});

// ── MANDATORY TESTS 3 & 4 + Happy Path ────────────────────────────────────────
describe('Mandatory Test 3 — destination stock increases ONLY after receipt', () => {
  let transferId: string;

  beforeAll(async () => {
    // Reset source to 50 for a clean starting point.
    await prisma.inventory.update({ where: { id: sourceInvId }, data: { physicalQty: 50 } });

    const res = await request(app)
      .post('/api/transfers')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({
        sourceLocationId: locationAId,
        destLocationId: locationBId,
        itemId,
        quantity: 20,
      });
    expect(res.status).toBe(201);
    transferId = res.body.data.id as string;
  });

  it('before dispatch: destination has no inventory record at Location B', async () => {
    // The destination inventory row doesn't exist yet (or has 0 if previously created).
    const destInv = await prisma.inventory.findFirst({
      where: { itemId, locationId: locationBId },
    });
    if (destInv) {
      expect(destInv.physicalQty).toBe(0);
    } else {
      expect(destInv).toBeNull();
    }
  });

  it('dispatch succeeds (200) and reduces source stock', async () => {
    const res = await request(app)
      .patch(`/api/transfers/${transferId}/dispatch`)
      .set('Authorization', `Bearer ${opsToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DISPATCHED');

    // Source: 50 - 20 = 30
    const srcInv = await prisma.inventory.findUnique({ where: { id: sourceInvId } });
    expect(srcInv!.physicalQty).toBe(30);
  });

  // MANDATORY TEST 3: After dispatch, destination stock has NOT changed yet.
  it('after dispatch: destination stock has NOT increased yet', async () => {
    const destInv = await prisma.inventory.findFirst({
      where: { itemId, locationId: locationBId },
    });
    if (destInv) {
      expect(destInv.physicalQty).toBe(0);  // Still 0 — stock is "in transit"
    } else {
      expect(destInv).toBeNull();  // Or doesn't exist yet
    }
  });

  it('receipt succeeds (200) and increases destination stock', async () => {
    const res = await request(app)
      .patch(`/api/transfers/${transferId}/receive`)
      .set('Authorization', `Bearer ${opsToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RECEIVED');

    // Destination: 0 + 20 = 20
    const destInv = await prisma.inventory.findFirst({
      where: { itemId, locationId: locationBId },
    });
    expect(destInv).not.toBeNull();
    expect(destInv!.physicalQty).toBe(20);
    destInvId = destInv!.id;  // Save for cleanup
  });

  it('source stock unchanged after receipt (still 30)', async () => {
    // Receipt only affects the destination. Source was already reduced at dispatch.
    const srcInv = await prisma.inventory.findUnique({ where: { id: sourceInvId } });
    expect(srcInv!.physicalQty).toBe(30);
  });

  // MANDATORY TEST 4: Cannot receive the same transfer twice.
  it('Mandatory Test 4 — receiving the same transfer again returns 400', async () => {
    // Transfer is now RECEIVED. Trying to receive it again should fail.
    const res = await request(app)
      .patch(`/api/transfers/${transferId}/receive`)
      .set('Authorization', `Bearer ${opsToken}`);
    // 400 Bad Request — status is RECEIVED, not DISPATCHED.
    // The SELECT FOR UPDATE on the transfer row ensures only one receive can succeed.
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/dispatched/i);
  });

  it('destination stock unchanged after double-receipt attempt (still 20)', async () => {
    // The second receive was rejected — destination should still be 20.
    const destInv = await prisma.inventory.findFirst({
      where: { itemId, locationId: locationBId },
    });
    expect(destInv!.physicalQty).toBe(20);
  });
});

// ── Transfer cancellation lifecycle ───────────────────────────────────────────
describe('Transfer cancellation lifecycle', () => {

  it('can cancel a REQUESTED transfer', async () => {
    const createRes = await request(app)
      .post('/api/transfers')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ sourceLocationId: locationAId, destLocationId: locationBId, itemId, quantity: 5 });
    const id = createRes.body.data.id as string;

    const res = await request(app)
      .patch(`/api/transfers/${id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`);  // Only ADMIN can cancel
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
  });

  it('cannot cancel a DISPATCHED transfer → 400', async () => {
    // Reset source so dispatch succeeds.
    await prisma.inventory.update({ where: { id: sourceInvId }, data: { physicalQty: 50 } });

    const createRes = await request(app)
      .post('/api/transfers')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ sourceLocationId: locationAId, destLocationId: locationBId, itemId, quantity: 5 });
    const id = createRes.body.data.id as string;

    // Dispatch the transfer first.
    await request(app)
      .patch(`/api/transfers/${id}/dispatch`)
      .set('Authorization', `Bearer ${opsToken}`);

    // Now try to cancel it — should fail because it's DISPATCHED.
    const res = await request(app)
      .patch(`/api/transfers/${id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('OPERATIONS cannot cancel a transfer (ADMIN only for cancel) → 403', async () => {
    const createRes = await request(app)
      .post('/api/transfers')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ sourceLocationId: locationAId, destLocationId: locationBId, itemId, quantity: 3 });
    const id = createRes.body.data.id as string;

    // opsToken = OPERATIONS user. Cancel requires ADMIN_ONLY.
    const res = await request(app)
      .patch(`/api/transfers/${id}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`);
    expect(res.status).toBe(403);
  });
});
