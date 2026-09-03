import React, { useState, useEffect, useCallback } from 'react';
import { ordersApi } from '../api/orders';
import { inventoryApi } from '../api/inventory';
import { locationsApi } from '../api/locations';
import { useAuth } from '../contexts/AuthContext';
import { CustomerOrder, Inventory, Location, OrderStatus } from '../types';

function extractMsg(err: unknown): string {
  const e = err as { response?: { data?: { message?: string; details?: unknown } }; message?: string };
  return e?.response?.data?.message ?? e?.message ?? 'An error occurred.';
}

function StatusBadge({ status }: { status: OrderStatus }) {
  const map: Record<OrderStatus, string> = {
    PENDING: 'badge-pending',
    CONFIRMED: 'badge-confirmed',
    CANCELLED: 'badge-cancelled',
  };
  return <span className={map[status]}>{status}</span>;
}

// ─── Order Item Row (inside create form) ──────────────────────────────────────

interface OrderLineItem {
  inventoryId: string;
  quantity: number;
}

// ─── Create Order Modal ───────────────────────────────────────────────────────

interface CreateModalProps {
  locations: Location[];
  onClose: () => void;
  onCreated: () => void;
}

function CreateModal({ locations, onClose, onCreated }: CreateModalProps) {
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [locationId, setLocationId] = useState('');
  const [notes, setNotes] = useState('');
  const [lineItems, setLineItems] = useState<OrderLineItem[]>([{ inventoryId: '', quantity: 1 }]);
  const [inventoryOptions, setInventoryOptions] = useState<Inventory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load inventory for selected location
  useEffect(() => {
    if (!locationId) { setInventoryOptions([]); return; }
    inventoryApi.list({ locationId, limit: 100 })
      .then(r => setInventoryOptions(r.data.data))
      .catch(() => { });
  }, [locationId]);

  const updateLine = (idx: number, field: keyof OrderLineItem, value: string | number) => {
    setLineItems(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  };

  const addLine = () => setLineItems(prev => [...prev, { inventoryId: '', quantity: 1 }]);
  const removeLine = (idx: number) => setLineItems(prev => prev.filter((_, i) => i !== idx));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const validLines = lineItems.filter(l => l.inventoryId && l.quantity > 0);
    if (validLines.length === 0) { setError('Add at least one item.'); return; }
    setLoading(true);
    try {
      await ordersApi.create({
        customerName,
        customerPhone: customerPhone || undefined,
        locationId,
        notes: notes || undefined,
        items: validLines,
      });
      onCreated();
      onClose();
    } catch (err) { setError(extractMsg(err)); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">New Customer Order</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Customer Name</label>
              <input className="input" value={customerName} onChange={e => setCustomerName(e.target.value)} required />
            </div>
            <div>
              <label className="label">Phone <span className="text-gray-400 font-normal">(optional)</span></label>
              <input className="input" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Location (stock source)</label>
            <select className="input" value={locationId} onChange={e => setLocationId(e.target.value)} required>
              <option value="">Select location…</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>

          {/* Line items */}
          <div>
            <label className="label">Items</label>
            <div className="space-y-2">
              {lineItems.map((line, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <select
                    className="input flex-1"
                    value={line.inventoryId}
                    onChange={e => updateLine(idx, 'inventoryId', e.target.value)}
                    required
                  >
                    <option value="">Select inventory…</option>
                    {inventoryOptions.map(inv => (
                      <option key={inv.id} value={inv.id}>
                        {inv.item?.name ?? inv.itemId} — Available: {inv.availableQty} {inv.batchNumber !== 'DEFAULT' ? `(${inv.batchNumber})` : ''}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    className="input w-20"
                    value={line.quantity}
                    onChange={e => updateLine(idx, 'quantity', Number(e.target.value))}
                    required
                  />
                  {lineItems.length > 1 && (
                    <button type="button" className="text-red-400 hover:text-red-600 text-lg leading-none" onClick={() => removeLine(idx)}>×</button>
                  )}
                </div>
              ))}
            </div>
            <button type="button" className="mt-2 text-xs text-brand-600 hover:text-brand-800 font-medium" onClick={addLine}>
              + Add another item
            </button>
          </div>

          <div>
            <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
            <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="submit" className="btn-primary flex-1" disabled={loading}>{loading ? 'Creating…' : 'Create Order'}</button>
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const { user } = useAuth();
  const canCreate = user?.role === 'ADMIN' || user?.role === 'SALES';
  const canConfirmCancel = user?.role === 'ADMIN' || user?.role === 'SALES';

  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = statusFilter ? { status: statusFilter, limit: 100 } : { limit: 100 };
      const res = await ordersApi.list(params);
      setOrders(res.data.data);
    } catch (err) { setError(extractMsg(err)); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => {
    load();
    locationsApi.list().then(r => setLocations(r.data.data)).catch(() => { });
  }, [load]);

  const handleConfirm = async (id: string) => {
    setActionLoading(`${id}-confirm`);
    try {
      await ordersApi.confirm(id);
      await load();
    } catch (err) { alert(extractMsg(err)); }
    finally { setActionLoading(null); }
  };

  const handleCancel = async (id: string) => {
    if (!confirm('Cancel this order? If confirmed, reserved stock will be released.')) return;
    setActionLoading(`${id}-cancel`);
    try {
      await ordersApi.cancel(id);
      await load();
    } catch (err) { alert(extractMsg(err)); }
    finally { setActionLoading(null); }
  };

  return (
    <div>
      {showCreate && (
        <CreateModal locations={locations} onClose={() => setShowCreate(false)} onCreated={load} />
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Customer Orders</h1>
          <p className="text-sm text-gray-500 mt-0.5">Create orders and reserve stock. Reservation is atomic — concurrent orders cannot exceed available qty.</p>
        </div>
        {canCreate && (
          <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New Order</button>
        )}
      </div>

      <div className="flex gap-3 mb-4">
        <select className="input w-48" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="PENDING">Pending</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <button className="btn-secondary" onClick={load}>Refresh</button>
      </div>

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
      ) : orders.length === 0 ? (
        <div className="card text-center py-12 text-gray-400">No orders found.</div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr>
                  {['Order #', 'Customer', 'Location', 'Items', 'Total Qty', 'Status', 'Created By', ...(canConfirmCancel ? ['Actions'] : [])].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {orders.map(ord => (
                  <tr key={ord.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-xs font-mono text-gray-600">{ord.orderNumber}</td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-900">{ord.customerName}</div>
                      {ord.customerPhone && <div className="text-xs text-gray-400">{ord.customerPhone}</div>}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{ord.location?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {ord.items && ord.items.length > 0 ? (
                        <ul className="space-y-0.5">
                          {ord.items.map(item => (
                            <li key={item.id} className="text-xs text-gray-600">{item.itemName} × {item.quantity}</li>
                          ))}
                        </ul>
                      ) : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-700">{ord.totalQty}</td>
                    <td className="px-4 py-3"><StatusBadge status={ord.status} /></td>
                    <td className="px-4 py-3 text-sm text-gray-600">{ord.createdBy?.name ?? '—'}</td>
                    {canConfirmCancel && (
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          {ord.status === 'PENDING' && (
                            <button
                              className="text-xs text-green-600 hover:text-green-800 font-medium disabled:opacity-40"
                              disabled={actionLoading === `${ord.id}-confirm`}
                              onClick={() => handleConfirm(ord.id)}
                            >
                              {actionLoading === `${ord.id}-confirm` ? '…' : 'Confirm'}
                            </button>
                          )}
                          {(ord.status === 'PENDING' || ord.status === 'CONFIRMED') && (
                            <button
                              className="text-xs text-red-500 hover:text-red-700 font-medium disabled:opacity-40"
                              disabled={actionLoading === `${ord.id}-cancel`}
                              onClick={() => handleCancel(ord.id)}
                            >
                              {actionLoading === `${ord.id}-cancel` ? '…' : 'Cancel'}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
