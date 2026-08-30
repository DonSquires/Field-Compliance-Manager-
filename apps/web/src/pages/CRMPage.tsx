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
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
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
  site_count: number;
  primary_contact_name: string | null;
  latest_quote_status: string | null;
  sites: Array<{ id: string; name: string }>;
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

interface CrmState {
  ownOrg: Organization | null;
  clients: AccountRow[];
  branches: AccountRow[];
  platformSubscribers: AgreementRow[];
  contractedOrgs: AgreementRow[];
  loading: boolean;
  error: string | null;
}

const CRMPage: React.FC = () => {
  const { profile } = useAuth();
  const [state, setState] = useState<CrmState>({
    ownOrg: null,
    clients: [],
    branches: [],
    platformSubscribers: [],
    contractedOrgs: [],
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
  const [notice, setNotice] = useState<string | null>(null);
  const quoteRequestId = useRef(crypto.randomUUID());
  const lineRequestId = useRef(crypto.randomUUID());

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
        .select('id, name, organization_type, active, parent_organization_id')
        .eq('parent_organization_id', orgId);
      if (acctErr) throw acctErr;

      const accountIds = (accounts ?? []).map((account) => account.id);
      const [sitesRes, contactsRes, quotesRes] = accountIds.length
        ? await Promise.all([
            supabase
              .from('client_sites')
              .select('id,name,organization_id')
              .in('organization_id', accountIds),
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
          ])
        : [
            { data: [], error: null },
            { data: [], error: null },
            { data: [], error: null },
          ];
      if (sitesRes.error) throw sitesRes.error;
      if (contactsRes.error) throw contactsRes.error;
      if (quotesRes.error) throw quotesRes.error;
      const siteCounts = new Map<string, number>();
      for (const site of sitesRes.data ?? [])
        siteCounts.set(
          site.organization_id,
          (siteCounts.get(site.organization_id) ?? 0) + 1,
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
        id: acct.id,
        name: acct.name,
        organization_type: acct.organization_type,
        active: acct.active,
        site_count: siteCounts.get(acct.id) ?? 0,
        primary_contact_name: primaryContacts.get(acct.id) ?? null,
        latest_quote_status: latestQuotes.get(acct.id) ?? null,
        sites: (sitesRes.data ?? [])
          .filter((site) => site.organization_id === acct.id)
          .map((site) => ({ id: site.id, name: site.name })),
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
      await loadCrm();
    }
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
          <button
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
          </button>
        </footer>
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

  return (
    <div className="page-container crm-page">
      <header className="page-header">
        <h1>CRM</h1>
        <p className="subtitle">
          {totalAccounts} accounts · Client and service provider management
        </p>
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

      <section className="reports-section">
        <h2>Our Clients ({state.clients.length})</h2>
        <div className="contacts-list">
          {state.clients.length === 0 ? (
            <div className="empty-state">
              <p>No client accounts yet.</p>
            </div>
          ) : (
            state.clients.map((client) => (
              <div key={client.id} className="contact-card">
                <div className="contact-header">
                  <h3>{client.name}</h3>
                  <span className="contact-type-badge">Client</span>
                </div>
                <div className="contact-details">
                  <p>{client.primary_contact_name ?? 'No primary contact'}</p>
                  <p className="contact-meta">
                    {client.active ? 'Active' : 'Inactive'} ·{' '}
                    {client.site_count} site
                    {client.site_count === 1 ? '' : 's'}
                  </p>
                  <div className="crm-account-actions">
                    <span>Quote: {client.latest_quote_status ?? 'none'}</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => openQuote(client)}
                    >
                      New quote
                    </button>
                  </div>
                </div>
              </div>
            ))
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
        <div className="contacts-list">
          {state.platformSubscribers.map((agreement) => (
            <div key={agreement.id} className="contact-card">
              <div className="contact-header">
                <h3>{agreement.counterparty_name}</h3>
                <span className="contact-type-badge">Subscriber</span>
              </div>
              <div className="contact-details">
                <p>{agreement.name}</p>
                <p className="contact-meta">{agreement.counterparty_type}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="reports-section">
        <h2>Organizations We Contract With ({state.contractedOrgs.length})</h2>
        <p className="subtitle">
          Organizations linked via operational service agreements (Layer-2
          fieldwork) — not part of your branch hierarchy.
        </p>
        <div className="contacts-list">
          {state.contractedOrgs.length === 0 ? (
            <div className="empty-state">
              <p>
                No operational contracted organizations found. Service
                agreements create these links.
              </p>
            </div>
          ) : (
            state.contractedOrgs.map((agreement) => (
              <div key={agreement.id} className="contact-card">
                <div className="contact-header">
                  <h3>{agreement.counterparty_name}</h3>
                  <span className="contact-type-badge">
                    {agreement.counterparty_type}
                  </span>
                </div>
                <div className="contact-details">
                  <p>{agreement.name}</p>
                </div>
              </div>
            ))
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
    </div>
  );
};

export default CRMPage;
