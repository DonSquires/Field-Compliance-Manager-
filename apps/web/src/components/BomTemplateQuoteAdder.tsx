/**
 * BomTemplateQuoteAdder.tsx — "Add a standard build" to a draft quote.
 * Lists the provider's active workshop BOM templates and copies one onto the
 * quote as priced lines through add_crm_quote_lines_from_bom_template.
 * Renders nothing when the provider has no templates (no clutter for
 * organisations without the workshop module).
 */

import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import './BomTemplateQuoteAdder.css';

interface TemplateOption { id: string; name: string; kind: string; description: string | null; }
interface TemplateLine { id: string; line_kind: string; item_id: string | null; description: string; quantity: number; unit_of_measure: string | null; position: number; }
interface PriceBookRow { item_id: string; unit_cost: number | null; unit_price: number | null; }

export interface TemplateQuoteReceipt {
  lines_added: number;
  lines_needing_price: number;
  total_cost: number;
  subtotal_charge: number;
  total_charge: number;
}

interface Props {
  organizationIds: string[];
  quoteId: string;
  quoteStatus: string;
  siteId?: string | null;
  disabled?: boolean;
  onAdded: (receipt: TemplateQuoteReceipt, template: TemplateOption) => void | Promise<void>;
  onError: (message: string) => void;
}

const requestId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export const BomTemplateQuoteAdder: React.FC<Props> = ({ organizationIds, quoteId, quoteStatus, siteId = null, disabled = false, onAdded, onError }) => {
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [previewLines, setPreviewLines] = useState<TemplateLine[]>([]);
  const [priceBook, setPriceBook] = useState<PriceBookRow[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = organizationIds.filter(Boolean).sort().join(',');

  useEffect(() => {
    let cancelled = false;
    if (!key) { setTemplates([]); return; }
    // ATLAS READS: workshop_bom_templates (active, provider organisation)
    void supabase.from('workshop_bom_templates').select('id,name,kind,description').in('organization_id', key.split(',')).eq('active', true).order('name')
      .then((res) => { if (!cancelled && !res.error) setTemplates((res.data as TemplateOption[]) ?? []); });
    return () => { cancelled = true; };
  }, [key]);

  useEffect(() => {
    let cancelled = false;
    if (!templateId || !key) { setPreviewLines([]); setPriceBook([]); return; }
    setPreviewLoading(true);
    // A template is only a scope until current price-book values are read for this review.
    void supabase.from('workshop_bom_template_lines').select('id,line_kind,item_id,description,quantity,unit_of_measure,position').eq('template_id', templateId).order('position').then(async (linesRes) => {
      if (cancelled) return;
      if (linesRes.error) { setPreviewLines([]); setPriceBook([]); setPreviewLoading(false); return; }
      const lines = (linesRes.data as TemplateLine[]) ?? [];
      const itemIds = lines.map((line) => line.item_id).filter((itemId): itemId is string => Boolean(itemId));
      const pricesRes = itemIds.length ? await supabase.from('finance_price_book').select('item_id,unit_cost,unit_price').in('item_id', itemIds) : { data: [], error: null };
      if (cancelled) return;
      setPreviewLines(lines);
      setPriceBook((pricesRes.data as PriceBookRow[]) ?? []);
      setPreviewLoading(false);
    });
    return () => { cancelled = true; };
  }, [key, templateId]);

  if (templates.length === 0) return null;
  const selected = templates.find((template) => template.id === templateId) ?? null;
  const previewTotals = previewLines.reduce((total, line) => {
    const price = priceBook.find((row) => row.item_id === line.item_id)?.unit_price ?? null;
    return { charge: total.charge + (price === null ? 0 : Number(line.quantity) * Number(price)), unpriced: total.unpriced + (price === null ? 1 : 0) };
  }, { charge: 0, unpriced: 0 });

  const add = async () => {
    if (!selected) return;
    setBusy(true);
    // ATLAS CALLS: add_crm_quote_lines_from_bom_template (priced from the price book; idempotent per line; audited)
    const { data, error } = await supabase.rpc('add_crm_quote_lines_from_bom_template', {
      p_client_request_id: requestId(),
      p_quote_id: quoteId,
      p_expected_status: quoteStatus,
      p_template_id: selected.id,
      p_site_id: siteId,
    });
    const receipt = (Array.isArray(data) ? data[0] : data) as TemplateQuoteReceipt | null;
    if (error || !receipt) onError(error?.message ?? 'The template lines were not confirmed.');
    else {
      await onAdded({ ...receipt, lines_added: Number(receipt.lines_added), lines_needing_price: Number(receipt.lines_needing_price), total_cost: Number(receipt.total_cost), subtotal_charge: Number(receipt.subtotal_charge), total_charge: Number(receipt.total_charge) }, selected);
      setTemplateId('');
    }
    setBusy(false);
  };

  return (
    <div className="bom-template-adder">
      <label className="bom-template-adder__field">
        <span>Add a standard build</span>
        <select value={templateId} onChange={(event) => setTemplateId(event.target.value)} disabled={disabled || busy} aria-describedby="bom-template-adder-hint">
          <option value="">Choose a saved bill of materials…</option>
          {templates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.kind}</option>)}
        </select>
      </label>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void add()} disabled={disabled || busy || !selected}>{busy ? 'Adding…' : 'Add its lines'}</button>
      <small id="bom-template-adder-hint">{selected?.description ?? 'Every material, labour and travel line is copied in at today\u2019s price-book prices. You can still edit or remove any line.'}</small>
      {selected && <div className="bom-template-adder__preview" aria-live="polite">
        <strong>{previewLoading ? 'Checking current prices…' : 'Review before adding'}</strong>
        {!previewLoading && <>{previewLines.length === 0 ? <span>This template has no lines yet.</span> : <><ul>{previewLines.map((line) => {
          const price = priceBook.find((row) => row.item_id === line.item_id)?.unit_price ?? null;
          return <li key={line.id}><span>{Number(line.quantity)} {line.unit_of_measure ?? ''} · {line.description}</span><b>{price === null ? 'Needs a price' : `$${(Number(line.quantity) * Number(price)).toFixed(2)}`}</b></li>;
        })}</ul><p>{previewTotals.unpriced > 0 ? `${previewTotals.unpriced} line${previewTotals.unpriced === 1 ? ' needs' : 's need'} a price before the quote can be sent.` : `Current total: $${previewTotals.charge.toFixed(2)} before GST.`}</p></>}</>}
      </div>}
    </div>
  );
};

export default BomTemplateQuoteAdder;
