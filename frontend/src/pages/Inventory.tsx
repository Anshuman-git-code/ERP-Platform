import React, { useState, useEffect, useCallback } from 'react';
import { inventoryApi } from '../api/inventory';
import { itemsApi } from '../api/items';
import { locationsApi } from '../api/locations';
import { useAuth } from '../contexts/AuthContext';
import { Inventory, Item, Location } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StockBadge({ qty }: { qty: number }) {
  const color =
    qty === 0 ? 'bg-red-100 text-red-700' :
      qty < 10 ? 'bg-yellow-100 text-yellow-700' :
        'bg-green-100 text-green-700';
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>{qty}</span>;
}

function extractMsg(err: unknown): string {
  const e = err as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message ?? e?.message ?? 'An error occurred.';
}

// ─── Create Inventory Modal ───────────────────────────────────────────────────

interface CreateModalProps {
  items: Item[];
  locations: Location[];
  onClose: () => void;
  onCreated: () => void;
}

function CreateModal({ items, locations, onClose, onCreated }: CreateModalProps) {
  const [itemId, setItemId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [physicalQty, setPhysicalQty] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await inventoryApi.create({ itemId, locationId, physicalQty, batchNumber: batchNumber || undefined });
      onCreated();
      onClose();
    } catch (err) { setError(extractMsg(err)); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Inventory Record</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Item</label>
            <select className="input" value={itemId} onChange={e => setItemId(e.target.value)} required>
              <option value="">Select item…</option>
              {items.map(i => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}
            </select>
          </div>
          <div>
            <label className="label">Location</label>
            <select className="input" value={locationId} onChange={e => setLocationId(e.target.value)} required>
              <option value="">Select location…</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Batch Number <span className="text-gray-400 font-normal">(leave blank for DEFAULT)</span></label>
            <input className="input" value={batchNumber} onChange={e => setBatchNumber(e.target.value)} placeholder="DEFAULT" />
          </div>
          <div>
            <label className="label">Initial Physical Quantity</label>
            <input type="number" min={0} className="input" value={physicalQty} onChange={e => setPhysicalQty(Number(e.target.value))} required />
          </div>
          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="submit" className="btn-primary flex-1" disabled={loading}>{loading ? 'Adding…' : 'Add Record'}</button>
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Adjust Stock Modal ───────────────────────────────────────────────────────

interface AdjustModalProps {
  record: Inventory;
  onClose: () => void;
  onAdjusted: () => void;
}

function AdjustModal({ record, onClose, onAdjusted }: AdjustModalProps) {
  const [txType, setTxType] = useState<'IN' | 'OUT'>('IN');
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await inventoryApi.adjust(record.id, { transactionType: txType, quantity, reason: reason || undefined });
      onAdjusted();
      onClose();
    } catch (err) { setError(extractMsg(err)); }
    finally { setLoading(false); }
  };

  const itemName = record.item?.name ?? 'Item';
  const locationName = record.location?.name ?? 'Location';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Adjust Stock</h2>
        <p className="text-sm text-gray-500 mb-4">{itemName} @ {locationName} — Batch: {record.batchNumber}</p>
        <div className="grid grid-cols-3 gap-2 mb-4 text-center text-sm">
          <div className="bg-gray-50 rounded-lg p-2"><div className="text-xs text-gray-500">Physical</div><div className="font-semibold">{record.physicalQty}</div></div>
          <div className="bg-yellow-50 rounded-lg p-2"><div className="text-xs text-gray-500">Reserved</div><div className="font-semibold">{record.reservedQty}</div></div>
          <div className="bg-green-50 rounded-lg p-2"><div className="text-xs text-gray-500">Available</div><div className="font-semibold">{record.availableQty}</div></div>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Type</label>
            <div className="flex gap-3">
              {(['IN', 'OUT'] as const).map(t => (
                <label key={t} className={`flex-1 flex items-center justify-center gap-2 rounded-lg border-2 cursor-pointer py-2 text-sm font-medium transition-colors
                  ${txType === t ? (t === 'IN' ? 'border-green-500 bg-green-50 text-green-700' : 'border-red-500 bg-red-50 text-red-700') : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                  <input type="radio" className="sr-only" value={t} checked={txType === t} onChange={() => setTxType(t)} />
                  {t === 'IN' ? '▲ Stock In' : '▼ Stock Out'}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Quantity</label>
            <input type="number" min={1} className="input" value={quantity} onChange={e => setQuantity(Number(e.target.value))} required />
          </div>
          <div>
            <label className="label">Reason <span className="text-gray-400 font-normal">(optional)</span></label>
            <input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Damaged goods, Restock" />
          </div>
          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="submit" className={`flex-1 ${txType === 'IN' ? 'btn-success' : 'btn-danger'}`} disabled={loading}>
              {loading ? 'Saving…' : `Apply ${txType}`}
            </button>
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { user } = useAuth();
  const canManage = user?.role === 'ADMIN' || user?.role === 'OPERATIONS';

  const [records, setRecords] = useState<Inventory[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState<Inventory | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = locationFilter ? { locationId: locationFilter, limit: 100 } : { limit: 100 };
      const res = await inventoryApi.list(params);
      setRecords(res.data.data);
    } catch (err) { setError(extractMsg(err)); }
    finally { setLoading(false); }
  }, [locationFilter]);

  useEffect(() => {
    load();
    itemsApi.list({ limit: 100 }).then(r => setItems(r.data.data)).catch(() => { });
    locationsApi.list().then(r => setLocations(r.data.data)).catch(() => { });
  }, [load]);

  return (
    <div>
      {showCreate && (
        <CreateModal items={items} locations={locations} onClose={() => setShowCreate(false)} onCreated={load} />
      )}
      {adjustTarget && (
        <AdjustModal record={adjustTarget} onClose={() => setAdjustTarget(null)} onAdjusted={load} />
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
          <p className="text-sm text-gray-500 mt-0.5">Physical, reserved, and available quantities by location and item.</p>
        </div>
        {canManage && (
          <button className="btn-primary" onClick={() => setShowCreate(true)}>+ Add Record</button>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex gap-3 mb-4">
        <select
          className="input w-56"
          value={locationFilter}
          onChange={e => setLocationFilter(e.target.value)}
        >
          <option value="">All Locations</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button className="btn-secondary" onClick={load}>Refresh</button>
      </div>

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
      ) : records.length === 0 ? (
        <div className="card text-center py-12 text-gray-400">No inventory records found.</div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr>
                  {['Item', 'SKU', 'Location', 'Batch', 'Physical', 'Reserved', 'Available', ...(canManage ? [''] : [])].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {records.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{r.item?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">{r.item?.sku ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{r.location?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{r.batchNumber}</td>
                    <td className="px-4 py-3"><StockBadge qty={r.physicalQty} /></td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-700">{r.reservedQty}</span>
                    </td>
                    <td className="px-4 py-3"><StockBadge qty={r.availableQty} /></td>
                    {canManage && (
                      <td className="px-4 py-3">
                        <button
                          className="text-xs text-brand-600 hover:text-brand-800 font-medium"
                          onClick={() => setAdjustTarget(r)}
                        >
                          Adjust
                        </button>
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
