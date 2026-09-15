/**
 * PriceBookPanel — the materials and equipment price list an organisation
 * quotes and charges from. Reads finance_price_book; every write goes through
 * manage_finance_item (new approved cost + price version, or deactivate).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { PriceListItem } from './PriceListPicker';
import './PriceBookPanel.css';

type PriceBookRow = PriceListItem & { active: boolean; supplier_name: string | null; margin_pct: number | null; updated_at: string };

const ITEM_TYPES: { value: string; label: string }[] = [
  { value: 'material', label: 'Material' },
  { value: 'equipment_component', label: 'Equipment' },
  { value: 'consumable', label: 'Consumable' },
  { value: 'part', label: 'Part' },
  { value: 'ppe', label: 'PPE' },
  { value: 'fuel', label: 'Fuel' },
  { value: 'service', label: 'Service (includes labour)' },
];
const UNITS = ['ea', 'm', '2m', 'pair', 'set', 'drum', 'kg', 'L', 'hour', 'month'];
const money = (value: number | null) => value === null ? '—' : `$${Number(value).toFixed(2)}`;
const emptyForm = { sku: '', name: '', itemType: 'material', unit: 'ea', unitCost: '', unitPrice: '', supplier: '' };

export function PriceBookPanel({ organizationId }: { organizationId: string | null }) {
  const [rows, setRows] = useState<PriceBookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<PriceBookRow | null>(null);

  // ATLAS READS: finance_price_book
  const load = useCallback(async () => {
    if (!organizationId) { setRows([]); setLoading(false); return; }
    setLoading(true); setError(null);
    const { data, error: loadError } = await supabase.from('finance_price_book').select('item_id,organization_id,sku,name,item_type,unit_of_measure,active,unit_cost,supplier_name,unit_price,margin_pct,updated_at').eq('organization_id', organizationId).order('name');
    if (loadError) setError(loadError.message); else setRows((data as PriceBookRow[]) ?? []);
    setLoading(false);
  }, [organizationId]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => (showInactive || row.active) && (!q || row.name.toLowerCase().includes(q) || row.sku.toLowerCase().includes(q)));
  }, [query, rows, showInactive]);

  const startEdit = (row: PriceBookRow) => {
    setEditing(row);
    setForm({ sku: row.sku, name: row.name, itemType: row.item_type, unit: row.unit_of_measure, unitCost: row.unit_cost === null ? '' : Number(row.unit_cost).toFixed(2), unitPrice: row.unit_price === null ? '' : Number(row.unit_price).toFixed(2), supplier: row.supplier_name ?? '' });
    setShowForm(true); setNotice(null); setError(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: saveError } = await supabase.rpc('manage_finance_item', {
      p_organization_id: organizationId,
      p_action: editing ? 'reprice' : 'create',
      p_item_id: editing?.item_id ?? null,
      p_sku: editing ? null : form.sku.trim(),
      p_name: editing ? null : form.name.trim(),
      p_item_type: editing ? null : form.itemType,
      p_unit_of_measure: editing ? null : form.unit,
      p_unit_cost: Number(form.unitCost),
      p_unit_price: Number(form.unitPrice),
      p_supplier_name: form.supplier.trim() || null,
      p_source_reference: editing ? 'Repriced in Prices & discounts' : 'Added in Prices & discounts',
      p_effective_from: new Date().toISOString().slice(0, 10),
    });
    if (saveError || !data) setError(saveError?.message ?? 'The price book change was not confirmed.');
    else {
      const saved = data as PriceBookRow;
      setNotice(editing ? `${saved.name} repriced: cost ${money(saved.unit_cost)}, price ${money(saved.unit_price)}.` : `${saved.name} added to the price book.`);
      setShowForm(false); setEditing(null); setForm(emptyForm);
      await load();
    }
    setSaving(false);
  };

  const toggleActive = async (row: PriceBookRow) => {
    if (!organizationId) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: toggleError } = await supabase.rpc('manage_finance_item', { p_organization_id: organizationId, p_action: row.active ? 'deactivate' : 'reactivate', p_item_id: row.item_id, p_sku: null, p_name: null, p_item_type: null, p_unit_of_measure: null, p_unit_cost: null, p_unit_price: null });
    if (toggleError) setError(toggleError.message); else { setNotice(`${row.name} ${row.active ? 'hidden from' : 'back in'} the price list.`); await load(); }
    setSaving(false);
  };

  const margin = form.unitPrice && Number(form.unitPrice) > 0 ? ((Number(form.unitPrice) - Number(form.unitCost || 0)) / Number(form.unitPrice)) * 100 : null;

  return <section className="reports-section price-book" aria-labelledby="price-book-title">
    <header className="page-header"><div><h2 id="price-book-title">Materials and equipment</h2><p className="subtitle">What things cost you and what you charge for them. Quotes and job costs pick from this list.</p></div><div><button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading} aria-label="Refresh price book"><RefreshCw size={16} /></button><button type="button" className="btn btn-primary" onClick={() => { setEditing(null); setForm(emptyForm); setShowForm((value) => !value); }}><Plus size={16} />{showForm && !editing ? 'Cancel' : 'Add item'}</button></div></header>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    {showForm && <form className="assessment-form price-book-form" onSubmit={save} aria-label={editing ? `Reprice ${editing.name}` : 'Add price book item'}>
      <h3>{editing ? `Reprice ${editing.name}` : 'Add an item'}</h3>
      {!editing && <div className="form-row">
        <label><span>Code (SKU)</span><input required maxLength={64} value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} placeholder="e.g. 33014" /></label>
        <label><span>Name</span><input required maxLength={200} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. 4MP camera" /></label>
      </div>}
      {!editing && <div className="form-row">
        <label><span>Type</span><select value={form.itemType} onChange={(event) => setForm({ ...form, itemType: event.target.value })}>{ITEM_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
        <label><span>Sold per</span><select value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })}>{UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
      </div>}
      <div className="form-row">
        <label><span>What it costs you</span><input required type="number" min="0" step="0.01" value={form.unitCost} onChange={(event) => setForm({ ...form, unitCost: event.target.value })} /></label>
        <label><span>What you charge</span><input required type="number" min="0" step="0.01" value={form.unitPrice} onChange={(event) => setForm({ ...form, unitPrice: event.target.value })} /></label>
        <label><span>Supplier (optional)</span><input maxLength={120} value={form.supplier} onChange={(event) => setForm({ ...form, supplier: event.target.value })} /></label>
      </div>
      <div className="price-book-form-footer">
        <small>{margin === null ? 'Enter a price to see the margin.' : `Margin ${margin.toFixed(1)}% — ${money(Number(form.unitPrice) - Number(form.unitCost || 0))} kept on each ${editing?.unit_of_measure ?? form.unit}.`}</small>
        <div>{editing && <button type="button" className="btn btn-secondary" onClick={() => { setEditing(null); setShowForm(false); setForm(emptyForm); }}>Cancel</button>}<button type="submit" className="btn btn-primary" disabled={saving || !form.unitCost || !form.unitPrice || (!editing && (!form.sku.trim() || !form.name.trim()))}>{saving ? 'Saving' : editing ? 'Save new price' : 'Add to price book'}</button></div>
      </div>
    </form>}
    <div className="price-book-toolbar">
      <label><span className="sr-only">Search the price book</span><input type="search" placeholder="Search by name or code" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search the price book" /></label>
      <label className="price-book-toggle"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /> Show hidden items</label>
      <span>{visible.length} of {rows.length}</span>
    </div>
    {loading ? <div className="loading-state"><div className="spinner" /><p>Loading price book</p></div> : <div className="reports-table-wrapper"><table className="reports-table price-book-table"><thead><tr><th>Item</th><th>Type</th><th>Per</th><th>Costs you</th><th>You charge</th><th>Margin</th><th /></tr></thead><tbody>
      {visible.length === 0 ? <tr><td colSpan={7} className="text-center">{rows.length === 0 ? 'No items yet. Add the things you buy and sell, or ask Bob to load a supplier price list.' : 'Nothing matches that search.'}</td></tr>
        : visible.map((row) => <tr key={row.item_id} className={row.active ? '' : 'is-inactive'}><td><strong>{row.name}</strong><small>{row.sku}{row.supplier_name ? ` · ${row.supplier_name}` : ''}</small></td><td>{ITEM_TYPES.find((type) => type.value === row.item_type)?.label ?? row.item_type}</td><td>{row.unit_of_measure}</td><td>{money(row.unit_cost)}</td><td>{money(row.unit_price)}</td><td>{row.margin_pct === null ? '—' : `${Number(row.margin_pct).toFixed(1)}%`}</td><td className="price-book-actions"><button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => startEdit(row)}>Reprice</button><button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => void toggleActive(row)}>{row.active ? 'Hide' : 'Show'}</button></td></tr>)}
    </tbody></table></div>}
  </section>;
}
