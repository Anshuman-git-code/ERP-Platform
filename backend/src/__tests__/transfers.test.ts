/**
 * Transfer business logic tests.
 *
 * Mandatory Tests covered:
 *   Test 2 — Cannot transfer more than available inventory
 *   Test 3 — Destination stock increases ONLY after transfer receipt
 *             (not after dispatch)
 *   Test 4 — Same transfer cannot be received twice
 *
 * Additional lifecycle coverage:
 *   - REQUESTED → DISPATCHED → RECEIVED happy path
 *   - Source stock reduced at dispatch, not before
 *   - Destination stock unchanged until receipt
 *   - Cancel only works from REQUESTED; not from DISPATCHED or RECEIVED
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
let locationAId: string; // source
let locationBId: string; // destination
let itemId: string;
let sourceInvId: string; // inventory at location A
let destInvId: string | null = null; // inventory at location B (may not exist before receipt)

const tag = Date.now().toString();

beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);

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

  [opsToken, adminToken] = await Promise.all([
    request(app).post('/api/auth/login').send({ email: opsUser.email, password: PASSWORD }).then(r => r.body.token as string),
    request(app).post('/api/auth/login').send({ email: adminUser.email, password: PASSWORD }).then(r => r.body.token as string),
  ]);

  // Locations
  const [locA, locB] = await Promise.all([
    prisma.location.create({ data: { name: `TR-Source-${tag}` } }),
    prisma.location.create({ data: { name: `TR-Dest-${tag}` } }),
  ]);
  locationAId = locA.id;
  locationBId = locB.id;

  // Item
  const item = await prisma.item.create({
    data: { name: `Transfer Item ${tag}`, sku: `TR-ITEM-${tag}`, unitPrice: 100 },
  });
  itemId = item.id;

  // Source inventory — 50 units at Location A
  const srcInv = await prisma.inventory.create({
    data: { itemId, locationId: locationAId, batchNumber: 'DEFAULT', physicalQty: 50 },
  });
  sourceInvId = srcInv.id;
  // Location B has NO inventory record yet — receipt must create it
});

afterAll(async () => {
  // Clean up in dependency order
  await prisma.inventoryTransaction.deleteMany({ where: { inventory: { locationId: { in: [locationAId, locationBId] } } } });
  await prisma.stockTransfer.deleteMany({ where: { itemId } });
  if (destInvId) await prisma.inventory.delete({ where: { id: destInvId } }).catch(() => null);
  await prisma.inventory.delete({ where: { id: sourceInvId } }).catch(() => null);
  await prisma.item.delete({ where: { id: itemId } }).catch(() => null);
  await prisma.location.deleteMany({ where: { id: { in: [locationAId, locationBId] } } }).catch(() => null);
  await prisma.user.deleteMany({ where: { id: { in: [opsUserId, adminUserId] } } });
  await prisma.$disconnect();
});

// ── Mandatory Test 2: Cannot transfer more than available ─────────────────────

describe('Mandatory Test 2 — cannot dispatch more than available source inventory', () => {
  let transferId: string;

  beforeAll(async () => {
    // Create a transfer requesting 100 units — but source only has 50 available
    const res = await request(app)
      .post('/api/transfers')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({
        sourceLocationId: locationAId,
        destLocationId: locationBId,
        itemId,
        quantity: 100, // exceeds available (50)
        notes: 'Oversized transfer test',
      });
    expect(res.status).toBe(201);
    transferId = res.body.data.id as string;
  });

  it('dispatch returns 422 when quantity exceeds available stock', async () => {
    const res = await request(app)
      .patch(`/api/transfers/${transferId}/dispatch`)
      .set('Authorization', `Bearer ${opsToken}`);

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/insufficient/i);
  });

  it('source stock remains unchanged after a failed dispatch', async () => {
    const inv = await prisma.inventory.findUnique({ where: { id: sourceInvId } });
    expect(inv!.physicalQty).toBe(50); // unchanged
  });

  it('transfer stays in REQUESTED status after a failed dispatch', async () => {
    const tr = await prisma.stockTransfer.findUnique({ where: { id: transferId } });
    expect(tr!.status).toBe('REQUESTED');
  });
});

// ── Happy path + Mandatory Tests 3 & 4 ───────────────────────────────────────

describe('Mandatory Test 3 — destination stock increases ONLY after receipt', () => {
  let transferId: string;

  beforeAll(async () => {
    // Reset source stock to known value
    await prisma.inventory.update({ where: { id: sourceInvId }, data: { physicalQty: 50 } });

    const res = await request(app)
      .post('/api/transfers')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({
        sourceLocationId: locationAId,
        destLocationId: locationBId,
        itemId,
        quantity: 20,
        notes: 'Happy path transfer',
      });
    expect(res.status).toBe(201);
    transferId = res.body.data.id as string;
  });

  it('before dispatch: destination has no inventory record at Location B', async () => {
    const destInv = await prisma.inventory.findFirst({
      where: { itemId, locationId: locationBId },
    });
    // Either null (no record) or physicalQty = 0
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

    // Source reduced: 50 - 20 = 30
    const srcInv = await prisma.inventory.findUnique({ where: { id: sourceInvId } });
    expect(srcInv!.physicalQty).toBe(30);
  });

  it('after dispatch: destination stock has NOT increased yet', async () => {
    const destInv = await prisma.inventory.findFirst({
      where: { itemId, locationId: locationBId },
    });
    // Still no record or still 0
    if (destInv) {
      expect(destInv.physicalQty).toBe(0);
    } else {
      expect(destInv).toBeNull();
    }
  });

  it('receipt succeeds (200) and increases destination stock', async () => {
    const res = await request(app)
      .patch(`/api/transfers/${transferId}/receive`)
      .set('Authorization', `Bearer ${opsToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RECEIVED');

    // Destination stock now +20
    const destInv = await prisma.inventory.findFirst({
      where: { itemId, locationId: locationBId },
    });
    expect(destInv).not.toBeNull();
    expect(destInv!.physicalQty).toBe(20);
    destInvId = destInv!.id; // save for cleanup
  });

  it('source stock unchanged after receipt (still 30)', async () => {
    const srcInv = await prisma.inventory.findUnique({ where: { id: sourceInvId } });
    expect(srcInv!.physicalQty).toBe(30);
  });

  // ── Mandatory Test 4 ──────────────────────────────────────────────────────

  it('Mandatory Test 4 — receiving the same transfer again returns 400', async () => {
    const res = await request(app)
      .patch(`/api/transfers/${transferId}/receive`)
      .set('Authorization', `Bearer ${opsToken}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // Message must make it clear that status is wrong
    expect(res.body.message).toMatch(/dispatched/i);
  });

  it('destination stock unchanged after double-receipt attempt (still 20)', async () => {
    const destInv = await prisma.inventory.findFirst({
      where: { itemId, locationId: locationBId },
    });
    expect(destInv!.physicalQty).toBe(20);
  });
});

// ── Transfer cancellation ─────────────────────────────────────────────────────

describe('Transfer cancellation lifecycle', () => {
  it('can cancel a REQUESTED transfer', async () => {
    const createRes = await request(app)
      .post('/api/transfers')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ sourceLocationId: locationAId, destLocationId: locationBId, itemId, quantity: 5 });
    const id = createRes.body.data.id as string;

    const res = await request(app)
      .patch(`/api/transfers/${id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
  });

  it('cannot cancel a DISPATCHED transfer → 400', async () => {
    // Reset source to 50 for this sub-test
    await prisma.inventory.update({ where: { id: sourceInvId }, data: { physicalQty: 50 } });

    const createRes = await request(app)
      .post('/api/transfers')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ sourceLocationId: locationAId, destLocationId: locationBId, itemId, quantity: 5 });
    const id = createRes.body.data.id as string;

    await request(app)
      .patch(`/api/transfers/${id}/dispatch`)
      .set('Authorization', `Bearer ${opsToken}`);

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

    const res = await request(app)
      .patch(`/api/transfers/${id}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`); // ops, not admin

    expect(res.status).toBe(403);
  });
});
