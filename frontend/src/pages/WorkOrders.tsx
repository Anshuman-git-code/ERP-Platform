import React, { useState, useEffect, useCallback } from 'react';
import { workOrdersApi } from '../api/workOrders';
import { itemsApi } from '../api/items';
import { locationsApi } from '../api/locations';
import { useAuth } from '../contexts/AuthContext';
import { WorkOrder, Item, Location, WorkOrderStatus, User } from '../types';
import { apiClient } from '../api/client';

function extractMsg(err: unknown): string {
  const e = err as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message ?? e?.message ?? 'An error occurred.';
}

function StatusBadge({ status }: { status: WorkOrderStatus }) {
  const map: Record<WorkOrderStatus, string> = {
    ASSIGNED: 'badge-assigned',
    IN_PROGRESS: 'badge-in-progress',
    COMPLETED: 'badge-completed',
  };
  return <span className={map[status]}>{status.replace('_', ' ')}</span>;
}

const NEXT_STATUS: Record<WorkOrderStatus, WorkOrderStatus | null> = {
  ASSIGNED: 'IN_PROGRESS',
  IN_PROGRESS: 'COMPLETED',
  COMPLETED: null,
};

// ─── Create Work Order Modal ──────────────────────────────────────────────────

interface CreateModalProps {
  items: Item[];
  locations: Location[];
  users: User[];
  onClose: () => void;
  onCreated: () => void;
}

function CreateModal({ items, locations, users, onClose, onCreated }: CreateModalProps) {
  const [locationId, setLocationId] = useState('');
  const [itemId, setItemId] = useState('');
  const [requiredQty, setRequiredQty] = useState(1);
  const [assignedToId, setAssignedToId] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await workOrdersApi.create({ locationId, itemId, requiredQty, assignedToId, notes: notes || undefined });
      onCreated();
      onClose();
    } catch (err) { setError(extractMsg(err)); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">New Work Order</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Location</label>
            <select className="input" value={locationId} onChange={e => setLocationId(e.target.value)} required>
              <option value="">Select location…</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Item Required</label>
            <select className="input" value={itemId} onChange={e => setItemId(e.target.value)} required>
              <option value="">Select item…</option>
              {items.map(i => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}
            </select>
          </div>
          <div>
            <label className="label">Required Quantity</label>
            <input type="number" min={1} className="input" value={requiredQty} onChange={e => setRequiredQty(Number(e.target.value))} required />
          </div>
          <div>
            <label className="label">Assign To</label>
            <select className="input" value={assignedToId} onChange={e => setAssignedToId(e.target.value)} required>
              <option value="">Select user…</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
            </select>
          </div>
          <div>
            <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
            <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="submit" className="btn-primary flex-1" disabled={loading}>{loading ? 'Creating…' : 'Create Work Order'}</button>
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function WorkOrdersPage() {
  const { user } = useAuth();
  const canCreate = user?.role === 'ADMIN';
  const canAdvance = user?.role === 'ADMIN' || user?.role === 'OPERATIONS';

  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [users, setUsers] = useState<User[]>([]);
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
      const res = await workOrdersApi.list(params);
      setOrders(res.data.data);
    } catch (err) { setError(extractMsg(err)); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => {
    load();
    itemsApi.list({ limit: 100 }).then(r => setItems(r.data.data)).catch(() => { });
    locationsApi.list().then(r => setLocations(r.data.data)).catch(() => { });
    // Fetch users for the assign-to dropdown
    apiClient.get<{ success: boolean; data: User[] }>('/auth/users').then(r => setUsers(r.data.data)).catch(() => { });
  }, [load]);

  const advanceStatus = async (wo: WorkOrder) => {
    const next = NEXT_STATUS[wo.status];
    if (!next) return;
    setActionLoading(wo.id);
    try {
      await workOrdersApi.updateStatus(wo.id, next);
      await load();
    } catch (err) { alert(extractMsg(err)); }
    finally { setActionLoading(null); }
  };

  return (
    <div>
      {showCreate && (
        <CreateModal
          items={items}
          locations={locations}
          users={users.length > 0 ? users : []}
          onClose={() => setShowCreate(false)}
          onCreated={load}
        />
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Work Orders</h1>
          <p className="text-sm text-gray-500 mt-0.5">Track material requirements and operational tasks.</p>
        </div>
        {canCreate && (
          <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New Work Order</button>
        )}
      </div>

      <div className="flex gap-3 mb-4">
        <select className="input w-48" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="ASSIGNED">Assigned</option>
          <option value="IN_PROGRESS">In Progress</option>
          <option value="COMPLETED">Completed</option>
        </select>
        <button className="btn-secondary" onClick={load}>Refresh</button>
      </div>

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
      ) : orders.length === 0 ? (
        <div className="card text-center py-12 text-gray-400">No work orders found.</div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr>
                  {['WO #', 'Item', 'Location', 'Required', 'Available', 'Shortage', 'Assigned To', 'Status', ...(canAdvance ? ['Action'] : [])].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {orders.map(wo => {
                  const next = NEXT_STATUS[wo.status];
                  const shortage = wo.shortageQty ?? Math.max(wo.requiredQty - (wo.availableQty ?? 0), 0);
                  return (
                    <tr key={wo.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-xs font-mono text-gray-600">{wo.workOrderNumber}</td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{wo.itemName}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{wo.location?.name ?? '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{wo.requiredQty}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{wo.availableQty ?? '—'}</td>
                      <td className="px-4 py-3">
                        {shortage > 0
                          ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">−{shortage}</span>
                          : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">OK</span>}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">{wo.assignedTo?.name ?? '—'}</td>
                      <td className="px-4 py-3"><StatusBadge status={wo.status} /></td>
                      {canAdvance && (
                        <td className="px-4 py-3">
                          {next && (
                            <button
                              className="text-xs text-brand-600 hover:text-brand-800 font-medium disabled:opacity-40"
                              disabled={actionLoading === wo.id}
                              onClick={() => advanceStatus(wo)}
                            >
                              {actionLoading === wo.id ? '…' : `→ ${next.replace('_', ' ')}`}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
