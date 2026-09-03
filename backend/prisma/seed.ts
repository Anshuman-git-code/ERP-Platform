import { PrismaClient, Role, TransactionType } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // ── Users ──────────────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash('Password123!', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@opserp.dev' },
    update: {},
    create: { name: 'Admin User', email: 'admin@opserp.dev', password: passwordHash, role: Role.ADMIN },
  });

  const ops = await prisma.user.upsert({
    where: { email: 'ops@opserp.dev' },
    update: {},
    create: { name: 'Operations User', email: 'ops@opserp.dev', password: passwordHash, role: Role.OPERATIONS },
  });

  const sales = await prisma.user.upsert({
    where: { email: 'sales@opserp.dev' },
    update: {},
    create: { name: 'Sales User', email: 'sales@opserp.dev', password: passwordHash, role: Role.SALES },
  });

  console.log('Users created');

  // ── Locations ──────────────────────────────────────────────────────────────
  const warehouseA = await prisma.location.upsert({
    where: { name: 'Warehouse A' },
    update: {},
    create: { name: 'Warehouse A', address: '1 Industrial Estate, Mumbai' },
  });

  const warehouseB = await prisma.location.upsert({
    where: { name: 'Warehouse B' },
    update: {},
    create: { name: 'Warehouse B', address: '2 Logistics Park, Pune' },
  });

  const shopFloor = await prisma.location.upsert({
    where: { name: 'Shop Floor' },
    update: {},
    create: { name: 'Shop Floor', address: 'Main Production Building' },
  });

  console.log('Locations created');

  // ── Items ──────────────────────────────────────────────────────────────────
  const steelRod = await prisma.item.upsert({
    where: { sku: 'STEEL-ROD-10MM' },
    update: {},
    create: { name: 'Steel Rod 10mm', sku: 'STEEL-ROD-10MM', category: 'Raw Material', unitPrice: 250.00 },
  });

  const boltM8 = await prisma.item.upsert({
    where: { sku: 'BOLT-M8-SS' },
    update: {},
    create: { name: 'Bolt M8 Stainless', sku: 'BOLT-M8-SS', category: 'Fasteners', unitPrice: 5.50 },
  });

  const paintPrimer = await prisma.item.upsert({
    where: { sku: 'PAINT-PRIMER-5L' },
    update: {},
    create: { name: 'Primer Paint 5L', sku: 'PAINT-PRIMER-5L', category: 'Consumables', unitPrice: 850.00 },
  });

  const aluminiumSheet = await prisma.item.upsert({
    where: { sku: 'AL-SHEET-3MM' },
    update: {},
    create: { name: 'Aluminium Sheet 3mm', sku: 'AL-SHEET-3MM', category: 'Raw Material', unitPrice: 1200.00 },
  });

  const safetyHelmet = await prisma.item.upsert({
    where: { sku: 'SAFETY-HELMET-WHT' },
    update: {},
    create: { name: 'Safety Helmet White', sku: 'SAFETY-HELMET-WHT', category: 'Safety Equipment', unitPrice: 350.00 },
  });

  console.log('Items created');

  // ── Inventory ──────────────────────────────────────────────────────────────
  // Helper to upsert inventory and log an initial transaction
  async function upsertInventory(
    itemId: string,
    locationId: string,
    physicalQty: number,
    batchNumber = 'DEFAULT'
  ) {
    const existing = await prisma.inventory.findFirst({
      where: { itemId, locationId, batchNumber },
    });

    if (existing) return existing;

    const inv = await prisma.inventory.create({
      data: { itemId, locationId, batchNumber, physicalQty },
    });

    if (physicalQty > 0) {
      await prisma.inventoryTransaction.create({
        data: {
          inventoryId: inv.id,
          transactionType: TransactionType.IN,
          quantity: physicalQty,
          reason: 'Initial seed stock',
          createdById: admin.id,
        },
      });
    }

    return inv;
  }

  // Warehouse A inventory
  await upsertInventory(steelRod.id, warehouseA.id, 100);
  await upsertInventory(boltM8.id, warehouseA.id, 500);
  await upsertInventory(paintPrimer.id, warehouseA.id, 30);
  await upsertInventory(aluminiumSheet.id, warehouseA.id, 50);
  await upsertInventory(safetyHelmet.id, warehouseA.id, 20);

  // Warehouse B inventory
  await upsertInventory(steelRod.id, warehouseB.id, 60);
  await upsertInventory(boltM8.id, warehouseB.id, 200);
  await upsertInventory(paintPrimer.id, warehouseB.id, 10);

  // Shop Floor (lower stock — useful for shortage demos)
  await upsertInventory(steelRod.id, shopFloor.id, 5);
  await upsertInventory(boltM8.id, shopFloor.id, 50);

  console.log('Inventory records created');

  // ── Work Order (sample) ────────────────────────────────────────────────────
  const existingWO = await prisma.workOrder.findFirst({
    where: { workOrderNumber: 'WO-00001' },
  });

  if (!existingWO) {
    await prisma.workOrder.create({
      data: {
        workOrderNumber: 'WO-00001',
        locationId: shopFloor.id,
        itemId: steelRod.id,
        requiredQty: 20,
        assignedToId: ops.id,
        createdById: admin.id,
        itemName: steelRod.name,
        itemSku: steelRod.sku,
        notes: 'Production run for Q3 order batch',
      },
    });
    console.log('Sample work order created');
  }

  console.log('\nSeed complete. Login credentials:');
  console.log('  admin@opserp.dev    / Password123!  (ADMIN)');
  console.log('  ops@opserp.dev      / Password123!  (OPERATIONS)');
  console.log('  sales@opserp.dev    / Password123!  (SALES)');

  // suppress unused-var warnings on seed-only vars
  void sales;
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
