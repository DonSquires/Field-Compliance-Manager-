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

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

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

      // crm_account_list view: organizations + live site_count + primary_contact_name
      const { data: accounts, error: acctErr } = await supabase
        .from('crm_account_list')
        .select('*')
        .eq('parent_organization_id', orgId);
      if (acctErr) throw acctErr;

      const rows = (accounts ?? []) as AccountRow[];
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
          '*, client:client_organization_id(id, name, organization_type), provider:provider_organization_id(id, name, organization_type)'
        )
        .or(`client_organization_id.eq.${orgId},provider_organization_id.eq.${orgId}`)
        .eq('agreement_type', 'operational');
      if (opErr) throw opErr;

      const branchOrgIds = new Set(branches.map((b) => b.id));

      const platformSubscribers: AgreementRow[] = (subscriberAgreements ?? []).map((a: any) => ({
        ...a,
        counterparty_name: a.client?.name ?? 'Unknown organisation',
        counterparty_type: a.client?.organization_type ?? 'unknown',
      }));

      const contractedOrgs: AgreementRow[] = (operationalAgreements ?? [])
        .filter((a: any) => {
          const counterpartId = a.provider_organization_id === orgId ? a.client_organization_id : a.provider_organization_id;
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

      <div className="crm-branch-filter">
        <label>Branch</label>
        <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
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
            {state.clients.length} clients · 0 contractors · {state.branches.length} branches
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
                    {client.active ? 'Active' : 'Inactive'} · {client.site_count} site
                    {client.site_count === 1 ? '' : 's'}
                  </p>
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
                    {branch.active ? 'Active' : 'Inactive'} · {branch.site_count} site
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
          Organizations subscribed via Iron Eagle (Layer-1 financial agreements).
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
          Organizations linked via operational service agreements (Layer-2 fieldwork) — not part of
          your branch hierarchy.
        </p>
        <div className="contacts-list">
          {state.contractedOrgs.length === 0 ? (
            <div className="empty-state">
              <p>No operational contracted organizations found. Service agreements create these links.</p>
            </div>
          ) : (
            state.contractedOrgs.map((agreement) => (
              <div key={agreement.id} className="contact-card">
                <div className="contact-header">
                  <h3>{agreement.counterparty_name}</h3>
                  <span className="contact-type-badge">{agreement.counterparty_type}</span>
                </div>
                <div className="contact-details">
                  <p>{agreement.name}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
};

export default CRMPage;
