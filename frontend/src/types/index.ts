// ─── Auth ─────────────────────────────────────────────────────────────────────

export type Role = 'ADMIN' | 'OPERATIONS' | 'SALES';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

// ─── Location ─────────────────────────────────────────────────────────────────

export interface Location {
  id: string;
  name: string;
  address?: string;
  createdAt: string;
}

// ─── Item ─────────────────────────────────────────────────────────────────────

export interface Item {
  id: string;
  name: string;
  sku: string;
  category?: string;
  unitPrice: string; // Decimal serialized as string from Prisma
  createdAt: string;
}

// ─── Inventory ────────────────────────────────────────────────────────────────

export interface Inventory {
  id: string;
  itemId: string;
  locationId: string;
  batchNumber: string;
  physicalQty: number;
  reservedQty: number;
  availableQty: number; // computed by backend
  item?: Pick<Item, 'id' | 'name' | 'sku' | 'category' | 'unitPrice'>;
  location?: Pick<Location, 'id' | 'name'>;
  updatedAt: string;
}

// ─── Work Order ───────────────────────────────────────────────────────────────

export type WorkOrderStatus = 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED';

export interface WorkOrder {
  id: string;
  workOrderNumber: string;
  locationId: string;
  itemId: string;
  requiredQty: number;
  assignedToId: string;
  status: WorkOrderStatus;
  notes?: string;
  itemName: string;
  itemSku: string;
  availableQty: number; // computed by backend
  shortageQty: number;  // computed by backend
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  location?: Pick<Location, 'id' | 'name'>;
  item?: Pick<Item, 'id' | 'name' | 'sku'>;
  assignedTo?: Pick<User, 'id' | 'name' | 'email'>;
  createdBy?: Pick<User, 'id' | 'name'>;
}

// ─── Stock Transfer ───────────────────────────────────────────────────────────

export type TransferStatus = 'REQUESTED' | 'DISPATCHED' | 'RECEIVED' | 'CANCELLED';

export interface StockTransfer {
  id: string;
  transferNumber: string;
  sourceLocationId: string;
  destLocationId: string;
  itemId: string;
  quantity: number;
  status: TransferStatus;
  notes?: string;
  itemName: string;
  itemSku: string;
  dispatchedAt?: string;
  receivedAt?: string;
  createdAt: string;
  sourceLocation?: Pick<Location, 'id' | 'name'>;
  destLocation?: Pick<Location, 'id' | 'name'>;
  item?: Pick<Item, 'id' | 'name' | 'sku'>;
  requestedBy?: Pick<User, 'id' | 'name'>;
  dispatchedBy?: Pick<User, 'id' | 'name'>;
  receivedBy?: Pick<User, 'id' | 'name'>;
}

// ─── Customer Order ───────────────────────────────────────────────────────────

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED';

export interface OrderItem {
  id: string;
  orderId: string;
  inventoryId: string;
  quantity: number;
  itemName: string;
  itemSku: string;
  unitPrice: string;
}

export interface CustomerOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerPhone?: string;
  locationId: string;
  status: OrderStatus;
  totalQty: number;
  notes?: string;
  confirmedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  location?: Pick<Location, 'id' | 'name'>;
  createdBy?: Pick<User, 'id' | 'name'>;
  items?: OrderItem[];
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export interface DashboardStats {
  items: { total: number };
  locations: { total: number };
  inventory: {
    records: number;
    totalPhysical: number;
    totalReserved: number;
    totalAvailable: number;
  };
  workOrders: { open: number };
  transfers: { pending: number; dispatched: number };
  orders: { pending: number; confirmed: number };
}
