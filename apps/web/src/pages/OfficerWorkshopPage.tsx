/**
 * OfficerWorkshopPage.tsx (Officer module: 'workshop')
 *
 * The assigned worker's view of manufacturing & maintenance work: the jobs
 * assigned to them, the bill of materials, start / complete, and recording the
 * price-book items they actually used from the field. Prices always come from
 * the price book (a worker never types a price); administrators approve,
 * cancel, price free-text lines and complete orders that draw stock.
 *
 * Canonical schema (20260916110000 + 20260916120000): workshop_work_order_summary,
 * workshop_work_order_lines, client_sites (site brief for maintenance visits);
 * RPCs advance_workshop_work_order_status, add_workshop_work_order_line,
 * remove_workshop_work_order_line; get_safety_warnings via SafetyWarningsPanel.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PriceListPicker } from '../components/PriceListPicker';
import { SafetyWarningsPanel } from '../components/SafetyWarningsPanel';
import { useAuth } from '../context/AuthContext';
import type { PriceListSelection } from '../lib/priceList';
import { supabase } from '../lib/supabase';
import {
  LINE_KIND_LABELS,
  WORK_ORDER_STATUS_LABELS,
  describeCompletionEffect,
  lineKindFromSelection,
  money,
  type WorkOrderLine,
  type WorkOrderSummary,
} from '../lib/workshop';
import './PageStyles.css';
import './WorkshopPage.css';

interface SiteBrief { id: string; name: string; address: string | null; hs_notes: string | null; access_instructions: string | null; }

const requestId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

const OfficerWorkshopPage: React.FC = () => {
  const { profile } = useAuth();
  const organizationId = profile?.organizationId ?? null;
  const orgIds = useMemo(() => (organizationId ? [organizationId] : []), [organizationId]);
  const [orders, setOrders] = useState<WorkOrderSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lines, setLines] = useState<WorkOrderLine[]>([]);
  const [site, setSite] = useState<SiteBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [lineForm, setLineForm] = useState<{ token: string; selection: PriceListSelection | null; quantity: string }>({ token: '', selection: null, quantity: '1' });

  const load = useCallback(async () => {
    if (!profile?.id || !organizationId) {
      setError('Organisation access could not be confirmed. Your work orders are unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    // ATLAS READS: workshop_work_order_summary (mine: assigned to me, open or completed in the last week)
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error: readError } = await supabase
      .from('workshop_work_order_summary')
      .select('*')
      .eq('assigned_user_id', profile.id)
      .or(`status.in.(approved,in_progress),and(status.eq.completed,completed_at.gte.${since})`)
      .order('status')
      .order('scheduled_for', { ascending: true, nullsFirst: false })
      .limit(100);
    if (readError) {
      setError(readError.message);
      setLoading(false);
      return;
    }
    const rows = (data as WorkOrderSummary[]) ?? [];
    setOrders(rows);
    setSelectedId((current) => (current && rows.some((row) => row.id === current) ? current : rows.find((row) => row.status !== 'completed')?.id ?? rows[0]?.id ?? null));
    setLoading(false);
  }, [organizationId, profile?.id]);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => orders.find((row) => row.id === selectedId) ?? null, [orders, selectedId]);

  useEffect(() => {
    if (!selected) { setLines([]); setSite(null); return; }
    let cancelled = false;
    // ATLAS READS: workshop_work_order_lines, client_sites (brief + H&S notes for a maintenance visit)
    void Promise.all([
      supabase.from('workshop_work_order_lines').select('id,work_order_id,line_kind,item_id,description,quantity,unit_of_measure,unit_cost,unit_price,line_total,inventory_transaction_id,invoice_line_item_id,position,created_by').eq('work_order_id', selected.id).order('position'),
      selected.client_site_id ? supabase.from('client_sites').select('id,name,address,hs_notes,access_instructions').eq('id', selected.client_site_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]).then(([linesRes, siteRes]) => {
      if (cancelled) return;
      if (linesRes.error) { setError(linesRes.error.message); return; }
      if (siteRes.error) { setError(siteRes.error.message); return; }
      setLines((linesRes.data as WorkOrderLine[]) ?? []);
      setSite((siteRes.data as SiteBrief | null) ?? null);
    });
    return () => { cancelled = true; };
  }, [selected]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
      setNotice(label);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  };

  const advance = (status: 'in_progress' | 'completed') => {
    if (!selected) return;
    void run(status === 'completed' ? 'Job completed. Thanks — the office takes it from here.' : 'Job started.', async () => {
      // ATLAS CALLS: advance_workshop_work_order_status (assigned worker: start / complete)
      const { error: rpcError } = await supabase.rpc('advance_workshop_work_order_status', { p_work_order_id: selected.id, p_status: status, p_note: note || null });
      if (rpcError) throw new Error(rpcError.message);
      setNote('');
    });
  };

  const addLine = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !lineForm.selection || lineForm.selection.source !== 'item') { setError('Pick the item you used from the price list.'); return; }
    const selection = lineForm.selection;
    void run('Recorded what you used.', async () => {
      // ATLAS CALLS: add_workshop_work_order_line (worker: price-book items only; price comes from the book)
      const { error: rpcError } = await supabase.rpc('add_workshop_work_order_line', {
        p_client_request_id: requestId(),
        p_work_order_id: selected.id,
        p_line_kind: lineKindFromSelection(selection),
        p_item_id: selection.id,
        p_description: null,
        p_quantity: Number(lineForm.quantity),
        p_unit_price: null,
        p_unit_cost: null,
      });
      if (rpcError) throw new Error(rpcError.message);
      setLineForm({ token: '', selection: null, quantity: '1' });
    });
  };

  const removeLine = (line: WorkOrderLine) => {
    if (!selected) return;
    void run('Line removed.', async () => {
      const { error: rpcError } = await supabase.rpc('remove_workshop_work_order_line', { p_work_order_id: selected.id, p_line_id: line.id });
      if (rpcError) throw new Error(rpcError.message);
    });
  };

  if (loading) {
    return <div className="page-container"><div className="loading-state"><div className="spinner"></div><p>Loading your work orders…</p></div></div>;
  }

  const open = orders.filter((row) => row.status !== 'completed');
  const canEditLines = selected ? selected.status === 'approved' || selected.status === 'in_progress' : false;
  const drawsStock = Boolean(selected?.inventory_location_id);

  return (
    <div className="page-container workshop-page">
      <header className="page-header">
        <h1>Workshop</h1>
        <p className="subtitle">{open.length} job{open.length === 1 ? '' : 's'} assigned to you</p>
      </header>

      {error && <div className="alert alert-error" role="alert"><button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">×</button>{error}</div>}
      {notice && <div className="alert alert-success" role="status"><button className="alert-close" onClick={() => setNotice(null)} aria-label="Close notice">×</button>{notice}</div>}

      {orders.length === 0 ? (
        <div className="empty-state"><p>Nothing assigned to you right now. Work orders appear here once the workshop approves them.</p></div>
      ) : (
        <div className="workshop-layout">
          <aside className="workshop-list" aria-label="My work orders">
            <ul className="workshop-order-list">
              {orders.map((row) => (
                <li key={row.id}>
                  <button type="button" className={`workshop-order-card ${row.id === selectedId ? 'is-active' : ''}`} onClick={() => setSelectedId(row.id)}>
                    <span className="workshop-order-card__number">{row.order_number}</span>
                    <span className={`badge workshop-status workshop-status--${row.status}`}>{WORK_ORDER_STATUS_LABELS[row.status]}</span>
                    <strong>{row.title}</strong>
                    <span className="workshop-order-card__meta">{row.kind === 'fabrication' ? 'Build' : 'Visit'}{row.site_name ? ` · ${row.site_name}` : ''}{row.client_name ? ` · ${row.client_name}` : ''}</span>
                    {row.scheduled_for && <span className="workshop-order-card__meta">{new Date(row.scheduled_for).toLocaleString('en-NZ')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className="workshop-detail" aria-live="polite">
            {selected && (
              <>
                <div className="workshop-detail__header">
                  <div>
                    <span className="workshop-eyebrow">{selected.order_number} · {selected.kind === 'fabrication' ? 'Fabrication' : 'Maintenance visit'}</span>
                    <h2>{selected.title}</h2>
                    <p className="workshop-detail__meta">{selected.client_name ?? 'Internal job'}{selected.site_name ? ` · ${selected.site_name}` : ''}{selected.asset_name ? ` · ${selected.asset_name}` : ''}{selected.scheduled_for ? ` · ${new Date(selected.scheduled_for).toLocaleString('en-NZ')}` : ''}</p>
                  </div>
                  <span className={`badge workshop-status workshop-status--${selected.status}`}>{WORK_ORDER_STATUS_LABELS[selected.status]}</span>
                </div>
                {selected.description && <p className="workshop-detail__notes">{selected.description}</p>}

                {site && (
                  <div className="workshop-card">
                    <h3>Before you go: {site.name}</h3>
                    <p className="workshop-hint">{site.address ?? 'Address not recorded'}</p>
                    <p><strong>H&S notes:</strong> {site.hs_notes || 'None recorded.'}</p>
                    <p><strong>Access:</strong> {site.access_instructions || 'None recorded.'}</p>
                  </div>
                )}
                {selected.client_site_id && <SafetyWarningsPanel entityType="site" entityId={selected.client_site_id} entityLabel="this place" />}

                <table className="workshop-lines">
                  <thead><tr><th>Kind</th><th>Item</th><th>Qty</th><th aria-label="Actions"></th></tr></thead>
                  <tbody>
                    {lines.length === 0 ? (
                      <tr><td colSpan={4} className="workshop-lines__empty">No materials or labour on this job yet.</td></tr>
                    ) : lines.map((line) => (
                      <tr key={line.id}>
                        <td><span className={`badge workshop-line-kind workshop-line-kind--${line.line_kind}`}>{LINE_KIND_LABELS[line.line_kind]}</span></td>
                        <td>{line.description}</td>
                        <td>{Number(line.quantity)} {line.unit_of_measure ?? ''}</td>
                        <td>{canEditLines && line.created_by === profile?.id && <button type="button" className="btn btn-sm btn-secondary" onClick={() => removeLine(line)} disabled={busy} aria-label={`Remove ${line.description}`}>Remove</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="workshop-hint">Bill so far: {money(selected.charge_total)} — the office prices anything not on the list.</p>

                {canEditLines && (
                  <form className="assessment-form workshop-card" onSubmit={addLine}>
                    <h3>Record what you used</h3>
                    <PriceListPicker id="officer-workshop-picker" organizationIds={orgIds} value={lineForm.token} label="Item from the price list" includeRates={false}
                      onSelect={(selection, token) => setLineForm({ ...lineForm, token, selection })} />
                    <div className="form-group"><label htmlFor="officer-line-qty">How many{lineForm.selection ? ` (${lineForm.selection.unit})` : ''}</label><input id="officer-line-qty" type="number" min="0.001" step="0.001" required value={lineForm.quantity} onChange={(event) => setLineForm({ ...lineForm, quantity: event.target.value })} /></div>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !lineForm.selection}>Add to this job</button>
                  </form>
                )}

                {selected.status === 'approved' && (
                  <div className="workshop-card workshop-actions">
                    <h3>Ready to start?</h3>
                    <button type="button" className="btn btn-primary" onClick={() => advance('in_progress')} disabled={busy}>Start work</button>
                  </div>
                )}
                {selected.status === 'in_progress' && (
                  <div className="workshop-card workshop-actions">
                    <h3>Finished?</h3>
                    <p className="workshop-hint">{describeCompletionEffect(selected, lines)}</p>
                    {drawsStock ? (
                      <p className="workshop-hint"><strong>This job draws stock from {selected.stock_location_name ?? 'a stock location'}, so a workshop administrator completes it.</strong> Make sure everything you used is recorded above, then let the office know.</p>
                    ) : (
                      <>
                        <div className="form-group"><label htmlFor="officer-completion-note">What did you do? (goes on the job record)</label><textarea id="officer-completion-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Replaced both hinges, gate swings and locks cleanly." /></div>
                        <button type="button" className="btn btn-primary" onClick={() => advance('completed')} disabled={busy}>Complete job</button>
                      </>
                    )}
                  </div>
                )}
                {selected.status === 'completed' && <p className="workshop-hint">Completed {selected.completed_at ? new Date(selected.completed_at).toLocaleString('en-NZ') : ''}{selected.completion_note ? ` — ${selected.completion_note}` : ''}.</p>}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
};

export default OfficerWorkshopPage;
