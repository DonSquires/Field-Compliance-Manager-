import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, LockKeyhole, Plus, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './CrmInvoiceLineDialog.css';

type Invoice = {
  id: string;
  invoice_number: string;
  currency: string;
  total_amount: number;
};

type InvoiceLine = {
  id: string;
  line_number: number;
  description: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  line_source: 'generated' | 'manual';
  client_request_id: string | null;
};

type Receipt = {
  subtotal: number;
  gst_amount: number;
  total_amount: number;
};

export function CrmInvoiceLineDialog({
  invoice,
  onClose,
  onChanged,
}: {
  invoice: Invoice;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [addRequestId, setAddRequestId] = useState(() => crypto.randomUUID());
  const [removeRequestIds, setRemoveRequestIds] = useState<Record<string, string>>({});
  const [removeCandidate, setRemoveCandidate] = useState<InvoiceLine | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: loadError } = await supabase
      .from('invoice_line_items')
      .select('id,line_number,description,quantity,unit_price,line_total,line_source,client_request_id')
      .eq('invoice_id', invoice.id)
      .order('line_number');
    if (loadError) setError(loadError.message);
    else setLines((data as InvoiceLine[]) ?? []);
    setLoading(false);
  }, [invoice.id]);

  useEffect(() => { void load(); }, [load]);

  const currentSubtotal = useMemo(
    () => lines.reduce((sum, line) => sum + Number(line.line_total), 0),
    [lines],
  );

  const addLine = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsedQuantity = Number(quantity);
    const parsedPrice = Number(unitPrice);
    if (!description.trim() || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0 || !Number.isFinite(parsedPrice) || parsedPrice < 0) {
      setError('Enter a description, positive quantity, and non-negative unit price.');
      return;
    }
    setSaving(true);
    setError(null);
    const { data, error: actionError } = await supabase.rpc('add_crm_invoice_line', {
      p_client_request_id: addRequestId,
      p_invoice_id: invoice.id,
      p_description: description.trim(),
      p_quantity: parsedQuantity,
      p_unit_price: parsedPrice,
    });
    if (actionError) setError(actionError.message);
    else {
      const result = (Array.isArray(data) ? data[0] : data) as Receipt | null;
      setReceipt(result);
      setDescription('');
      setQuantity('1');
      setUnitPrice('');
      setAddRequestId(crypto.randomUUID());
      await Promise.all([load(), onChanged()]);
    }
    setSaving(false);
  };

  const removeLine = async () => {
    if (!removeCandidate) return;
    const requestId = removeRequestIds[removeCandidate.id] ?? crypto.randomUUID();
    setRemoveRequestIds((current) => ({ ...current, [removeCandidate.id]: requestId }));
    setSaving(true);
    setError(null);
    const { data, error: actionError } = await supabase.rpc('remove_crm_invoice_line', {
      p_client_request_id: requestId,
      p_invoice_id: invoice.id,
      p_line_id: removeCandidate.id,
    });
    if (actionError) setError(actionError.message);
    else {
      const result = (Array.isArray(data) ? data[0] : data) as Receipt | null;
      setReceipt(result);
      setRemoveCandidate(null);
      await Promise.all([load(), onChanged()]);
    }
    setSaving(false);
  };

  return <div className="crm-invoice-lines-backdrop">
    <section className="crm-invoice-lines-dialog" role="dialog" aria-modal="true" aria-labelledby="crm-invoice-lines-title">
      <header>
        <div><span>Draft invoice</span><h2 id="crm-invoice-lines-title">Review {invoice.invoice_number}</h2><p>Generated evidence lines stay attached to their source work. Manual adjustments are separately identified and retry-safe.</p></div>
        <button type="button" onClick={onClose} aria-label="Close invoice line review">×</button>
      </header>
      {error && <div className="crm-invoice-lines-message is-error" role="alert"><CircleAlert size={15} />{error}</div>}
      {receipt && <div className="crm-invoice-lines-totals" role="status"><span>Subtotal <strong>{invoice.currency} {Number(receipt.subtotal).toFixed(2)}</strong></span><span>GST <strong>{invoice.currency} {Number(receipt.gst_amount).toFixed(2)}</strong></span><span>Total <strong>{invoice.currency} {Number(receipt.total_amount).toFixed(2)}</strong></span></div>}
      <div className="crm-invoice-lines-register" role="table" aria-label="Draft invoice lines">
        <div className="crm-invoice-lines-row is-header" role="row"><span>Description</span><span>Quantity</span><span>Unit price</span><span>Total</span><span>Source</span><span>Action</span></div>
        {loading ? <div className="crm-invoice-lines-empty">Loading invoice lines...</div> : lines.length === 0 ? <div className="crm-invoice-lines-empty">This draft has no lines. Add a reviewed manual charge before sending it.</div> : lines.map((line) => <div className="crm-invoice-lines-row" role="row" key={line.id}>
          <strong>{line.description}</strong><span>{Number(line.quantity).toFixed(2)}</span><span>{invoice.currency} {Number(line.unit_price).toFixed(2)}</span><span>{invoice.currency} {Number(line.line_total).toFixed(2)}</span>
          <span className={`source-${line.line_source}`}>{line.line_source === 'manual' ? 'Manual adjustment' : 'Operational evidence'}</span>
          <span>{line.line_source === 'manual' && line.client_request_id ? <button type="button" className="crm-invoice-line-remove" onClick={() => setRemoveCandidate(line)} disabled={saving}><Trash2 size={14} />Remove</button> : <span className="crm-invoice-line-locked"><LockKeyhole size={14} />Locked</span>}</span>
        </div>)}
      </div>
      <form className="crm-invoice-line-form" onSubmit={addLine}>
        <div><span>Manual adjustment</span><strong>Add a reviewed draft line</strong><small>Use this only for a charge that is not already represented by completed operational work.</small></div>
        <label><span>Description</span><input maxLength={500} required value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label><span>Quantity</span><input type="number" min="0.01" max="100000" step="0.01" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        <label><span>Unit price</span><input type="number" min="0" max="1000000" step="0.01" required value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} /></label>
        <button type="submit" className="btn btn-secondary" disabled={saving}><Plus size={15} />{saving ? 'Saving...' : 'Add line'}</button>
      </form>
      {removeCandidate && <div className="crm-invoice-line-confirm" role="alertdialog" aria-labelledby="crm-remove-line-title"><div><strong id="crm-remove-line-title">Remove this manual line?</strong><span>{removeCandidate.description} · {invoice.currency} {Number(removeCandidate.line_total).toFixed(2)}</span></div><button type="button" className="btn btn-secondary" onClick={() => setRemoveCandidate(null)} disabled={saving}>Keep line</button><button type="button" className="btn btn-danger" onClick={() => void removeLine()} disabled={saving}>{saving ? 'Removing...' : 'Remove line'}</button></div>}
      <footer><span>{lines.length} line{lines.length === 1 ? '' : 's'} · current subtotal {invoice.currency} {currentSubtotal.toFixed(2)}</span><button type="button" className="btn btn-primary" onClick={onClose}>Done reviewing</button></footer>
    </section>
  </div>;
}
