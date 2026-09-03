import React, { useState, useEffect, useCallback } from 'react';
import { transfersApi } from '../api/transfers';
import { itemsApi } from '../api/items';
import { locationsApi } from '../api/locations';
import { useAuth } from '../contexts/AuthContext';
import { StockTransfer, Item, Location, TransferStatus } from '../types';

function extractMsg(err: unknown): string {
  const e = err as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message ?? e?.message ?? 'An error occurred.';
}

function StatusBadge({ status }: { status: TransferStatus }) {
  const map: Record<TransferStatus, string> = {
    REQUESTED: 'badge-requested',
    DISPATCHED: 'badge-dispatched',
    RECEIVED: 'badge-received',
    CANCELLED: 'badge-cancelled',
  };
  return <span className={map[status]}>{status}</span>;
}

// ─── Create Transfer Modal ────────────────────────────────────────────────────

interface CreateModalProps {
  items: Item[];
  locations: Location[];
  onClose: () => void;
  onCreated: () => void;
}

function CreateModal({ items, locations, onClose, onCreated }: CreateModalProps) {
  const [sourceLocationId, setSourceLocationId] = useState('');
  const [destLocationId, setDestLocationId] = useState('');
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (sourceLocationId === destLocationId) {
      setError('Source and destination must be different.');
      return;
    }
    setLoading(true);
    try {
      await transfersApi.create({ sourceLocationId, destLocationId, itemId, quantity, notes: notes || undefined });
      onCreated();
      onClose();
    } catch (err) { setError(extractMsg(err)); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Request Stock Transfer</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Source Location</label>
            <select className="input" value={sourceLocationId} onChange={e => setSourceLocationId(e.target.value)} required>
              <option value="">Select source…</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Destination Location</label>
            <select className="input" value={destLocationId} onChange={e => setDestLocationId(e.target.value)} required>
              <option value="">Select destination…</option>
              {locations.filter(l => l.id !== sourceLocationId).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Item</label>
            <select className="input" value={itemId} onChange={e => setItemId(e.target.value)} required>
              <option value="">Select item…</option>
              {items.map(i => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}
            </select>
          </div>
          <div>
            <label className="label">Quantity</label>
            <input type="number" min={1} className="input" value={quantity} onChange={e => setQuantity(Number(e.target.value))} required />
          </div>
          <div>
            <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
            <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="submit" className="btn-primary flex-1" disabled={loading}>{loading ? 'Requesting…' : 'Request Transfer'}</button>
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TransfersPage() {
  const { user } = useAuth();
  const canManage = user?.role === 'ADMIN' || user?.role === 'OPERATIONS';
  const canCancel = user?.role === 'ADMIN';

  const [transfers, setTransfers] = useState<StockTransfer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
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
      const res = await transfersApi.list(params);
      setTransfers(res.data.data);
    } catch (err) { setError(extractMsg(err)); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => {
    load();
    itemsApi.list({ limit: 100 }).then(r => setItems(r.data.data)).catch(() => { });
    locationsApi.list().then(r => setLocations(r.data.data)).catch(() => { });
  }, [load]);

  const handleAction = async (id: string, action: 'dispatch' | 'receive' | 'cancel') => {
    setActionLoading(`${id}-${action}`);
    try {
      if (action === 'dispatch') await transfersApi.dispatch(id);
      else if (action === 'receive') await transfersApi.receive(id);
      else await transfersApi.cancel(id);
      await load();
    } catch (err) { alert(extractMsg(err)); }
    finally { setActionLoading(null); }
  };

  return (
    <div>
      {showCreate && (
        <CreateModal items={items} locations={locations} onClose={() => setShowCreate(false)} onCreated={load} />
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Internal Transfers</h1>
          <p className="text-sm text-gray-500 mt-0.5">Move stock between locations. Dispatch reduces source; receipt increases destination.</p>
        </div>
        {canManage && (
          <button className="btn-primary" onClick={() => setShowCreate(true)}>+ Request Transfer</button>
        )}
      </div>

      <div className="flex gap-3 mb-4">
        <select className="input w-48" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="REQUESTED">Requested</option>
          <option value="DISPATCHED">Dispatched</option>
          <option value="RECEIVED">Received</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <button className="btn-secondary" onClick={load}>Refresh</button>
      </div>

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
      ) : transfers.length === 0 ? (
        <div className="card text-center py-12 text-gray-400">No transfers found.</div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr>
                  {['TR #', 'Item', 'From', 'To', 'Qty', 'Status', 'Requested By', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {transfers.map(tr => (
                  <tr key={tr.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-xs font-mono text-gray-600">{tr.transferNumber}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{tr.itemName}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{tr.sourceLocation?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{tr.destLocation?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 font-medium">{tr.quantity}</td>
                    <td className="px-4 py-3"><StatusBadge status={tr.status} /></td>
                    <td className="px-4 py-3 text-sm text-gray-600">{tr.requestedBy?.name ?? '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {canManage && tr.status === 'REQUESTED' && (
                          <button
                            className="text-xs text-orange-600 hover:text-orange-800 font-medium disabled:opacity-40"
                            disabled={actionLoading === `${tr.id}-dispatch`}
                            onClick={() => handleAction(tr.id, 'dispatch')}
                          >
                            {actionLoading === `${tr.id}-dispatch` ? '…' : 'Dispatch'}
                          </button>
                        )}
                        {canManage && tr.status === 'DISPATCHED' && (
                          <button
                            className="text-xs text-green-600 hover:text-green-800 font-medium disabled:opacity-40"
                            disabled={actionLoading === `${tr.id}-receive`}
                            onClick={() => handleAction(tr.id, 'receive')}
                          >
                            {actionLoading === `${tr.id}-receive` ? '…' : 'Receive'}
                          </button>
                        )}
                        {canCancel && tr.status === 'REQUESTED' && (
                          <button
                            className="text-xs text-red-500 hover:text-red-700 font-medium disabled:opacity-40"
                            disabled={actionLoading === `${tr.id}-cancel`}
                            onClick={() => handleAction(tr.id, 'cancel')}
                          >
                            {actionLoading === `${tr.id}-cancel` ? '…' : 'Cancel'}
                          </button>
                        )}
                      </div>
                    </td>
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
