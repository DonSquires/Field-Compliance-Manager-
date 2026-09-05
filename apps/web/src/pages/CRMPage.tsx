/**
 * CRMPage.tsx
 *
 * Canonical spine: organizations (hierarchy) + service_agreements (contracts).
 * There is no standalone "contact rolodex" entity — accounts ARE organizations,
 * grouped by organization_type and parent_organization_id. crm_contacts are
 * people attached to an organization, not accounts themselves.
 *
 * Sections mirror the live production screen:
 *  - Your Organisation (own org + child counts)
 *  - Our Clients        (organizations.organization_type = 'client', parent = own org)
 *  - Branches           (organizations.organization_type = 'branch', parent = own org)
 *  - Platform Subscribers (service_agreements.agreement_type = 'financial', provider = own org)
 *  - Organizations We Contract With (service_agreements.agreement_type = 'operational',
 *    counterpart not part of the branch hierarchy)
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { readWorkflowContext, type NavigateWithContext } from '../lib/workflowNavigation';
import { CrmAccountWorkspace, type CrmWorkspaceAccount } from '../components/CrmAccountWorkspace';
import { CrmOrganizationDialog, type EditableCrmOrganization } from '../components/CrmOrganizationDialog';
import { CrmSiteDialog } from '../components/CrmSiteDialog';
import './PageStyles.css';
import './CRMPage.css';

interface Organization {
  id: string;
  name: string;
  organization_type: string;
  parent_organization_id: string | null;
  active: boolean;
}

interface ServiceAgreement {
  id: string;
  provider_organization_id: string;
  client_organization_id: string;
  name: string;
  agreement_type: string;
  invitation_status: string;
}

interface AccountRow {
  id: string;
  name: string;
  organization_type: string;
  active: boolean;
  status: string;
  updated_at: string;
  nzbn: string | null;
  company_registration_number: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  billing_email: string | null;
  billing_address: string | null;
  account_notes: string | null;
  site_count: number;
  primary_contact_name: string | null;
  latest_quote_status: string | null;
  sites: Array<{ id: string; name: string }>;
  blockers: string[];
  next_action: string;
}

interface PricingQuote {
  id: string;
  title: string;
  status: string;
  client: AccountRow;
}

interface AgreementRow extends ServiceAgreement {
  counterparty_name: string;
  counterparty_type: string;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'void';
  total_amount: number;
  currency: string;
  client: { name: string } | null;
}

interface InvoiceReadiness {
  accountName: string;
  agreementName: string;
  source: 'accepted_quote' | 'commercial_rate' | 'missing';
  detail: string;
  billingCycle: string | null;
  paymentTermsDays: number | null;
}

interface CrmState {
  ownOrg: Organization | null;
  clients: AccountRow[];
  branches: AccountRow[];
  platformSubscribers: AgreementRow[];
  contractedOrgs: AgreementRow[];
  invoices: InvoiceRow[];
  loading: boolean;
  error: string | null;
}

const CRMPage: React.FC<{ onNavigate?: NavigateWithContext }> = ({ onNavigate = () => undefined }) => {
  const location = useLocation();
  const requestedAccountId = readWorkflowContext(location.search).accountId;
  const { profile } = useAuth();
  const [state, setState] = useState<CrmState>({
    ownOrg: null,
    clients: [],
    branches: [],
    platformSubscribers: [],
    contractedOrgs: [],
    invoices: [],
    loading: true,
    error: null,
  });
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const [quoteClient, setQuoteClient] = useState<AccountRow | null>(null);
  const [quoteForm, setQuoteForm] = useState({
    title: '',
    targetMargin: '20',
    validUntil: '',
    notes: '',
  });
  const [quoteSaving, setQuoteSaving] = useState(false);
  const [pricingQuote, setPricingQuote] = useState<PricingQuote | null>(null);
  const [lineForm, setLineForm] = useState({
    kind: 'labour',
    description: 'Service labour',
    quantity: '1',
    unitCost: '',
    unitCharge: '',
    moduleKey: '',
    siteId: '',
  });
  const [pricingReceipt, setPricingReceipt] = useState<{
    totalCost: number;
    totalCharge: number;
  } | null>(null);
  const [quoteAction, setQuoteAction] = useState<'send' | 'accept' | 'decline' | null>(null);
  const [quoteActionReason, setQuoteActionReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [quoteAcceptance, setQuoteAcceptance] = useState<{ quoteTitle: string; accountId: string; accountName: string; agreementId: string } | null>(null);
  const [workspaceAccount, setWorkspaceAccount] = useState<CrmWorkspaceAccount | null>(null);
  const [invoiceAction, setInvoiceAction] = useState<{ invoice: InvoiceRow; action: 'send' | 'mark_paid' | 'void' } | null>(null);
  const [invoiceReason, setInvoiceReason] = useState('');
  const [showGenerateInvoice, setShowGenerateInvoice] = useState(false);
  const [invoiceReadiness, setInvoiceReadiness] = useState<InvoiceReadiness | null>(null);
  const [invoiceReadinessLoading, setInvoiceReadinessLoading] = useState(false);
  const [selectedAgreementId, setSelectedAgreementId] = useState('');
  const [quoteLines, setQuoteLines] = useState<Array<{ id: string; kind: string; description: string; quantity: number; unit_cost: number; unit_charge: number }>>([]);
  const [organizationDialog, setOrganizationDialog] = useState<EditableCrmOrganization | 'create' | null>(null);
  const [siteAccount, setSiteAccount] = useState<{ id: string; name: string } | null>(null);
  const openedContextAccountId = useRef<string | null>(null);
  const quoteRequestId = useRef(crypto.randomUUID());
  const lineRequestId = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!requestedAccountId) {
      openedContextAccountId.current = null;
      return;
    }
    const requestedAccount = [...state.clients, ...state.branches].find((account) => account.id === requestedAccountId);
    if (!requestedAccount || openedContextAccountId.current === requestedAccountId) return;
    openedContextAccountId.current = requestedAccountId;
    setWorkspaceAccount({ id: requestedAccount.id, name: requestedAccount.name, status: requestedAccount.status, primaryContactName: requestedAccount.primary_contact_name, siteCount: requestedAccount.site_count, readinessBlockers: requestedAccount.blockers, nextAction: requestedAccount.next_action, latestQuoteStatus: requestedAccount.latest_quote_status });
    document.getElementById(`crm-account-${requestedAccountId}`)?.scrollIntoView({ block: 'center' });
  }, [requestedAccountId, state.branches, state.clients]);

  // ATLAS READS: organizations, crm_account_list (view), service_agreements
  const loadCrm = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;

    try {
      setState((s) => ({ ...s, loading: true, error: null }));

      const { data: ownOrg, error: ownErr } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', orgId)
        .single();
      if (ownErr) throw ownErr;

      // SCHEMA FIX: crm_account_list view does not exist.
      // Query organizations directly; site_count loaded separately.
      const { data: accounts, error: acctErr } = await supabase
        .from('organizations')
        .select('id,name,organization_type,active,status,parent_organization_id,updated_at,nzbn,company_registration_number,contact_email,contact_phone,billing_email,billing_address,account_notes')
        .eq('parent_organization_id', orgId);
      if (acctErr) throw acctErr;

      const accountIds = (accounts ?? []).map((account) => account.id);
      const [sitesRes, contactsRes, quotesRes, readinessRes] = accountIds.length
        ? await Promise.all([
            supabase
              .from('client_sites')
              .select('id,name,client_organization_id')
              .in('client_organization_id', accountIds),
            supabase
              .from('crm_contacts')
              .select('organization_id,first_name,last_name,is_primary')
              .in('organization_id', accountIds)
              .eq('is_primary', true),
            supabase
              .from('quotes')
              .select('client_org_id,status,created_at')
              .eq('provider_org_id', orgId)
              .in('client_org_id', accountIds)
              .order('created_at', { ascending: false }),
            supabase.rpc('get_crm_organization_readiness', { p_organization_ids: accountIds }),
          ])
        : [
            { data: [], error: null },
            { data: [], error: null },
            { data: [], error: null },
            { data: [], error: null },
          ];
      if (sitesRes.error) throw sitesRes.error;
      if (contactsRes.error) throw contactsRes.error;
      if (quotesRes.error) throw quotesRes.error;
      if (readinessRes.error) throw readinessRes.error;
      const readiness = new Map(((readinessRes.data as Array<{ organization_id: string; blockers: string[]; next_action: string }>) ?? []).map((row) => [row.organization_id, row]));
      const siteCounts = new Map<string, number>();
      for (const site of sitesRes.data ?? [])
        siteCounts.set(
          site.client_organization_id,
          (siteCounts.get(site.client_organization_id) ?? 0) + 1,
        );
      const primaryContacts = new Map(
        (contactsRes.data ?? []).map((contact) => [
          contact.organization_id,
          `${contact.first_name} ${contact.last_name}`.trim(),
        ]),
      );
      const latestQuotes = new Map<string, string>();
      for (const quote of quotesRes.data ?? [])
        if (quote.client_org_id && !latestQuotes.has(quote.client_org_id))
          latestQuotes.set(quote.client_org_id, quote.status);
      const accountsWithCounts: AccountRow[] = (accounts ?? []).map((acct) => ({
        ...acct,
        id: acct.id,
        name: acct.name,
        organization_type: acct.organization_type,
        active: acct.active,
        site_count: siteCounts.get(acct.id) ?? 0,
        primary_contact_name: primaryContacts.get(acct.id) ?? null,
        latest_quote_status: latestQuotes.get(acct.id) ?? null,
        sites: (sitesRes.data ?? [])
          .filter((site) => site.client_organization_id === acct.id)
          .map((site) => ({ id: site.id, name: site.name })),
        blockers: readiness.get(acct.id)?.blockers ?? [],
        next_action: readiness.get(acct.id)?.next_action ?? 'Review account readiness',
      }));

      const rows = accountsWithCounts;
      const clients = rows.filter((r) => r.organization_type === 'client');
      const branches = rows.filter((r) => r.organization_type === 'branch');

      // Platform subscribers: Layer-1 financial agreements where we are the provider
      const { data: subscriberAgreements, error: subErr } = await supabase
        .from('service_agreements')
        .select('*, client:client_organization_id(id, name, organization_type)')
        .eq('provider_organization_id', orgId)
        .eq('agreement_type', 'financial');
      if (subErr) throw subErr;

      // Contracted orgs: Layer-2 operational agreements, either direction
      const { data: operationalAgreements, error: opErr } = await supabase
        .from('service_agreements')
        .select(
          '*, client:client_organization_id(id, name, organization_type), provider:provider_organization_id(id, name, organization_type)',
        )
        .or(
          `client_organization_id.eq.${orgId},provider_organization_id.eq.${orgId}`,
        )
        .eq('agreement_type', 'operational');
      if (opErr) throw opErr;
      const { data: invoices, error: invoiceErr } = await supabase.from('invoices').select('id,invoice_number,invoice_date,due_date,status,total_amount,currency,client:client_organization_id(name)').eq('organization_id', orgId).order('due_date', { ascending: true }).limit(100);
      if (invoiceErr) throw invoiceErr;

      const branchOrgIds = new Set(branches.map((b) => b.id));

      const platformSubscribers: AgreementRow[] = (
        subscriberAgreements ?? []
      ).map((a: any) => ({
        ...a,
        counterparty_name: a.client?.name ?? 'Unknown organisation',
        counterparty_type: a.client?.organization_type ?? 'unknown',
      }));

      const contractedOrgs: AgreementRow[] = (operationalAgreements ?? [])
        .filter((a: any) => {
          const counterpartId =
            a.provider_organization_id === orgId
              ? a.client_organization_id
              : a.provider_organization_id;
          return !branchOrgIds.has(counterpartId);
        })
        .map((a: any) => {
          const isProvider = a.provider_organization_id === orgId;
          const counterparty = isProvider ? a.client : a.provider;
          return {
            ...a,
            counterparty_name: counterparty?.name ?? 'Unknown organisation',
            counterparty_type: counterparty?.organization_type ?? 'unknown',
          };
        });

      setState({
        ownOrg: ownOrg as Organization,
        clients,
        branches,
        platformSubscribers,
        contractedOrgs,
        invoices: (invoices as unknown as InvoiceRow[]) ?? [],
        loading: false,
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to load CRM data',
        loading: false,
      }));
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadCrm();
  }, [loadCrm]);

  const loadQuoteLines = useCallback(async (quoteId: string) => {
    const { data } = await supabase.from('quote_lines').select('id,kind,description,quantity,unit_cost,unit_charge').eq('quote_id', quoteId).order('created_at', { ascending: true });
    setQuoteLines((data as any) ?? []);
  }, []);

  useEffect(() => {
    if (pricingQuote) void loadQuoteLines(pricingQuote.id);
    else setQuoteLines([]);
  }, [pricingQuote, loadQuoteLines]);

  const removeQuoteLine = async (lineId: string) => {
    if (!pricingQuote) return;
    setQuoteSaving(true);
    const { data, error } = await supabase.rpc('remove_crm_quote_line', {
      p_client_request_id: crypto.randomUUID(),
      p_quote_id: pricingQuote.id,
      p_line_id: lineId,
      p_expected_status: pricingQuote.status,
    });
    if (error) setState((s) => ({ ...s, error: error.message }));
    else {
      const receipt = Array.isArray(data) ? data[0] : data;
      if (receipt) {
        setPricingReceipt({ totalCost: Number(receipt.total_cost), totalCharge: Number(receipt.total_charge) });
      }
      setNotice('Quote line removed.');
      await loadQuoteLines(pricingQuote.id);
    }
    setQuoteSaving(false);
  };

  const generateInvoiceFromAgreement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgreementId || invoiceReadiness?.source === 'missing') return;
    setQuoteSaving(true);
    const now = new Date();
    const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const { error } = await supabase.rpc('generate_crm_invoice_from_agreement', {
      p_client_request_id: crypto.randomUUID(),
      p_service_agreement_id: selectedAgreementId,
      p_service_period_start: startDate,
      p_service_period_end: endDate,
    });
    if (error) setState((s) => ({ ...s, error: s.error ? `${s.error} · ${error.message}` : error.message }));
    else {
      setNotice('Invoice generated from agreement with line items.');
      setShowGenerateInvoice(false);
      await loadCrm();
    }
    setQuoteSaving(false);
  };

  const loadInvoiceReadiness = useCallback(async (agreementId: string) => {
    const agreement = [...state.platformSubscribers, ...state.contractedOrgs].find((item) => item.id === agreementId);
    if (!agreement) { setInvoiceReadiness(null); return; }
    setInvoiceReadinessLoading(true); setInvoiceReadiness(null);
    const [quotesResponse, settingsResponse] = await Promise.all([
      supabase.from('quotes').select('id,quote_lines(id)').eq('service_agreement_id', agreementId).eq('status', 'accepted'),
      supabase.from('crm_commercial_settings').select('base_rate_per_hour,billing_cycle,payment_terms_days').eq('service_agreement_id', agreementId).maybeSingle(),
    ]);
    if (quotesResponse.error || settingsResponse.error) {
      setState((current) => ({ ...current, error: quotesResponse.error?.message ?? settingsResponse.error?.message ?? 'Invoice readiness could not be loaded.' }));
    } else {
      const quoteLineCount = ((quotesResponse.data as Array<{ quote_lines: Array<{ id: string }> | null }> | null) ?? []).reduce((count, quote) => count + (quote.quote_lines?.length ?? 0), 0);
      const settings = settingsResponse.data as { base_rate_per_hour: number | null; billing_cycle: string; payment_terms_days: number } | null;
      setInvoiceReadiness({
        accountName: agreement.counterparty_name,
        agreementName: agreement.name,
        source: quoteLineCount > 0 ? 'accepted_quote' : settings?.base_rate_per_hour != null ? 'commercial_rate' : 'missing',
        detail: quoteLineCount > 0 ? `${quoteLineCount} accepted quote line${quoteLineCount === 1 ? '' : 's'} will be copied.` : settings?.base_rate_per_hour != null ? `Monthly commercial rate: NZ$${Number(settings.base_rate_per_hour).toFixed(2)}.` : 'No accepted quote lines or commercial base rate are configured.',
        billingCycle: settings?.billing_cycle ?? null,
        paymentTermsDays: settings?.payment_terms_days ?? null,
      });
    }
    setInvoiceReadinessLoading(false);
  }, [state.contractedOrgs, state.platformSubscribers]);

  useEffect(() => {
    if (!showGenerateInvoice || !selectedAgreementId) { setInvoiceReadiness(null); return; }
    void loadInvoiceReadiness(selectedAgreementId);
  }, [loadInvoiceReadiness, selectedAgreementId, showGenerateInvoice]);

  const openQuote = (client: AccountRow) => {
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 30);
    quoteRequestId.current = crypto.randomUUID();
    setQuoteClient(client);
    setQuoteForm({
      title: `${client.name} service proposal`,
      targetMargin: '20',
      validUntil: validUntil.toISOString().slice(0, 10),
      notes: '',
    });
    setNotice(null);
  };

  const createQuote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!quoteClient) return;
    setQuoteSaving(true);
    setState((current) => ({ ...current, error: null }));
    const { data, error } = await supabase.rpc('create_crm_draft_quote', {
      p_client_request_id: quoteRequestId.current,
      p_client_org_id: quoteClient.id,
      p_title: quoteForm.title.trim(),
      p_target_margin_pct: Number(quoteForm.targetMargin),
      p_valid_until: quoteForm.validUntil || null,
      p_notes: quoteForm.notes.trim() || null,
    });
    if (error || !data)
      setState((current) => ({
        ...current,
        error: error?.message ?? 'Draft quote receipt was not confirmed.',
      }));
    else {
      const quote = data as { id: string; title: string; status: string };
      setNotice(
        `Draft quote created for ${quoteClient.name}. Add explicit pricing lines before review.`,
      );
      setPricingQuote({ ...quote, client: quoteClient });
      setLineForm({
        kind: 'labour',
        description: 'Service labour',
        quantity: '1',
        unitCost: '',
        unitCharge: '',
        moduleKey: '',
        siteId: quoteClient.sites[0]?.id ?? '',
      });
      setPricingReceipt(null);
      setQuoteClient(null);
      lineRequestId.current = crypto.randomUUID();
      quoteRequestId.current = crypto.randomUUID();
      await loadCrm();
    }
    setQuoteSaving(false);
  };

  const addQuoteLine = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pricingQuote) return;
    setQuoteSaving(true);
    setState((current) => ({ ...current, error: null }));
    const { data, error } = await supabase.rpc('add_crm_quote_line', {
      p_client_request_id: lineRequestId.current,
      p_quote_id: pricingQuote.id,
      p_expected_status: pricingQuote.status,
      p_kind: lineForm.kind,
      p_description: lineForm.description.trim(),
      p_quantity: Number(lineForm.quantity),
      p_unit_cost: Number(lineForm.unitCost),
      p_unit_charge: Number(lineForm.unitCharge),
      p_module_key:
        lineForm.kind === 'module' ? lineForm.moduleKey.trim() : null,
      p_site_id: lineForm.siteId || null,
    });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (error || !receipt)
      setState((current) => ({
        ...current,
        error: error?.message ?? 'Quote line receipt was not confirmed.',
      }));
    else {
      setPricingReceipt({
        totalCost: Number(receipt.total_cost),
        totalCharge: Number(receipt.total_charge),
      });
      setNotice(`Pricing line added to ${pricingQuote.title}.`);
      lineRequestId.current = crypto.randomUUID();
      await loadQuoteLines(pricingQuote.id);
      await loadCrm();
    }
    setQuoteSaving(false);
  };

  const manageQuote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pricingQuote || !quoteAction) return;
    setQuoteSaving(true);
    setState((current) => ({ ...current, error: null }));
    const { data, error } = await supabase.rpc('manage_crm_quote', {
      p_quote_id: pricingQuote.id,
      p_expected_status: pricingQuote.status,
      p_action: quoteAction,
      p_reason: quoteAction === 'decline' ? quoteActionReason.trim() : null,
    });
    const receipt = Array.isArray(data) ? data[0] : data;
    const agreementId = receipt?.service_agreement_id ? String(receipt.service_agreement_id) : null;
    if (error || !receipt || (quoteAction === 'accept' && !agreementId)) {
      setState((current) => ({ ...current, error: error?.message ?? 'Quote lifecycle receipt was not confirmed.' }));
    } else {
      const nextStatus = String(receipt.quote_status);
      setNotice(quoteAction === 'send' ? `${pricingQuote.title} sent for acceptance.` : quoteAction === 'accept' ? null : `${pricingQuote.title} declined with reason retained.`);
      if (quoteAction === 'accept' && agreementId) setQuoteAcceptance({ quoteTitle: pricingQuote.title, accountId: pricingQuote.client.id, accountName: pricingQuote.client.name, agreementId });
      if (quoteAction === 'send') setPricingQuote({ ...pricingQuote, status: nextStatus }); else setPricingQuote(null);
      setQuoteAction(null);
      setQuoteActionReason('');
      await loadCrm();
    }
    setQuoteSaving(false);
  };

  const manageInvoice = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!invoiceAction) return;
    setQuoteSaving(true); setState((current) => ({ ...current, error: null }));
    const { data, error } = await supabase.rpc('manage_crm_invoice', { p_invoice_id: invoiceAction.invoice.id, p_expected_status: invoiceAction.invoice.status, p_action: invoiceAction.action, p_reason: invoiceAction.action === 'void' ? invoiceReason.trim() : null });
    if (error || !data) setState((current) => ({ ...current, error: error?.message ?? 'Invoice lifecycle receipt was not confirmed.' }));
    else { setNotice(invoiceAction.action === 'send' ? `${invoiceAction.invoice.invoice_number} sent to accounts receivable.` : invoiceAction.action === 'mark_paid' ? `${invoiceAction.invoice.invoice_number} marked paid.` : `${invoiceAction.invoice.invoice_number} voided with its reason retained.`); setInvoiceAction(null); setInvoiceReason(''); await loadCrm(); }
    setQuoteSaving(false);
  };

  const pricingDialog = pricingQuote ? (
    <div className="crm-quote-backdrop">
      <form
        className="crm-quote-dialog crm-line-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="crm-line-title"
        onSubmit={addQuoteLine}
      >
        <header>
          <div>
            <span>Quote pricing</span>
            <h2 id="crm-line-title">Price {pricingQuote.title}</h2>
          </div>
          <button
            type="button"
            onClick={() => setPricingQuote(null)}
            aria-label="Close pricing"
          >
            ×
          </button>
        </header>
        <p>
          Provider cost and client charge remain distinct. Totals, discount,
          GST, and final charge are recalculated by the server.
        </p>
        {pricingReceipt && (
          <div className="crm-pricing-receipt">
            <span>
              Total cost <strong>${pricingReceipt.totalCost.toFixed(2)}</strong>
            </span>
            <span>
              Total charge{' '}
              <strong>${pricingReceipt.totalCharge.toFixed(2)}</strong>
            </span>
          </div>
        )}
        {quoteLines.length > 0 && (
          <div className="crm-quote-lines-list" style={{ marginBottom: '1rem', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '6px', padding: '0.5rem' }}>
            <strong style={{ fontSize: '0.85rem', display: 'block', marginBottom: '0.5rem' }}>Existing quote lines ({quoteLines.length}):</strong>
            {quoteLines.map((line) => (
              <div key={line.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem', padding: '0.25rem 0', borderBottom: '1px border-subtle' }}>
                <span><strong>[{line.kind}]</strong> {line.description} — {line.quantity} × ${Number(line.unit_charge).toFixed(2)}</span>
                {pricingQuote.status === 'draft' && (
                  <button type="button" className="btn btn-sm btn-secondary" style={{ color: 'var(--danger-color, #e53e3e)', padding: '0.1rem 0.4rem', fontSize: '0.75rem' }} disabled={quoteSaving} onClick={() => void removeQuoteLine(line.id)}>Remove</button>
                )}
              </div>
            ))}
          </div>
        )}
        <div>
          <label>
            <span>Line kind</span>
            <select
              value={lineForm.kind}
              onChange={(event) =>
                setLineForm({ ...lineForm, kind: event.target.value })
              }
            >
              <option value="labour">Labour</option>
              <option value="travel">Travel</option>
              <option value="overhead">Overhead</option>
              <option value="module">Module</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>
            <span>Client site</span>
            <select
              value={lineForm.siteId}
              onChange={(event) =>
                setLineForm({ ...lineForm, siteId: event.target.value })
              }
            >
              <option value="">No site</option>
              {pricingQuote.client.sites.map((site) => (
                <option value={site.id} key={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          <span>Description</span>
          <input
            required
            value={lineForm.description}
            onChange={(event) =>
              setLineForm({ ...lineForm, description: event.target.value })
            }
          />
        </label>
        {lineForm.kind === 'module' && (
          <label>
            <span>Module key</span>
            <input
              required
              value={lineForm.moduleKey}
              onChange={(event) =>
                setLineForm({ ...lineForm, moduleKey: event.target.value })
              }
            />
          </label>
        )}
        <div>
          <label>
            <span>Quantity</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              required
              value={lineForm.quantity}
              onChange={(event) =>
                setLineForm({ ...lineForm, quantity: event.target.value })
              }
            />
          </label>
          <label>
            <span>Provider unit cost</span>
            <input
              type="number"
              min="0"
              step="0.01"
              required
              value={lineForm.unitCost}
              onChange={(event) =>
                setLineForm({ ...lineForm, unitCost: event.target.value })
              }
            />
          </label>
        </div>
        <label>
          <span>Client unit charge</span>
          <input
            type="number"
            min="0"
            step="0.01"
            required
            value={lineForm.unitCharge}
            onChange={(event) =>
              setLineForm({ ...lineForm, unitCharge: event.target.value })
            }
          />
        </label>
        <footer>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setPricingQuote(null)}
          >
            Done
          </button>
          {pricingQuote.status === 'draft' && <button
              type="submit"
              className="btn btn-primary"
              disabled={
                quoteSaving ||
                !lineForm.description.trim() ||
                !lineForm.unitCost ||
                !lineForm.unitCharge ||
                (lineForm.kind === 'module' && !lineForm.moduleKey.trim())
              }
            >
              {quoteSaving ? 'Adding' : 'Add pricing line'}
            </button>}
        </footer>
        {pricingQuote.status === 'draft' && pricingReceipt && <button type="button" className="btn btn-primary crm-quote-lifecycle" onClick={() => setQuoteAction('send')}>Send quote</button>}
        {pricingQuote.status === 'sent' && <div className="crm-quote-lifecycle-actions"><button type="button" className="btn btn-secondary" onClick={() => { setQuoteActionReason(''); setQuoteAction('decline'); }}>Decline</button><button type="button" className="btn btn-primary" onClick={() => setQuoteAction('accept')}>Accept quote</button></div>}
      </form>
    </div>
  ) : null;

  if (state.loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading CRM accounts...</p>
        </div>
      </div>
    );
  }

  const totalAccounts = state.clients.length + state.branches.length;
  const openReceivables = state.invoices.filter((invoice) => invoice.status === 'sent' || invoice.status === 'overdue');
  const receivableTotal = openReceivables.reduce((sum, invoice) => sum + Number(invoice.total_amount), 0);

  return (
    <div className="page-container crm-page">
      <header className="page-header">
        <div><h1>CRM &amp; Finance</h1><p className="subtitle">{totalAccounts} accounts · Client and service provider management</p></div>
        <button type="button" className="btn btn-primary" onClick={() => setOrganizationDialog('create')}>Add organization</button>
      </header>

      {state.error && (
        <div className="alert alert-error" role="alert">
          <button
            className="alert-close"
            onClick={() => setState((s) => ({ ...s, error: null }))}
            aria-label="Close alert"
          >
            ×
          </button>
          {state.error}
        </div>
      )}
      {notice && (
        <div className="alert alert-success" role="status">
          {notice}
        </div>
      )}
      {quoteAcceptance && (
        <section className="crm-quote-acceptance" aria-label="Quote acceptance receipt">
          <div>
            <span>Quote accepted</span>
            <strong>{quoteAcceptance.quoteTitle}</strong>
            <p>Service agreement {quoteAcceptance.agreementId.slice(0, 8)} established for {quoteAcceptance.accountName}.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => onNavigate('relationships', { accountId: quoteAcceptance.accountId, agreementId: quoteAcceptance.agreementId })}>Open service agreement</button>
        </section>
      )}

      <div className="crm-branch-filter">
        <label>Branch</label>
        <select
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
        >
          <option value="all">All branches</option>
          {state.branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      {state.ownOrg && (
        <section className="reports-section">
          <h2>{state.ownOrg.name}</h2>
          <p className="subtitle">
            {state.clients.length} clients · 0 contractors ·{' '}
            {state.branches.length} branches
          </p>
        </section>
      )}

      <section className="reports-section crm-finance-section">
        <div className="crm-section-heading"><div><h2>Accounts receivable</h2><p className="subtitle">Invoice status, collection actions, and retained finance decisions.</p></div><div className="crm-finance-kpis"><span>Open <strong>{openReceivables.length}</strong></span><span>Receivable <strong>NZ${receivableTotal.toFixed(2)}</strong></span><span>Overdue <strong>{state.invoices.filter((invoice) => invoice.status === 'overdue').length}</strong></span><button type="button" className="btn btn-sm btn-secondary" onClick={() => setShowGenerateInvoice(true)}>Generate from agreement</button></div></div>
        {state.invoices.length === 0 ? <div className="empty-state"><p>No invoice headers exist yet. Invoice generation remains blocked until line-level billing evidence is implemented.</p></div> : <div className="crm-invoice-table" role="table" aria-label="Accounts receivable"><div className="crm-invoice-row is-header" role="row"><span>Invoice</span><span>Account</span><span>Due</span><span>Total</span><span>Status</span><span>Action</span></div>{state.invoices.map((invoice) => <div className="crm-invoice-row" role="row" key={invoice.id}><strong>{invoice.invoice_number}</strong><span>{invoice.client?.name ?? 'Unknown account'}</span><time dateTime={invoice.due_date}>{new Date(`${invoice.due_date}T00:00:00`).toLocaleDateString('en-NZ')}</time><span>{invoice.currency} {Number(invoice.total_amount).toFixed(2)}</span><span className={`crm-invoice-status status-${invoice.status}`}>{invoice.status}</span><div>{invoice.status === 'draft' && <button type="button" onClick={() => setInvoiceAction({ invoice, action: 'send' })}>Send</button>}{(invoice.status === 'sent' || invoice.status === 'overdue') && <button type="button" onClick={() => setInvoiceAction({ invoice, action: 'mark_paid' })}>Mark paid</button>}{!['paid','void'].includes(invoice.status) && <button type="button" onClick={() => { setInvoiceReason(''); setInvoiceAction({ invoice, action: 'void' }); }}>Void</button>}</div></div>)}</div>}
      </section>

      <section className="reports-section">
        <h2>Our Clients ({state.clients.length})</h2>
        <div className="crm-account-register" role="table" aria-label="Client accounts">
          {state.clients.length === 0 ? (
            <div className="empty-state">
              <p>No client accounts yet.</p>
            </div>
          ) : (
            <>
              <div className="crm-account-register-row is-header" role="row"><span>Client</span><span>Primary contact</span><span>Sites</span><span>Readiness</span><span>Quote</span><span>Next action</span></div>
              {state.clients.map((client) => (
                <button id={`crm-account-${client.id}`} type="button" role="row" key={client.id} className={`crm-account-register-row ${client.id === requestedAccountId ? 'is-context-focus' : ''}`} onClick={() => setWorkspaceAccount({ id: client.id, name: client.name, status: client.status, primaryContactName: client.primary_contact_name, siteCount: client.site_count, readinessBlockers: client.blockers, nextAction: client.next_action, latestQuoteStatus: client.latest_quote_status })}>
                  <strong>{client.name}</strong><span>{client.primary_contact_name ?? 'Not assigned'}</span><span>{client.site_count}</span><span className={client.blockers.length ? 'is-attention' : 'is-ready'}>{client.blockers.length ? `${client.blockers.length} open` : 'Ready'}</span><span>{client.latest_quote_status ?? 'None'}</span><span>{client.next_action}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </section>

      <section className="reports-section">
        <h2>Branches ({state.branches.length})</h2>
        <div className="contacts-list">
          {state.branches.length === 0 ? (
            <div className="empty-state">
              <p>No branch accounts yet.</p>
            </div>
          ) : (
            state.branches.map((branch) => (
              <div key={branch.id} className="contact-card">
                <div className="contact-header">
                  <h3>{branch.name}</h3>
                  <span className="contact-type-badge">Branch</span>
                </div>
                <div className="contact-details">
                  <p>{branch.primary_contact_name ?? 'No primary contact'}</p>
                  <p className="contact-meta">
                    {branch.active ? 'Active' : 'Inactive'} ·{' '}
                    {branch.site_count} site
                    {branch.site_count === 1 ? '' : 's'}
                  </p>
                  <div className="crm-account-actions"><span>Internal branch</span><div><button type="button" className="btn btn-sm btn-secondary" onClick={() => setWorkspaceAccount({ id: branch.id, name: branch.name })}>Manage account</button></div></div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="reports-section">
        <h2>Platform Subscribers ({state.platformSubscribers.length})</h2>
        <p className="subtitle">
          Organizations subscribed via Iron Eagle (Layer-1 financial
          agreements).
        </p>
        <div className="crm-account-register is-compact" role="table" aria-label="Platform subscribers">
          {state.platformSubscribers.length === 0 ? (
            <div className="empty-state">
              <p>No platform subscribers yet.</p>
            </div>
          ) : (
            <>
              <div className="crm-account-register-row is-header" role="row"><span>Organization</span><span>Agreement</span><span>Type</span></div>
              {state.platformSubscribers.map((agreement) => (
                <div key={agreement.id} role="row" className="crm-account-register-row is-static">
                  <strong>{agreement.counterparty_name}</strong><span>{agreement.name}</span><span>{agreement.counterparty_type}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      <section className="reports-section">
        <h2>Organizations We Contract With ({state.contractedOrgs.length})</h2>
        <p className="subtitle">
          Organizations linked via operational service agreements (Layer-2
          fieldwork) — not part of your branch hierarchy.
        </p>
        <div className="crm-account-register is-compact" role="table" aria-label="Contracted organizations">
          {state.contractedOrgs.length === 0 ? (
            <div className="empty-state">
              <p>
                No operational contracted organizations found. Service
                agreements create these links.
              </p>
            </div>
          ) : (
            <>
              <div className="crm-account-register-row is-header" role="row"><span>Organization</span><span>Agreement</span><span>Type</span></div>
              {state.contractedOrgs.map((agreement) => (
                <div key={agreement.id} role="row" className="crm-account-register-row is-static">
                  <strong>{agreement.counterparty_name}</strong><span>{agreement.name}</span><span>{agreement.counterparty_type}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </section>
      {quoteClient && (
        <div className="crm-quote-backdrop">
          <form
            className="crm-quote-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="crm-quote-title"
            onSubmit={createQuote}
          >
            <header>
              <div>
                <span>Commercial proposal</span>
                <h2 id="crm-quote-title">New quote for {quoteClient.name}</h2>
              </div>
              <button
                type="button"
                onClick={() => setQuoteClient(null)}
                aria-label="Close quote"
              >
                ×
              </button>
            </header>
            <p>
              Create the governed quote shell first. Labour, travel, module, and
              platform-fee lines remain explicit follow-up pricing work.
            </p>
            <label>
              <span>Quote title</span>
              <input
                required
                value={quoteForm.title}
                onChange={(event) =>
                  setQuoteForm({ ...quoteForm, title: event.target.value })
                }
              />
            </label>
            <div>
              <label>
                <span>Target margin %</span>
                <input
                  type="number"
                  min="0"
                  max="99.99"
                  step="0.01"
                  required
                  value={quoteForm.targetMargin}
                  onChange={(event) =>
                    setQuoteForm({
                      ...quoteForm,
                      targetMargin: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                <span>Valid until</span>
                <input
                  type="date"
                  value={quoteForm.validUntil}
                  onChange={(event) =>
                    setQuoteForm({
                      ...quoteForm,
                      validUntil: event.target.value,
                    })
                  }
                />
              </label>
            </div>
            <label>
              <span>Commercial notes</span>
              <textarea
                rows={4}
                value={quoteForm.notes}
                onChange={(event) =>
                  setQuoteForm({ ...quoteForm, notes: event.target.value })
                }
              />
            </label>
            <footer>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setQuoteClient(null)}
              >
                Back
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={quoteSaving || !quoteForm.title.trim()}
              >
                {quoteSaving ? 'Creating' : 'Create draft quote'}
              </button>
            </footer>
          </form>
        </div>
      )}
      {pricingDialog}
      {workspaceAccount && <CrmAccountWorkspace account={workspaceAccount} onClose={() => { setWorkspaceAccount(null); void loadCrm(); }} onNavigate={onNavigate} onOpenAccount={setWorkspaceAccount} />}
      {organizationDialog && <CrmOrganizationDialog organization={organizationDialog === 'create' ? null : organizationDialog} onClose={() => { setOrganizationDialog(null); void loadCrm(); }} onUpdated={(name) => { setOrganizationDialog(null); setNotice(`${name} organization details updated. Review its readiness steps next.`); void loadCrm(); }} onOpenAccount={(account) => { setOrganizationDialog(null); setWorkspaceAccount(account); }} />}
      {siteAccount && <CrmSiteDialog account={siteAccount} onClose={() => setSiteAccount(null)} onCreated={(site) => { setSiteAccount(null); setNotice(`${site.name} created with a provisional boundary. Operations boundary review is required before activation.`); void loadCrm(); }} />}
      {invoiceAction && <div className="crm-quote-backdrop"><form className="crm-quote-dialog" role="dialog" aria-modal="true" aria-labelledby="crm-invoice-action-title" onSubmit={manageInvoice}><header><div><span>Invoice lifecycle</span><h2 id="crm-invoice-action-title">{invoiceAction.action === 'send' ? 'Send invoice' : invoiceAction.action === 'mark_paid' ? 'Confirm payment' : 'Void invoice'}</h2></div><button type="button" onClick={() => setInvoiceAction(null)} aria-label="Close invoice action">×</button></header><p>{invoiceAction.invoice.invoice_number} · {invoiceAction.invoice.client?.name ?? 'Unknown account'} · {invoiceAction.invoice.currency} {Number(invoiceAction.invoice.total_amount).toFixed(2)}</p>{invoiceAction.action === 'void' && <label><span>Void reason</span><textarea required rows={4} value={invoiceReason} onChange={(event) => setInvoiceReason(event.target.value)} /></label>}<footer><button type="button" className="btn btn-secondary" onClick={() => setInvoiceAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={quoteSaving || (invoiceAction.action === 'void' && !invoiceReason.trim())}>{quoteSaving ? 'Saving' : 'Confirm action'}</button></footer></form></div>}
      {showGenerateInvoice && (
        <div className="crm-quote-backdrop">
          <form className="crm-quote-dialog" role="dialog" aria-modal="true" aria-labelledby="crm-gen-inv-title" onSubmit={generateInvoiceFromAgreement}>
            <header>
              <div><span>Accounts receivable</span><h2 id="crm-gen-inv-title">Generate invoice from agreement</h2></div>
              <button type="button" onClick={() => setShowGenerateInvoice(false)} aria-label="Close invoice generator">×</button>
            </header>
            <p>Draft invoice will be populated with line items directly from accepted service agreement quotes or commercial rates.</p>
            <label>
              <span>Service agreement</span>
              <select required value={selectedAgreementId} onChange={(e) => setSelectedAgreementId(e.target.value)}>
                <option value="">Select an agreement...</option>
                {[...state.platformSubscribers, ...state.contractedOrgs].filter((agreement) => agreement.invitation_status === 'accepted').map((ag) => (
                  <option key={ag.id} value={ag.id}>{ag.counterparty_name} — {ag.name}</option>
                ))}
              </select>
            </label>
            {invoiceReadinessLoading && <div className="crm-invoice-readiness">Checking agreement billing readiness.</div>}
            {invoiceReadiness && <div className={`crm-invoice-readiness is-${invoiceReadiness.source}`}><strong>{invoiceReadiness.accountName}</strong><span>{invoiceReadiness.agreementName}</span><p>{invoiceReadiness.detail}</p>{invoiceReadiness.billingCycle && <small>{invoiceReadiness.billingCycle} billing · {invoiceReadiness.paymentTermsDays} day payment terms</small>}{invoiceReadiness.source === 'missing' && <small>Configure accepted quote lines or commercial settings before creating a draft invoice.</small>}</div>}
            <footer>
              <button type="button" className="btn btn-secondary" onClick={() => setShowGenerateInvoice(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={quoteSaving || !selectedAgreementId || invoiceReadinessLoading || invoiceReadiness?.source === 'missing'}>{quoteSaving ? 'Generating...' : 'Generate draft invoice'}</button>
            </footer>
          </form>
        </div>
      )}
      {pricingQuote && quoteAction && <div className="crm-quote-backdrop"><form className="crm-quote-dialog crm-lifecycle-dialog" role="dialog" aria-modal="true" aria-labelledby="crm-lifecycle-title" onSubmit={manageQuote}><header><div><span>Quote lifecycle</span><h2 id="crm-lifecycle-title">{quoteAction === 'send' ? 'Send quote?' : quoteAction === 'accept' ? 'Accept quote?' : 'Decline quote?'}</h2></div><button type="button" onClick={() => setQuoteAction(null)} aria-label="Close quote action">×</button></header><p>{quoteAction === 'send' ? 'The server will recheck labour pricing, positive totals, validity, and achieved margin before sending.' : quoteAction === 'accept' ? 'Acceptance creates or links the operational service agreement and writes canonical commercial settings.' : 'The quote will close as declined and the reason will remain in its audit history.'}</p>{quoteAction === 'decline' && <label><span>Decline reason</span><textarea rows={4} required value={quoteActionReason} onChange={(event) => setQuoteActionReason(event.target.value)} /></label>}<footer><button type="button" className="btn btn-secondary" onClick={() => setQuoteAction(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={quoteSaving || (quoteAction === 'decline' && !quoteActionReason.trim())}>{quoteSaving ? 'Saving' : quoteAction === 'send' ? 'Confirm send' : quoteAction === 'accept' ? 'Confirm acceptance' : 'Confirm decline'}</button></footer></form></div>}
    </div>
  );
};

export default CRMPage;
