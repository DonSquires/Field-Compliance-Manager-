/**
 * CompletedWorkToInvoicePanel.tsx — "money sitting in finished work".
 * One row per client with completed, unbilled workshop orders, dispatch
 * callouts, and patrol visits, with one button to create a draft invoice
 * (generate_crm_invoice_from_completed_work). Written for a finance person
 * who does not know what a charge line is.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { describeUninvoiced, groupUninvoicedWork, invoiceBlocker, type ClientUninvoicedSummary, type UninvoicedDispatchRow, type UninvoicedPatrolVisitRow, type UninvoicedWorkshopRow } from '../lib/uninvoicedWork';
import { money } from '../lib/workshop';
import './CompletedWorkToInvoicePanel.css';

interface Props {
  organizationId: string | null;
  onOpenInvoices?: () => void;
}

const requestId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export const CompletedWorkToInvoicePanel: React.FC<Props> = ({ organizationId, onOpenInvoices }) => {
  const [rows, setRows] = useState<ClientUninvoicedSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyClient, setBusyClient] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) { setRows([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    // ATLAS READS: workshop_work_order_summary (completed, still to invoice), dispatch_job_charge_lines (no invoice line yet)
    const [workshopRes, dispatchRes, patrolRes] = await Promise.all([
      supabase.from('workshop_work_order_summary').select('client_organization_id,client_name,order_number,uninvoiced_total,completed_at').eq('organization_id', organizationId).eq('status', 'completed').gt('uninvoiced_total', 0).limit(500),
      supabase.from('dispatch_job_charge_lines').select('client_organization_id,source_dispatch_id,line_total,created_at,billing_basis,client:client_organization_id(name)').eq('organization_id', organizationId).is('invoice_line_item_id', null).or('billing_basis.is.null,billing_basis.eq.extra').limit(1000),
      supabase.from('patrol_stop_charge_lines').select('client_organization_id,shift_stop_id,line_total,created_at,client:client_organization_id(name)').eq('organization_id', organizationId).eq('status', 'ready').is('invoice_line_item_id', null).limit(1000),
    ]);
    if (workshopRes.error || dispatchRes.error || patrolRes.error) {
      setError(workshopRes.error?.message ?? dispatchRes.error?.message ?? patrolRes.error?.message ?? 'Completed work could not be loaded.');
      setLoading(false);
      return;
    }
    const dispatchRows: UninvoicedDispatchRow[] = ((dispatchRes.data as Array<Record<string, unknown>>) ?? []).map((row) => {
      const client = row.client as { name: string } | { name: string }[] | null;
      return {
        client_organization_id: (row.client_organization_id as string | null) ?? null,
        client_name: (Array.isArray(client) ? client[0]?.name : client?.name) ?? null,
        source_dispatch_id: String(row.source_dispatch_id),
        line_total: Number(row.line_total ?? 0),
        created_at: String(row.created_at),
        billing_basis: row.billing_basis === 'extra' || row.billing_basis === 'contract' ? row.billing_basis : null,
      };
    });
    const patrolRows: UninvoicedPatrolVisitRow[] = ((patrolRes.data as Array<Record<string, unknown>>) ?? []).map((row) => {
      const client = row.client as { name: string } | { name: string }[] | null;
      return {
        client_organization_id: (row.client_organization_id as string | null) ?? null,
        client_name: (Array.isArray(client) ? client[0]?.name : client?.name) ?? null,
        shift_stop_id: String(row.shift_stop_id),
        line_total: Number(row.line_total ?? 0),
        created_at: String(row.created_at),
      };
    });
    setRows(groupUninvoicedWork((workshopRes.data as UninvoicedWorkshopRow[]) ?? [], dispatchRows, patrolRows));
    setLoading(false);
  }, [organizationId]);

  useEffect(() => { void load(); }, [load]);

  const invoice = async (entry: ClientUninvoicedSummary) => {
    if (!organizationId) return;
    setBusyClient(entry.clientId);
    setError(null);
    setNotice(null);
    // ATLAS CALLS: generate_crm_invoice_from_completed_work (idempotent, audited; stamps every source line)
    const { data, error: rpcError } = await supabase.rpc('generate_crm_invoice_from_completed_work', {
      p_client_request_id: requestId(),
      p_organization_id: organizationId,
      p_client_organization_id: entry.clientId,
      p_service_agreement_id: null,
      p_period_start: null,
      p_period_end: null,
    });
    if (rpcError) {
      setError(rpcError.message);
    } else {
      const created = data as { invoice_number?: string; total_amount?: number } | null;
      setNotice(`Draft invoice ${created?.invoice_number ?? ''} for ${entry.clientName} — ${money(created?.total_amount ?? null)} including GST. It is a draft: check it, then send it.`);
      await load();
    }
    setBusyClient(null);
  };

  const total = rows.reduce((sum, row) => sum + row.total, 0);

  return (
    <section className="completed-work" aria-labelledby="completed-work-title">
      <header className="completed-work__header">
        <div>
          <p className="finance-owner-eyebrow">Finished work, not yet billed</p>
          <h2 id="completed-work-title">{loading ? 'Checking finished work…' : rows.length === 0 ? 'Everything finished has been billed' : total > 0 ? `${money(total)} waiting to be invoiced` : 'Callouts need billing set before invoicing'}</h2>
          <p className="subtitle">Completed workshop jobs, Extra callouts, and priced patrol visits turn into a draft invoice per client. Contracted callouts are covered by the agreement price and are not billed again. Nothing is sent until you review it.</p>
        </div>
        {onOpenInvoices && <button type="button" className="btn btn-secondary" onClick={onOpenInvoices}>Open invoices</button>}
      </header>

      {error && <div className="alert alert-error" role="alert"><button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">×</button>{error}</div>}
      {notice && <p className="completed-work__notice" role="status">{notice}</p>}

      {!loading && rows.length > 0 && (
        <ul className="completed-work__list">
          {rows.map((entry) => {
            const blocker = invoiceBlocker(entry);
            const blockerId = `completed-work-blocker-${entry.clientId}`;
            return (
              <li key={entry.clientId} className="completed-work__row">
                <div>
                  <strong>{entry.clientName}</strong>
                  <span>{describeUninvoiced(entry)}</span>
                  {blocker && <span id={blockerId} className="completed-work__blocker">{blocker}</span>}
                </div>
                <div className="completed-work__amount">{money(entry.total)}<small>before GST</small></div>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => invoice(entry)} disabled={busyClient !== null || blocker !== null} aria-describedby={blocker ? blockerId : undefined}>
                  {busyClient === entry.clientId ? 'Creating…' : blocker ? 'Set billing first' : 'Create draft invoice'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default CompletedWorkToInvoicePanel;
