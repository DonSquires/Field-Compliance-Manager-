/**
 * WorkshopPage.tsx (admin: 'workshop' — manufacturing & maintenance module)
 *
 * User / job: a workshop administrator raises fabrication builds and
 * maintenance visits, prices them from the price book (or a reusable BOM
 * template), runs them draft → approved → in progress → completed, keeps
 * stock-on-hand honest per workshop/van, and turns completed work into a draft
 * invoice with one action.
 *
 * Canonical schema (20260916110000):
 * - workshop_work_order_summary (view) / workshop_work_order_lines
 * - workshop_bom_templates / workshop_bom_template_lines
 * - finance_inventory_locations / finance_inventory_balances (+ finance_price_book for names)
 * - RPCs: create_workshop_work_order, add_workshop_work_order_line,
 *   remove_workshop_work_order_line, advance_workshop_work_order_status,
 *   manage_workshop_bom_template, manage_finance_inventory_location,
 *   record_finance_inventory_transaction, generate_crm_invoice_from_completed_work
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PriceListPicker, usePriceList } from '../components/PriceListPicker';
import { useAuth } from '../context/AuthContext';
import type { PriceListSelection } from '../lib/priceList';
import { supabase } from '../lib/supabase';
import {
  LINE_KIND_LABELS,
  WORK_ORDER_KIND_LABELS,
  WORK_ORDER_STATUS_LABELS,
  buildTemplateLinesPayload,
  describeCompletionEffect,
  isWorkOrderOpen,
  lineKindFromSelection,
  money,
  nextWorkOrderActions,
  summariseLines,
  type BomTemplateLineInput,
  type WorkOrderKind,
  type WorkClassificationOption,
  type WorkOrderLine,
  type WorkOrderLineKind,
  type WorkOrderStatus,
  type WorkOrderSummary,
} from '../lib/workshop';
import './PageStyles.css';
import './WorkshopPage.css';

type Tab = 'orders' | 'templates' | 'stock';

interface AgreementOption { id: string; name: string; client_organization_id: string; client: { name: string } | { name: string }[] | null; }
interface SiteOption { id: string; name: string; client_organization_id: string; }
interface AssetOption { id: string; name: string; asset_type: string; }
interface StockLocation { id: string; name: string; location_type: string; active: boolean; }
interface StockBalance { item_id: string; location_id: string; on_hand: number; reserved: number; }
interface PersonOption { id: string; display_name: string | null; email: string | null; role: string; }
interface BomTemplate { id: string; name: string; description: string | null; kind: WorkOrderKind; active: boolean; }
interface BomTemplateLine { id: string; template_id: string; line_kind: WorkOrderLineKind; item_id: string | null; description: string; quantity: number; unit_of_measure: string | null; position: number; }

const clientName = (agreement: AgreementOption): string => {
  const client = Array.isArray(agreement.client) ? agreement.client[0] : agreement.client;
  return client?.name ?? 'Client';
};

const requestId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

const emptyOrderForm = { kind: 'fabrication' as WorkOrderKind, workSubjectCodeId: '', workActivityCodeId: '', title: '', description: '', agreementId: '', siteId: '', assetId: '', stockLocationId: '', assignedUserId: '', scheduledFor: '', templateId: '' };
const emptyLineForm = { token: '', selection: null as PriceListSelection | null, lineKind: 'material' as WorkOrderLineKind, description: '', quantity: '1', unitPrice: '', unitCost: '' };
const emptyTemplateForm = { id: '', name: '', description: '', kind: 'fabrication' as WorkOrderKind, lines: [] as BomTemplateLineInput[] };
const emptyReceiptForm = { token: '', itemId: '', itemName: '', locationId: '', quantity: '1', unitCost: '', reference: '' };

export default function WorkshopPage({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const { profile, operatingOrganizationId } = useAuth();
  const organizationId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const orgIds = useMemo(() => (organizationId ? [organizationId] : []), [organizationId]);
  const { items: priceItems } = usePriceList(orgIds);

  const [tab, setTab] = useState<Tab>('orders');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [orders, setOrders] = useState<WorkOrderSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lines, setLines] = useState<WorkOrderLine[]>([]);
  const [agreements, setAgreements] = useState<AgreementOption[]>([]);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [balances, setBalances] = useState<StockBalance[]>([]);
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [templates, setTemplates] = useState<BomTemplate[]>([]);
  const [templateLines, setTemplateLines] = useState<BomTemplateLine[]>([]);
  const [workClassifications, setWorkClassifications] = useState<WorkClassificationOption[]>([]);

  const [showOrderForm, setShowOrderForm] = useState(false);
  const [orderForm, setOrderForm] = useState(emptyOrderForm);
  const [lineForm, setLineForm] = useState(emptyLineForm);
  const [statusNote, setStatusNote] = useState('');
  const [showInvoice, setShowInvoice] = useState(false);
  const [invoiceForm, setInvoiceForm] = useState({ clientId: '', periodStart: '', periodEnd: '' });
  const [templateForm, setTemplateForm] = useState(emptyTemplateForm);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [templateLineDraft, setTemplateLineDraft] = useState({ token: '', selection: null as PriceListSelection | null, lineKind: 'material' as WorkOrderLineKind, description: '', quantity: '1' });
  const [locationForm, setLocationForm] = useState({ name: '', type: 'warehouse' });
  const [receiptForm, setReceiptForm] = useState(emptyReceiptForm);

  const load = useCallback(async () => {
    if (!organizationId) {
      setError('Organisation access could not be confirmed. Workshop data is unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    // ATLAS READS: workshop_work_order_summary, service_agreements, client_sites, assets, finance_inventory_locations, finance_inventory_balances, user_profiles, workshop_bom_templates, workshop_bom_template_lines, reference_codes
    const [ordersRes, agreementsRes, assetsRes, locationsRes, balancesRes, peopleRes, templatesRes, templateLinesRes, classificationsRes] = await Promise.all([
      supabase.from('workshop_work_order_summary').select('*').eq('organization_id', organizationId).order('updated_at', { ascending: false }).limit(300),
      supabase.from('service_agreements').select('id,name,client_organization_id,client:client_organization_id(name)').eq('provider_organization_id', organizationId).in('agreement_type', ['operational', 'financial']).order('name'),
      supabase.from('assets').select('id,name,asset_type').eq('organization_id', organizationId).order('name').limit(300),
      supabase.from('finance_inventory_locations').select('id,name,location_type,active').eq('organization_id', organizationId).order('name'),
      supabase.from('finance_inventory_balances').select('item_id,location_id,on_hand,reserved').eq('organization_id', organizationId),
      supabase.from('user_profiles').select('id,display_name,email,role').eq('organization_id', organizationId).is('deactivated_at', null).order('display_name').limit(300),
      supabase.from('workshop_bom_templates').select('id,name,description,kind,active').eq('organization_id', organizationId).order('name'),
      supabase.from('workshop_bom_template_lines').select('id,template_id,line_kind,item_id,description,quantity,unit_of_measure,position').eq('organization_id', organizationId).order('position'),
      supabase.from('reference_codes').select('id,code_type,code,name,description,sort_order').eq('organization_id', organizationId).in('code_type', ['work_subject', 'work_activity']).eq('is_active', true).order('sort_order'),
    ]);
    const firstError = [ordersRes, agreementsRes, assetsRes, locationsRes, balancesRes, peopleRes, templatesRes, templateLinesRes, classificationsRes].find((res) => res.error)?.error;
    if (firstError) {
      setError(firstError.message);
      setLoading(false);
      return;
    }
    const orderRows = (ordersRes.data as WorkOrderSummary[]) ?? [];
    setOrders(orderRows);
    setAgreements((agreementsRes.data as AgreementOption[]) ?? []);
    setAssets((assetsRes.data as AssetOption[]) ?? []);
    setLocations((locationsRes.data as StockLocation[]) ?? []);
    setBalances((balancesRes.data as StockBalance[]) ?? []);
    setPeople((peopleRes.data as PersonOption[]) ?? []);
    setTemplates((templatesRes.data as BomTemplate[]) ?? []);
    setTemplateLines((templateLinesRes.data as BomTemplateLine[]) ?? []);
    setWorkClassifications((classificationsRes.data as WorkClassificationOption[]) ?? []);
    const clientIds = Array.from(new Set(((agreementsRes.data as AgreementOption[]) ?? []).map((row) => row.client_organization_id)));
    if (clientIds.length > 0) {
      const sitesRes = await supabase.from('client_sites').select('id,name,client_organization_id').in('client_organization_id', clientIds).eq('active', true).order('name').limit(500);
      if (!sitesRes.error) setSites((sitesRes.data as SiteOption[]) ?? []);
    } else {
      setSites([]);
    }
    setSelectedId((current) => current && orderRows.some((row) => row.id === current) ? current : orderRows[0]?.id ?? null);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => orders.find((row) => row.id === selectedId) ?? null, [orders, selectedId]);
  const workSubjects = useMemo(() => workClassifications.filter((option) => option.code_type === 'work_subject'), [workClassifications]);
  const workActivities = useMemo(() => workClassifications.filter((option) => option.code_type === 'work_activity'), [workClassifications]);

  useEffect(() => {
    if (!selectedId) { setLines([]); return; }
    let cancelled = false;
    // ATLAS READS: workshop_work_order_lines
    void supabase.from('workshop_work_order_lines').select('id,work_order_id,line_kind,item_id,description,quantity,unit_of_measure,unit_cost,unit_price,line_total,inventory_transaction_id,invoice_line_item_id,position')
      .eq('work_order_id', selectedId).order('position')
      .then((res) => { if (cancelled) return; if (res.error) setError(res.error.message); else setLines((res.data as WorkOrderLine[]) ?? []); });
    return () => { cancelled = true; };
  }, [selectedId, orders]);

  const run = async (label: string, action: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const detail = await action();
      await load();
      setNotice(detail || label);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateOrder = (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId) return;
    const agreement = agreements.find((row) => row.id === orderForm.agreementId) ?? null;
    void run('Work order created.', async () => {
      // ATLAS CALLS: create_workshop_work_order
      const { data, error: rpcError } = await supabase.rpc('create_workshop_work_order', {
        p_client_request_id: requestId(),
        p_organization_id: organizationId,
        p_kind: orderForm.kind,
        p_title: orderForm.title,
        p_work_subject_code_id: orderForm.kind === 'maintenance' ? orderForm.workSubjectCodeId || null : null,
        p_work_activity_code_id: orderForm.kind === 'maintenance' ? orderForm.workActivityCodeId || null : null,
        p_description: orderForm.description || null,
        p_client_organization_id: agreement?.client_organization_id ?? null,
        p_service_agreement_id: agreement?.id ?? null,
        p_client_site_id: orderForm.siteId || null,
        p_asset_id: orderForm.assetId || null,
        p_inventory_location_id: orderForm.stockLocationId || null,
        p_assigned_user_id: orderForm.assignedUserId || null,
        p_scheduled_for: orderForm.scheduledFor ? new Date(orderForm.scheduledFor).toISOString() : null,
        p_bom_template_id: orderForm.templateId || null,
      });
      if (rpcError) throw new Error(rpcError.message);
      setShowOrderForm(false);
      setOrderForm(emptyOrderForm);
      const created = data as { id?: string } | null;
      if (created?.id) setSelectedId(created.id);
    });
  };

  const handleAddLine = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    void run('Line added.', async () => {
      // ATLAS CALLS: add_workshop_work_order_line
      const { error: rpcError } = await supabase.rpc('add_workshop_work_order_line', {
        p_client_request_id: requestId(),
        p_work_order_id: selected.id,
        p_line_kind: lineForm.lineKind,
        p_item_id: lineForm.selection?.source === 'item' ? lineForm.selection.id : null,
        p_description: lineForm.description || lineForm.selection?.description || null,
        p_quantity: Number(lineForm.quantity),
        p_unit_price: lineForm.unitPrice === '' ? null : Number(lineForm.unitPrice),
        p_unit_cost: lineForm.unitCost === '' ? null : Number(lineForm.unitCost),
      });
      if (rpcError) throw new Error(rpcError.message);
      setLineForm(emptyLineForm);
    });
  };

  const handleRemoveLine = (line: WorkOrderLine) => {
    if (!selected) return;
    void run('Line removed.', async () => {
      // ATLAS CALLS: remove_workshop_work_order_line
      const { error: rpcError } = await supabase.rpc('remove_workshop_work_order_line', { p_work_order_id: selected.id, p_line_id: line.id });
      if (rpcError) throw new Error(rpcError.message);
    });
  };

  const handleAdvance = (status: WorkOrderStatus, needsNote?: boolean) => {
    if (!selected) return;
    if (needsNote && status === 'cancelled' && !statusNote.trim()) { setError('Say why the order is being cancelled.'); return; }
    void run(`Work order ${WORK_ORDER_STATUS_LABELS[status].toLowerCase()}.`, async () => {
      // ATLAS CALLS: advance_workshop_work_order_status
      const { error: rpcError } = await supabase.rpc('advance_workshop_work_order_status', { p_work_order_id: selected.id, p_status: status, p_note: statusNote || null });
      if (rpcError) throw new Error(rpcError.message);
      setStatusNote('');
    });
  };

  const handleInvoice = (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId || !invoiceForm.clientId) return;
    void run('Draft invoice created from completed work.', async () => {
      // ATLAS CALLS: generate_crm_invoice_from_completed_work
      const { data, error: rpcError } = await supabase.rpc('generate_crm_invoice_from_completed_work', {
        p_client_request_id: requestId(),
        p_organization_id: organizationId,
        p_client_organization_id: invoiceForm.clientId,
        p_service_agreement_id: null,
        p_period_start: invoiceForm.periodStart || null,
        p_period_end: invoiceForm.periodEnd || null,
      });
      if (rpcError) throw new Error(rpcError.message);
      const invoice = data as { invoice_number?: string; total_amount?: number } | null;
      setShowInvoice(false);
      return `Draft invoice ${invoice?.invoice_number ?? ''} for ${money(invoice?.total_amount ?? null)} created. Review it under Invoices before sending.`;
    });
  };

  const handleSaveTemplate = (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId) return;
    void run(templateForm.id ? 'Template updated.' : 'Template created.', async () => {
      const payload = buildTemplateLinesPayload(templateForm.lines);
      // ATLAS CALLS: manage_workshop_bom_template
      const { error: rpcError } = await supabase.rpc('manage_workshop_bom_template', {
        p_client_request_id: requestId(),
        p_organization_id: organizationId,
        p_action: templateForm.id ? 'update' : 'create',
        p_template_id: templateForm.id || null,
        p_name: templateForm.name,
        p_description: templateForm.description || null,
        p_kind: templateForm.kind,
        p_lines: payload,
      });
      if (rpcError) throw new Error(rpcError.message);
      setShowTemplateForm(false);
      setTemplateForm(emptyTemplateForm);
    });
  };

  const handleArchiveTemplate = (template: BomTemplate) => {
    if (!organizationId) return;
    void run('Template archived.', async () => {
      const { error: rpcError } = await supabase.rpc('manage_workshop_bom_template', { p_client_request_id: requestId(), p_organization_id: organizationId, p_action: 'archive', p_template_id: template.id, p_name: null, p_description: null, p_kind: template.kind, p_lines: [] });
      if (rpcError) throw new Error(rpcError.message);
    });
  };

  const handleCreateLocation = (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId) return;
    void run('Stock location added.', async () => {
      // ATLAS CALLS: manage_finance_inventory_location
      const { error: rpcError } = await supabase.rpc('manage_finance_inventory_location', { p_organization_id: organizationId, p_action: 'create', p_location_id: null, p_name: locationForm.name, p_location_type: locationForm.type, p_asset_id: null });
      if (rpcError) throw new Error(rpcError.message);
      setLocationForm({ name: '', type: 'warehouse' });
    });
  };

  const handleReceipt = (event: React.FormEvent) => {
    event.preventDefault();
    if (!receiptForm.itemId || !receiptForm.locationId) { setError('Pick the item and the stock location the goods arrived at.'); return; }
    void run('Stock receipt recorded.', async () => {
      // ATLAS CALLS: record_finance_inventory_transaction (receipt)
      const { error: rpcError } = await supabase.rpc('record_finance_inventory_transaction', {
        p_item_id: receiptForm.itemId,
        p_location_id: receiptForm.locationId,
        p_transaction_type: 'receipt',
        p_quantity: Number(receiptForm.quantity),
        p_unit_cost: Number(receiptForm.unitCost || 0),
        p_idempotency_key: requestId(),
        p_source_reference: receiptForm.reference || null,
      });
      if (rpcError) throw new Error(rpcError.message);
      setReceiptForm(emptyReceiptForm);
    });
  };

  const openTemplateEditor = (template?: BomTemplate) => {
    if (template) {
      setTemplateForm({
        id: template.id,
        name: template.name,
        description: template.description ?? '',
        kind: template.kind,
        lines: templateLines.filter((line) => line.template_id === template.id).map((line) => ({ line_kind: line.line_kind, item_id: line.item_id, description: line.description, quantity: Number(line.quantity), unit_of_measure: line.unit_of_measure })),
      });
    } else {
      setTemplateForm(emptyTemplateForm);
    }
    setShowTemplateForm(true);
  };

  const addTemplateLine = () => {
    const quantity = Number(templateLineDraft.quantity);
    const selection = templateLineDraft.selection;
    const description = templateLineDraft.description.trim() || selection?.description || '';
    if (!(quantity > 0) || !description) { setError('A template line needs a description (or a price-book item) and a quantity above zero.'); return; }
    setError(null);
    setTemplateForm((form) => ({ ...form, lines: [...form.lines, { line_kind: templateLineDraft.lineKind, item_id: selection?.source === 'item' ? selection.id : null, description, quantity, unit_of_measure: selection?.unit ?? null }] }));
    setTemplateLineDraft({ token: '', selection: null, lineKind: 'material', description: '', quantity: '1' });
  };

  const itemName = (itemId: string) => priceItems.find((item) => item.item_id === itemId);
  const clientSites = sites.filter((site) => { const agreement = agreements.find((row) => row.id === orderForm.agreementId); return !agreement || site.client_organization_id === agreement.client_organization_id; });
  const clients = useMemo(() => { const seen = new Map<string, string>(); agreements.forEach((row) => seen.set(row.client_organization_id, clientName(row))); return Array.from(seen.entries()); }, [agreements]);
  const uninvoiced = orders.filter((row) => row.status === 'completed' && row.uninvoiced_total > 0);
  const summary = summariseLines(lines);

  if (loading) {
    return <div className="page-container"><div className="loading-state"><div className="spinner"></div><p>Loading workshop…</p></div></div>;
  }

  return (
    <div className="page-container workshop-page">
      <header className="page-header workshop-header">
        <div>
          <h1>Workshop</h1>
          <p className="subtitle">Build things, fix things, and bill them without re-typing. Materials and labour come from your price list; stock moves when a job completes.</p>
        </div>
        <div className="workshop-header__actions">
          <button type="button" className="btn btn-secondary" onClick={() => { setShowInvoice((value) => !value); setInvoiceForm({ clientId: uninvoiced[0]?.client_organization_id ?? '', periodStart: '', periodEnd: '' }); }} disabled={busy}>
            Invoice completed work{uninvoiced.length > 0 ? ` (${uninvoiced.length})` : ''}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => { setTab('orders'); setShowOrderForm(true); }} disabled={busy}>New work order</button>
        </div>
      </header>

      {error && <div className="alert alert-error" role="alert"><button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">×</button>{error}</div>}
      {notice && <div className="alert alert-success" role="status"><button className="alert-close" onClick={() => setNotice(null)} aria-label="Close notice">×</button>{notice}{notice.startsWith('Draft invoice') && onNavigate && <button type="button" className="btn btn-sm btn-secondary workshop-inline-btn" onClick={() => onNavigate('finance-money')}>Open invoices</button>}</div>}

      {showInvoice && (
        <form className="assessment-form workshop-card" onSubmit={handleInvoice}>
          <h3>Invoice completed work</h3>
          <p className="workshop-hint">Every completed workshop line and dispatch charge for this client that has not been invoiced yet goes onto one draft invoice. Nothing is billed twice.</p>
          <div className="form-row">
            <div className="form-group"><label htmlFor="invoice-client">Client</label>
              <select id="invoice-client" value={invoiceForm.clientId} onChange={(event) => setInvoiceForm({ ...invoiceForm, clientId: event.target.value })} required>
                <option value="">Choose a client…</option>
                {clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </div>
            <div className="form-group"><label htmlFor="invoice-start">Work completed from (optional)</label><input id="invoice-start" type="date" value={invoiceForm.periodStart} onChange={(event) => setInvoiceForm({ ...invoiceForm, periodStart: event.target.value })} /></div>
            <div className="form-group"><label htmlFor="invoice-end">to (optional)</label><input id="invoice-end" type="date" value={invoiceForm.periodEnd} onChange={(event) => setInvoiceForm({ ...invoiceForm, periodEnd: event.target.value })} /></div>
          </div>
          <div className="workshop-form-actions"><button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Create draft invoice</button><button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowInvoice(false)}>Cancel</button></div>
        </form>
      )}

      <nav className="workshop-tabs" aria-label="Workshop sections">
        <button type="button" className={tab === 'orders' ? 'is-active' : ''} onClick={() => setTab('orders')}>Work orders <strong>{orders.filter((row) => isWorkOrderOpen(row.status)).length} open</strong></button>
        <button type="button" className={tab === 'templates' ? 'is-active' : ''} onClick={() => setTab('templates')}>Templates <strong>{templates.filter((row) => row.active).length}</strong></button>
        <button type="button" className={tab === 'stock' ? 'is-active' : ''} onClick={() => setTab('stock')}>Stock <strong>{locations.filter((row) => row.active).length} locations</strong></button>
      </nav>

      {tab === 'orders' && (
        <div className="workshop-layout">
          <aside className="workshop-list" aria-label="Work orders">
            {showOrderForm && (
              <form className="assessment-form workshop-card" onSubmit={handleCreateOrder}>
                <h3>New work order</h3>
                <div className="form-group"><label htmlFor="wo-kind">What kind of job?</label>
                  <select id="wo-kind" value={orderForm.kind} onChange={(event) => setOrderForm({ ...orderForm, kind: event.target.value as WorkOrderKind, workSubjectCodeId: '', workActivityCodeId: '', templateId: '' })}>
                    {(Object.keys(WORK_ORDER_KIND_LABELS) as WorkOrderKind[]).map((kind) => <option key={kind} value={kind}>{WORK_ORDER_KIND_LABELS[kind]}</option>)}
                  </select>
                </div>
                {orderForm.kind === 'maintenance' && <div className="form-row">
                  <div className="form-group"><label htmlFor="wo-subject">What is being worked on?</label><select id="wo-subject" required value={orderForm.workSubjectCodeId} onChange={(event) => setOrderForm({ ...orderForm, workSubjectCodeId: event.target.value })}><option value="">Choose the subject…</option>{workSubjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select>{workSubjects.length === 0 && <small>No active work subjects are configured for this organisation.</small>}</div>
                  <div className="form-group"><label htmlFor="wo-activity">What work is being done?</label><select id="wo-activity" required value={orderForm.workActivityCodeId} onChange={(event) => setOrderForm({ ...orderForm, workActivityCodeId: event.target.value })}><option value="">Choose the work…</option>{workActivities.map((activity) => <option key={activity.id} value={activity.id}>{activity.name}</option>)}</select>{workActivities.length === 0 && <small>No active work activities are configured for this organisation.</small>}</div>
                </div>}
                <div className="form-group"><label htmlFor="wo-title">Title</label><input id="wo-title" required value={orderForm.title} onChange={(event) => setOrderForm({ ...orderForm, title: event.target.value })} placeholder={orderForm.kind === 'fabrication' ? 'e.g. Lockbox for Depot gate' : 'e.g. Replace gate hinges'} /></div>
                <div className="form-group"><label htmlFor="wo-template">Start from a template (optional)</label>
                  <select id="wo-template" value={orderForm.templateId} onChange={(event) => setOrderForm({ ...orderForm, templateId: event.target.value })}>
                    <option value="">No template — add lines by hand</option>
                    {templates.filter((row) => row.active && row.kind === orderForm.kind).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                  </select>
                </div>
                <div className="form-group"><label htmlFor="wo-agreement">Client agreement (who gets billed)</label>
                  <select id="wo-agreement" value={orderForm.agreementId} onChange={(event) => setOrderForm({ ...orderForm, agreementId: event.target.value, siteId: '' })}>
                    <option value="">Internal — no client</option>
                    {agreements.map((row) => <option key={row.id} value={row.id}>{clientName(row)} · {row.name}</option>)}
                  </select>
                </div>
                {orderForm.kind === 'maintenance' && (
                  <div className="form-row">
                    <div className="form-group"><label htmlFor="wo-site">Place</label>
                      <select id="wo-site" value={orderForm.siteId} onChange={(event) => setOrderForm({ ...orderForm, siteId: event.target.value })}>
                        <option value="">Choose a site…</option>
                        {clientSites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
                      </select>
                    </div>
                    <div className="form-group"><label htmlFor="wo-asset">Asset (optional)</label>
                      <select id="wo-asset" value={orderForm.assetId} onChange={(event) => setOrderForm({ ...orderForm, assetId: event.target.value })}>
                        <option value="">None</option>
                        {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · {asset.asset_type}</option>)}
                      </select>
                    </div>
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group"><label htmlFor="wo-stock">Draw materials from stock at</label>
                    <select id="wo-stock" value={orderForm.stockLocationId} onChange={(event) => setOrderForm({ ...orderForm, stockLocationId: event.target.value })}>
                      <option value="">Don't track stock for this job</option>
                      {locations.filter((row) => row.active).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group"><label htmlFor="wo-assigned">Assigned to</label>
                    <select id="wo-assigned" value={orderForm.assignedUserId} onChange={(event) => setOrderForm({ ...orderForm, assignedUserId: event.target.value })}>
                      <option value="">Unassigned</option>
                      {people.map((person) => <option key={person.id} value={person.id}>{person.display_name ?? person.email ?? person.id}</option>)}
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label htmlFor="wo-scheduled">Scheduled for</label><input id="wo-scheduled" type="datetime-local" value={orderForm.scheduledFor} onChange={(event) => setOrderForm({ ...orderForm, scheduledFor: event.target.value })} /></div>
                </div>
                <div className="form-group"><label htmlFor="wo-description">Notes</label><textarea id="wo-description" rows={2} value={orderForm.description} onChange={(event) => setOrderForm({ ...orderForm, description: event.target.value })} /></div>
                <div className="workshop-form-actions"><button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Create work order</button><button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowOrderForm(false)}>Cancel</button></div>
              </form>
            )}
            {orders.length === 0 && !showOrderForm ? (
              <div className="empty-state"><p>No work orders yet. Create one to price a build or a maintenance visit from your price list.</p></div>
            ) : (
              <ul className="workshop-order-list">
                {orders.map((row) => (
                  <li key={row.id}>
                    <button type="button" className={`workshop-order-card ${row.id === selectedId ? 'is-active' : ''}`} onClick={() => setSelectedId(row.id)}>
                      <span className="workshop-order-card__number">{row.order_number}</span>
                      <span className={`badge workshop-status workshop-status--${row.status}`}>{WORK_ORDER_STATUS_LABELS[row.status]}</span>
                      <strong>{row.title}</strong>
                      <span className="workshop-order-card__meta">{row.kind === 'fabrication' ? 'Fabrication' : 'Maintenance'} · {row.client_name ?? 'Internal'}{row.site_name ? ` · ${row.site_name}` : ''}</span>
                      <span className="workshop-order-card__meta">{row.line_count} line{row.line_count === 1 ? '' : 's'} · {money(row.charge_total)}{row.status === 'completed' && row.uninvoiced_total > 0 ? ` · ${money(row.uninvoiced_total)} to invoice` : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="workshop-detail" aria-live="polite">
            {!selected ? (
              <div className="empty-state"><p>Select a work order to see its bill of materials and move it along.</p></div>
            ) : (
              <>
                <div className="workshop-detail__header">
                  <div>
                    <span className="workshop-eyebrow">{selected.order_number} · {selected.kind === 'fabrication' ? 'Fabrication' : 'Maintenance'}</span>
                    <h2>{selected.title}</h2>
                    <p className="workshop-detail__meta">
                      {selected.client_name ? `Billed to ${selected.client_name}` : 'Internal job'}
                      {selected.site_name ? ` · at ${selected.site_name}` : ''}{selected.asset_name ? ` · asset ${selected.asset_name}` : ''}
                      {selected.assigned_name ? ` · ${selected.assigned_name}` : ' · unassigned'}
                      {selected.scheduled_for ? ` · ${new Date(selected.scheduled_for).toLocaleString('en-NZ')}` : ''}
                    </p>
                    <p className="workshop-detail__meta">Stock: {selected.stock_location_name ?? 'not tracked for this job'}{selected.template_name ? ` · from template ${selected.template_name}` : ''}</p>
                  </div>
                  <span className={`badge workshop-status workshop-status--${selected.status}`}>{WORK_ORDER_STATUS_LABELS[selected.status]}</span>
                </div>
                {selected.description && <p className="workshop-detail__notes">{selected.description}</p>}
                {selected.kind === 'maintenance' && <p className="workshop-detail__meta">{selected.work_subject_name ?? 'Subject not classified'} · {selected.work_activity_name ?? 'Activity not classified'}</p>}

                <div className="workshop-totals">
                  <div><span>Charge</span><strong>{money(summary.charge)}</strong></div>
                  <div><span>Cost</span><strong>{money(summary.cost)}</strong></div>
                  <div><span>Margin</span><strong>{summary.marginPct === null ? '—' : `${summary.marginPct}%`}</strong></div>
                  {selected.status === 'completed' && <div><span>Still to invoice</span><strong>{money(selected.uninvoiced_total)}</strong></div>}
                </div>

                <table className="workshop-lines workshop-lines--priced">
                  <thead><tr><th>Kind</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Total</th><th aria-label="Actions"></th></tr></thead>
                  <tbody>
                    {lines.length === 0 ? (
                      <tr><td colSpan={6} className="workshop-lines__empty">No lines yet — add materials, labour and travel below.</td></tr>
                    ) : lines.map((line) => (
                      <tr key={line.id}>
                        <td><span className={`badge workshop-line-kind workshop-line-kind--${line.line_kind}`}>{LINE_KIND_LABELS[line.line_kind]}</span></td>
                        <td>{line.description}{line.inventory_transaction_id ? <span className="workshop-line-flag">stock drawn</span> : null}{line.invoice_line_item_id ? <span className="workshop-line-flag">invoiced</span> : null}</td>
                        <td>{Number(line.quantity)} {line.unit_of_measure ?? ''}</td>
                        <td>{money(Number(line.unit_price))}</td>
                        <td>{money(Number(line.line_total))}</td>
                        <td>{isWorkOrderOpen(selected.status) && <button type="button" className="btn btn-sm btn-secondary" onClick={() => handleRemoveLine(line)} disabled={busy} aria-label={`Remove ${line.description}`}>Remove</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {isWorkOrderOpen(selected.status) && (
                  <form className="assessment-form workshop-card" onSubmit={handleAddLine}>
                    <h3>Add a line</h3>
                    <PriceListPicker
                      id="workshop-line-picker"
                      organizationIds={orgIds}
                      value={lineForm.token}
                      label="Pick from your price list"
                      onSelect={(selection, token) => setLineForm({
                        ...lineForm,
                        token,
                        selection,
                        lineKind: lineKindFromSelection(selection),
                        description: selection ? '' : lineForm.description,
                        unitPrice: selection?.unitCharge != null ? String(selection.unitCharge) : '',
                        unitCost: selection?.unitCost != null ? String(selection.unitCost) : '',
                      })}
                    />
                    <div className="form-row">
                      <div className="form-group"><label htmlFor="line-kind">Kind</label>
                        <select id="line-kind" value={lineForm.lineKind} onChange={(event) => setLineForm({ ...lineForm, lineKind: event.target.value as WorkOrderLineKind })}>
                          {(Object.keys(LINE_KIND_LABELS) as WorkOrderLineKind[]).map((kind) => <option key={kind} value={kind}>{LINE_KIND_LABELS[kind]}</option>)}
                        </select>
                      </div>
                      <div className="form-group"><label htmlFor="line-description">Description</label><input id="line-description" value={lineForm.description} onChange={(event) => setLineForm({ ...lineForm, description: event.target.value })} placeholder={lineForm.selection ? lineForm.selection.description : 'e.g. Travel to site'} /></div>
                    </div>
                    <div className="form-row">
                      <div className="form-group"><label htmlFor="line-qty">Quantity{lineForm.selection ? ` (${lineForm.selection.unit})` : ''}</label><input id="line-qty" type="number" min="0.001" step="0.001" required value={lineForm.quantity} onChange={(event) => setLineForm({ ...lineForm, quantity: event.target.value })} /></div>
                      <div className="form-group"><label htmlFor="line-price">Unit price (charge)</label><input id="line-price" type="number" min="0" step="0.01" value={lineForm.unitPrice} onChange={(event) => setLineForm({ ...lineForm, unitPrice: event.target.value })} placeholder="From price list" /></div>
                      <div className="form-group"><label htmlFor="line-cost">Unit cost (optional)</label><input id="line-cost" type="number" min="0" step="0.01" value={lineForm.unitCost} onChange={(event) => setLineForm({ ...lineForm, unitCost: event.target.value })} placeholder="From price list" /></div>
                    </div>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Add line</button>
                  </form>
                )}

                {nextWorkOrderActions(selected.status).length > 0 && (
                  <div className="workshop-card workshop-actions">
                    <h3>Next step</h3>
                    <p className="workshop-hint">{describeCompletionEffect(selected, lines)}</p>
                    <div className="form-group"><label htmlFor="status-note">Note (required to cancel; recommended on completion)</label><input id="status-note" value={statusNote} onChange={(event) => setStatusNote(event.target.value)} placeholder="e.g. Built, powder-coated and delivered" /></div>
                    <div className="workshop-form-actions">
                      {nextWorkOrderActions(selected.status).map((action) => (
                        <button key={action.status} type="button" className={`btn btn-sm ${action.tone === 'primary' ? 'btn-primary' : action.tone === 'danger' ? 'btn-danger' : 'btn-secondary'}`} onClick={() => handleAdvance(action.status, action.needsNote)} disabled={busy}>{action.label}</button>
                      ))}
                    </div>
                  </div>
                )}
                {selected.status === 'completed' && <p className="workshop-hint">Completed {selected.completed_at ? new Date(selected.completed_at).toLocaleString('en-NZ') : ''}{selected.completion_note ? ` — ${selected.completion_note}` : ''}. Use “Invoice completed work” to bill it.</p>}
                {selected.status === 'cancelled' && <p className="workshop-hint">Cancelled{selected.completion_note ? ` — ${selected.completion_note}` : ''}.</p>}
              </>
            )}
          </section>
        </div>
      )}

      {tab === 'templates' && (
        <section className="workshop-section">
          <div className="workshop-section__header"><h2>Bill-of-materials templates</h2><button type="button" className="btn btn-primary btn-sm" onClick={() => openTemplateEditor()} disabled={busy}>New template</button></div>
          <p className="workshop-hint">A template is a saved list of materials, labour and travel. Pick it when creating a work order and the lines are copied in at today's price-book prices.</p>
          {showTemplateForm && (
            <form className="assessment-form workshop-card" onSubmit={handleSaveTemplate}>
              <h3>{templateForm.id ? 'Edit template' : 'New template'}</h3>
              <div className="form-row">
                <div className="form-group"><label htmlFor="tpl-name">Name</label><input id="tpl-name" required value={templateForm.name} onChange={(event) => setTemplateForm({ ...templateForm, name: event.target.value })} placeholder="e.g. Standard lockbox" /></div>
                <div className="form-group"><label htmlFor="tpl-kind">Used for</label>
                  <select id="tpl-kind" value={templateForm.kind} onChange={(event) => setTemplateForm({ ...templateForm, kind: event.target.value as WorkOrderKind })}>
                    {(Object.keys(WORK_ORDER_KIND_LABELS) as WorkOrderKind[]).map((kind) => <option key={kind} value={kind}>{WORK_ORDER_KIND_LABELS[kind]}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-group"><label htmlFor="tpl-description">Description</label><input id="tpl-description" value={templateForm.description} onChange={(event) => setTemplateForm({ ...templateForm, description: event.target.value })} /></div>
              <table className="workshop-lines">
                <thead><tr><th>Kind</th><th>Description</th><th>Qty</th><th aria-label="Actions"></th></tr></thead>
                <tbody>
                  {templateForm.lines.length === 0 ? <tr><td colSpan={4} className="workshop-lines__empty">No lines yet.</td></tr> : templateForm.lines.map((line, index) => (
                    <tr key={`${line.description}-${index}`}><td>{LINE_KIND_LABELS[line.line_kind]}</td><td>{line.description}</td><td>{line.quantity} {line.unit_of_measure ?? ''}</td><td><button type="button" className="btn btn-sm btn-secondary" onClick={() => setTemplateForm({ ...templateForm, lines: templateForm.lines.filter((_, i) => i !== index) })}>Remove</button></td></tr>
                  ))}
                </tbody>
              </table>
              <div className="workshop-card workshop-card--nested">
                <PriceListPicker id="workshop-template-picker" organizationIds={orgIds} value={templateLineDraft.token} label="Add from your price list" includeRates={false}
                  onSelect={(selection, token) => setTemplateLineDraft({ ...templateLineDraft, token, selection, lineKind: lineKindFromSelection(selection) })} />
                <div className="form-row">
                  <div className="form-group"><label htmlFor="tpl-line-kind">Kind</label>
                    <select id="tpl-line-kind" value={templateLineDraft.lineKind} onChange={(event) => setTemplateLineDraft({ ...templateLineDraft, lineKind: event.target.value as WorkOrderLineKind })}>
                      {(Object.keys(LINE_KIND_LABELS) as WorkOrderLineKind[]).map((kind) => <option key={kind} value={kind}>{LINE_KIND_LABELS[kind]}</option>)}
                    </select>
                  </div>
                  <div className="form-group"><label htmlFor="tpl-line-description">Description</label><input id="tpl-line-description" value={templateLineDraft.description} onChange={(event) => setTemplateLineDraft({ ...templateLineDraft, description: event.target.value })} placeholder={templateLineDraft.selection?.description ?? 'e.g. Cut, weld, finish'} /></div>
                  <div className="form-group"><label htmlFor="tpl-line-qty">Quantity</label><input id="tpl-line-qty" type="number" min="0.001" step="0.001" value={templateLineDraft.quantity} onChange={(event) => setTemplateLineDraft({ ...templateLineDraft, quantity: event.target.value })} /></div>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={addTemplateLine}>Add line to template</button>
              </div>
              <div className="workshop-form-actions"><button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Save template</button><button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowTemplateForm(false)}>Cancel</button></div>
            </form>
          )}
          {templates.filter((row) => row.active).length === 0 ? (
            <div className="empty-state"><p>No templates yet. Save your first standard build (e.g. a lockbox) so the next quote or work order takes seconds.</p></div>
          ) : (
            <div className="workshop-template-grid">
              {templates.filter((row) => row.active).map((template) => {
                const rows = templateLines.filter((line) => line.template_id === template.id);
                return (
                  <article key={template.id} className="workshop-card">
                    <div className="workshop-section__header"><h3>{template.name}</h3><span className="badge badge-info">{template.kind}</span></div>
                    {template.description && <p className="workshop-hint">{template.description}</p>}
                    <ul className="workshop-template-lines">{rows.map((line) => <li key={line.id}>{Number(line.quantity)} {line.unit_of_measure ?? ''} · {line.description} <em>({LINE_KIND_LABELS[line.line_kind]})</em></li>)}</ul>
                    <div className="workshop-form-actions"><button type="button" className="btn btn-sm btn-secondary" onClick={() => openTemplateEditor(template)} disabled={busy}>Edit</button><button type="button" className="btn btn-sm btn-secondary" onClick={() => handleArchiveTemplate(template)} disabled={busy}>Archive</button></div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {tab === 'stock' && (
        <section className="workshop-section">
          <div className="workshop-section__header"><h2>Stock on hand</h2></div>
          <p className="workshop-hint">Receive goods here when they arrive. When a work order that names a stock location completes, its materials are drawn down automatically — and completion is refused if there isn't enough on hand.</p>
          <div className="workshop-stock-grid">
            <form className="assessment-form workshop-card" onSubmit={handleCreateLocation}>
              <h3>Stock locations</h3>
              {locations.filter((row) => row.active).length === 0 ? <p className="workshop-hint">None yet — add your workshop and each van.</p> : (
                <ul className="workshop-template-lines">{locations.filter((row) => row.active).map((row) => <li key={row.id}>{row.name} <em>({row.location_type})</em></li>)}</ul>
              )}
              <div className="form-row">
                <div className="form-group"><label htmlFor="loc-name">Name</label><input id="loc-name" required value={locationForm.name} onChange={(event) => setLocationForm({ ...locationForm, name: event.target.value })} placeholder="e.g. Workshop, Van 1" /></div>
                <div className="form-group"><label htmlFor="loc-type">Type</label>
                  <select id="loc-type" value={locationForm.type} onChange={(event) => setLocationForm({ ...locationForm, type: event.target.value })}>
                    <option value="warehouse">Workshop / warehouse</option><option value="vehicle">Vehicle / van</option><option value="depot">Depot</option><option value="site">Client site</option><option value="technician">Technician</option>
                  </select>
                </div>
              </div>
              <button type="submit" className="btn btn-secondary btn-sm" disabled={busy}>Add stock location</button>
            </form>

            <form className="assessment-form workshop-card" onSubmit={handleReceipt}>
              <h3>Record a stock receipt</h3>
              <PriceListPicker id="workshop-receipt-picker" organizationIds={orgIds} value={receiptForm.token} label="Item received" includeRates={false}
                onSelect={(selection, token) => setReceiptForm({ ...receiptForm, token, itemId: selection?.source === 'item' ? selection.id : '', itemName: selection?.description ?? '', unitCost: selection?.unitCost != null ? String(selection.unitCost) : receiptForm.unitCost })} />
              <div className="form-row">
                <div className="form-group"><label htmlFor="rcpt-location">Arrived at</label>
                  <select id="rcpt-location" value={receiptForm.locationId} onChange={(event) => setReceiptForm({ ...receiptForm, locationId: event.target.value })} required>
                    <option value="">Choose a stock location…</option>
                    {locations.filter((row) => row.active).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                  </select>
                </div>
                <div className="form-group"><label htmlFor="rcpt-qty">Quantity</label><input id="rcpt-qty" type="number" min="0.001" step="0.001" required value={receiptForm.quantity} onChange={(event) => setReceiptForm({ ...receiptForm, quantity: event.target.value })} /></div>
                <div className="form-group"><label htmlFor="rcpt-cost">Unit cost paid</label><input id="rcpt-cost" type="number" min="0" step="0.01" required value={receiptForm.unitCost} onChange={(event) => setReceiptForm({ ...receiptForm, unitCost: event.target.value })} /></div>
              </div>
              <div className="form-group"><label htmlFor="rcpt-ref">Supplier invoice / reference</label><input id="rcpt-ref" value={receiptForm.reference} onChange={(event) => setReceiptForm({ ...receiptForm, reference: event.target.value })} placeholder="e.g. Steel & Tube INV-4471" /></div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Record receipt</button>
            </form>
          </div>

          <table className="workshop-lines">
            <thead><tr><th>Item</th><th>Location</th><th>On hand</th><th>Reserved</th></tr></thead>
            <tbody>
              {balances.length === 0 ? <tr><td colSpan={4} className="workshop-lines__empty">No stock recorded yet.</td></tr> : balances.map((balance) => {
                const item = itemName(balance.item_id);
                const location = locations.find((row) => row.id === balance.location_id);
                return <tr key={`${balance.item_id}-${balance.location_id}`}><td>{item ? `${item.sku} · ${item.name}` : 'Item'}</td><td>{location?.name ?? 'Location'}</td><td>{Number(balance.on_hand)} {item?.unit_of_measure ?? ''}</td><td>{Number(balance.reserved)}</td></tr>;
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
