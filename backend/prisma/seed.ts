// ============================================================
// FILE: backend/prisma/seed.ts
// CONSTRUCTION ORDER: #11
// HOW: Created manually with `touch prisma/seed.ts` then filled in.
//      Run with: npm run db:seed
//      Which executes: ts-node --project tsconfig.seed.json prisma/seed.ts
// WHY NOW: Created after the migration runs successfully (database tables exist).
//          Without the tables, the Prisma create/upsert calls would fail.
//          The seed creates reference data that:
//            1. Makes the app usable immediately after setup
//            2. Provides known login credentials for development/demo
//            3. Creates realistic inventory data for UI testing
// ============================================================

// Import PrismaClient directly (not the singleton from src/lib/prisma.ts).
// The seed script is a standalone script — it creates its own client and
// disconnects cleanly when done. Using the singleton is unnecessary here.
// Role and TransactionType are Prisma-generated enum objects from schema.prisma.
import { PrismaClient, Role, TransactionType } from '@prisma/client';
// bcryptjs is used to hash passwords before storing them.
// Storing plaintext passwords is a critical security vulnerability.
import bcrypt from 'bcryptjs';

// Create a dedicated PrismaClient instance for the seed script.
// This is intentionally separate from the app's singleton in src/lib/prisma.ts.
const prisma = new PrismaClient();

// main() is declared async so we can use await for all database operations.
// All seed operations are sequential (not parallel) to ensure predictable order.
async function main() {
  console.log('Seeding database...');

  // ── Step 1: Hash the shared demo password ─────────────────────────────────
  // All demo users share the same password for simplicity.
  // 10 is the bcrypt cost factor (salt rounds). Higher = slower to hash = harder to brute-force.
  // 10 is the standard recommendation for most applications.
  const passwordHash = await bcrypt.hash('Password123!', 10);

  // ── Step 2: Create/update users ───────────────────────────────────────────
  // upsert means: "if this record exists (matched by 'where'), apply 'update';
  //                if it doesn't exist, apply 'create'."
  // update: {} means "do nothing if it already exists."
  // This makes the seed script IDEMPOTENT — safe to run multiple times
  // without creating duplicate data or failing on unique constraint violations.

  // Admin user — has full access to everything in the system
  const admin = await prisma.user.upsert({
    where: { email: 'admin@opserp.dev' },  // lookup by unique email
    update: {},                              // if exists, change nothing
    create: {                               // if not exists, create with these values
      name: 'Admin User',
      email: 'admin@opserp.dev',
      password: passwordHash,
      role: Role.ADMIN,  // Role.ADMIN is the TypeScript enum value from @prisma/client
    },
  });

  // Operations user — manages inventory, work orders, and transfers
  const ops = await prisma.user.upsert({
    where: { email: 'ops@opserp.dev' },
    update: {},
    create: {
      name: 'Operations User',
      email: 'ops@opserp.dev',
      password: passwordHash,
      role: Role.OPERATIONS,
    },
  });

  // Sales user — creates and manages customer orders
  const sales = await prisma.user.upsert({
    where: { email: 'sales@opserp.dev' },
    update: {},
    create: {
      name: 'Sales User',
      email: 'sales@opserp.dev',
      password: passwordHash,
      role: Role.SALES,
    },
  });

  console.log('Users created');

  // ── Step 3: Create locations ───────────────────────────────────────────────
  // Locations represent physical places where stock is stored or used.
  // Using upsert with unique field 'name' for idempotency.

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

  // Shop Floor has lower stock levels — useful for demonstrating shortageQty
  // on work orders where required quantity exceeds available quantity.
  const shopFloor = await prisma.location.upsert({
    where: { name: 'Shop Floor' },
    update: {},
    create: { name: 'Shop Floor', address: 'Main Production Building' },
  });

  console.log('Locations created');

  // ── Step 4: Create items (product catalog) ─────────────────────────────────
  // Items are the types of physical goods. Quantities live in Inventory, not here.
  // Using upsert with unique field 'sku' for idempotency.

  const steelRod = await prisma.item.upsert({
    where: { sku: 'STEEL-ROD-10MM' },
    update: {},
    // unitPrice: 250.00 — Prisma accepts number literals for Decimal fields
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

  // ── Step 5: Create inventory records ──────────────────────────────────────
  // A local helper function defined INSIDE main() so it has access to `admin`.
  // This is a closure — it captures admin.id from the outer scope.
  // TypeScript infers the parameter types from usage.
  async function upsertInventory(
    itemId: string,       // which item
    locationId: string,   // which location
    physicalQty: number,  // how many units to start with
    batchNumber = 'DEFAULT'  // default parameter — 'DEFAULT' if not provided
  ) {
    // Check if this inventory row already exists (for idempotency)
    const existing = await prisma.inventory.findFirst({
      where: { itemId, locationId, batchNumber },
      // shorthand property: { itemId: itemId } is the same as { itemId }
    });

    // If it already exists, return it unchanged — don't create a duplicate
    if (existing) return existing;

    // Create the inventory row with the starting physical quantity
    const inv = await prisma.inventory.create({
      data: { itemId, locationId, batchNumber, physicalQty },
    });

    // If there is starting stock, create an initial InventoryTransaction record.
    // This starts the audit trail — every unit of stock has a paper trail from day one.
    if (physicalQty > 0) {
      await prisma.inventoryTransaction.create({
        data: {
          inventoryId: inv.id,
          transactionType: TransactionType.IN,  // Stock coming in
          quantity: physicalQty,
          reason: 'Initial seed stock',
          // No referenceKey — initial seeds don't need idempotency keys
          createdById: admin.id,  // Recorded against the admin user
        },
      });
    }

    return inv;
  }

  // Warehouse A — main storage with full inventory
  await upsertInventory(steelRod.id, warehouseA.id, 100);
  await upsertInventory(boltM8.id, warehouseA.id, 500);
  await upsertInventory(paintPrimer.id, warehouseA.id, 30);
  await upsertInventory(aluminiumSheet.id, warehouseA.id, 50);
  await upsertInventory(safetyHelmet.id, warehouseA.id, 20);

  // Warehouse B — secondary storage
  await upsertInventory(steelRod.id, warehouseB.id, 60);
  await upsertInventory(boltM8.id, warehouseB.id, 200);
  await upsertInventory(paintPrimer.id, warehouseB.id, 10);

  // Shop Floor — low stock intentionally to demonstrate shortageQty on work orders
  await upsertInventory(steelRod.id, shopFloor.id, 5);   // Only 5 → work order needs 20 → shortage!
  await upsertInventory(boltM8.id, shopFloor.id, 50);

  console.log('Inventory records created');

  // ── Step 6: Create a sample work order ────────────────────────────────────
  // Check if WO-00001 already exists before creating (idempotency without upsert).
  // WorkOrder has no single unique field we can use for upsert's 'where' clause
  // other than workOrderNumber, so we use findFirst + conditional create.
  const existingWO = await prisma.workOrder.findFirst({
    where: { workOrderNumber: 'WO-00001' },
  });

  if (!existingWO) {
    await prisma.workOrder.create({
      data: {
        workOrderNumber: 'WO-00001',
        locationId: shopFloor.id,
        itemId: steelRod.id,
        requiredQty: 20,          // 20 required but only 5 available → shortage of 15
        assignedToId: ops.id,     // Assigned to the operations user
        createdById: admin.id,
        // Snapshot fields — copied from item at creation time
        itemName: steelRod.name,  // 'Steel Rod 10mm'
        itemSku: steelRod.sku,    // 'STEEL-ROD-10MM'
        notes: 'Production run for Q3 order batch',
      },
    });
    console.log('Sample work order created');
  }

  // Print login credentials so the developer knows how to log in after seeding
  console.log('\nSeed complete. Login credentials:');
  console.log('  admin@opserp.dev    / Password123!  (ADMIN)');
  console.log('  ops@opserp.dev      / Password123!  (OPERATIONS)');
  console.log('  sales@opserp.dev    / Password123!  (SALES)');

  // TypeScript would warn that `sales` is assigned but never used after this point.
  // void suppresses that warning by explicitly discarding the value.
  // This is intentional — sales was used in the upsert above but not stored in a variable
  // that's used elsewhere. The `void` documents this intentionality.
  void sales;
}

// ── Execute main() ────────────────────────────────────────────────────────────
main()
  // .catch() handles any error thrown by main() — prints it and exits with error code 1.
  // process.exit(1) signals to the shell that the script failed (non-zero exit = failure).
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  // .finally() ALWAYS runs, whether main() succeeded or failed.
  // We MUST disconnect from the database — if we don't, the script hangs
  // waiting for the connection pool to close and never terminates.
  .finally(async () => {
    await prisma.$disconnect();
  });
