/**
 * ProviderBillingPage.tsx (nav id: platform-subscriptions)
 *
 * Canonical schema: org_module_subscriptions — Layer 1 (owner->provider)
 * subscription lines: what each provider org is actually charged per module
 * (price overrides + discount, else inherits module_catalog). Grand_master
 * write; provider reads its own.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './ProviderBillingPage.css';

interface SubscriptionRow {
  id: string;
  organization_id: string;
  module_key: string;
  base_price: number | null;
  per_seat_price: number | null;
  per_site_price: number | null;
  discount_pct: number;
  billing_period: string | null;
  currency: string | null;
  status: string;
  started_at: string;
  updated_at: string;
  effective_from: string | null;
  effective_to: string | null;
  notes: string | null;
}

interface OrgLite {
  id: string;
  name: string;
}

const moduleLabel = (moduleKey: string) => ({
  access_control: 'Access Control', biosecurity: 'Biosecurity', bob_assistant: 'Bob Assistant', client_reporting: 'Client Reporting', ems: 'Emergency Management System', freedom_camping: 'Freedom Camping', invoicing: 'Invoicing & Finance', noise_control: 'Noise Control', parking_enforcement: 'Parking Enforcement', patrol: 'Patrol', ptt_radio: 'PTT Radio', smoke_complaints: 'Smoke Complaints', static_guarding: 'Static Guarding',
}[moduleKey] ?? moduleKey.split('_').map((word) => word[0].toUpperCase() + word.slice(1)).join(' '));

const ProviderBillingPage: React.FC = () => {
  const { profile } = useAuth();
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [orgs, setOrgs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingSubscription, setEditingSubscription] = useState<SubscriptionRow | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended' | 'cancelled'>('all');
  const [termsForm, setTermsForm] = useState({ basePrice: '', perSeatPrice: '', perSitePrice: '', discountPct: '0', billingPeriod: '', currency: '', effectiveFrom: '', effectiveTo: '', notes: '' });
  const isGrandMaster = profile?.role === 'grand_master';

  // ATLAS READS: org_module_subscriptions, organizations
  const loadSubscriptions = useCallback(async () => {
    if (!isGrandMaster && !profile?.organizationId) {
      setSubscriptions([]);
      setOrgs({});
      setError('Organisation access could not be confirmed. Provider billing is unavailable.');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);

      const query = supabase
        .from('org_module_subscriptions')
        .select('id, organization_id, module_key, base_price, per_seat_price, per_site_price, discount_pct, billing_period, currency, status, started_at, updated_at, effective_from, effective_to, notes')
        .order('started_at', { ascending: false });

      const { data, error: err } = isGrandMaster
        ? await query
        : await query.eq('organization_id', profile.organizationId);

      if (err) throw err;
      const rows = (data as SubscriptionRow[]) || [];
      setSubscriptions(rows);

      const orgIds = Array.from(new Set(rows.map((r) => r.organization_id)));
      if (orgIds.length > 0) {
        const { data: orgData, error: orgErr } = await supabase
          .from('organizations')
          .select('id, name')
          .in('id', orgIds);
        if (orgErr) throw orgErr;
        const map: Record<string, string> = {};
        (orgData as OrgLite[] || []).forEach((o) => (map[o.id] = o.name));
        setOrgs(map);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load provider billing');
    } finally {
      setLoading(false);
    }
  }, [isGrandMaster, profile?.organizationId]);

  useEffect(() => {
    loadSubscriptions();
  }, [loadSubscriptions]);

  const handleToggleStatus = async (sub: SubscriptionRow) => {
    const nextStatus = sub.status === 'active' ? 'suspended' : 'active';
    try {
      const { data, error } = await supabase.rpc('manage_provider_module_subscription_status', { p_subscription_id: sub.id, p_expected_updated_at: sub.updated_at, p_status: nextStatus });
      if (error || !data) throw error ?? new Error('Subscription status receipt was not confirmed.');
      setSubscriptions(subscriptions.map((s) => (s.id === sub.id ? data as SubscriptionRow : s)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update subscription');
    }
  };

  const openTerms = (sub: SubscriptionRow) => {
    setEditingSubscription(sub);
    setTermsForm({ basePrice: sub.base_price == null ? '' : String(sub.base_price), perSeatPrice: sub.per_seat_price == null ? '' : String(sub.per_seat_price), perSitePrice: sub.per_site_price == null ? '' : String(sub.per_site_price), discountPct: String(sub.discount_pct), billingPeriod: sub.billing_period ?? '', currency: sub.currency ?? '', effectiveFrom: sub.effective_from ?? '', effectiveTo: sub.effective_to ?? '', notes: sub.notes ?? '' });
    setError(null);
  };

  const saveTerms = async (event: React.FormEvent) => {
    event.preventDefault(); if (!editingSubscription) return;
    const { data, error: saveError } = await supabase.rpc('manage_provider_module_subscription_terms', { p_subscription_id: editingSubscription.id, p_expected_updated_at: editingSubscription.updated_at, p_base_price: termsForm.basePrice ? Number(termsForm.basePrice) : null, p_per_seat_price: termsForm.perSeatPrice ? Number(termsForm.perSeatPrice) : null, p_per_site_price: termsForm.perSitePrice ? Number(termsForm.perSitePrice) : null, p_discount_pct: Number(termsForm.discountPct), p_billing_period: termsForm.billingPeriod || null, p_currency: termsForm.currency || null, p_effective_from: termsForm.effectiveFrom || null, p_effective_to: termsForm.effectiveTo || null, p_notes: termsForm.notes.trim() || null });
    if (saveError || !data) setError(saveError?.message ?? 'Subscription terms receipt was not confirmed.');
    else { setSubscriptions(subscriptions.map((sub) => sub.id === editingSubscription.id ? data as SubscriptionRow : sub)); setEditingSubscription(null); }
  };

  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  const visibleSubscriptions = subscriptions.filter((subscription) => {
    if (statusFilter !== 'all' && subscription.status !== statusFilter) return false;
    if (!normalizedSearch) return true;
    const searchableFields = [
      subscription.module_key,
      moduleLabel(subscription.module_key),
      subscription.status,
      subscription.notes,
      isGrandMaster ? orgs[subscription.organization_id] : null,
    ];
    return searchableFields.filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedSearch);
  });

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading provider billing...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Iron Eagle Platform Billing</h1>
        <p className="subtitle">Layer 1 charges to provider organizations and operating branches. This is not client service pricing.</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="provider-billing-list-tools" role="search" aria-label="Filter provider subscriptions">
        <label><span>Search provider subscriptions</span><input type="search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Provider, module, status, or note" /></label>
        <label><span>Subscription status</span><select aria-label="Filter by subscription status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="cancelled">Cancelled</option></select></label>
        <span className="provider-billing-result-count" role="status" aria-live="polite">Showing {visibleSubscriptions.length} of {subscriptions.length} loaded subscriptions</span>
      </div>

      {isGrandMaster && <p className="provider-billing-scroll-cue">Scroll the table horizontally to review all pricing and actions.</p>}
      <div className="reports-table-wrapper provider-billing-table-region" role="region" aria-label="Provider module subscriptions" tabIndex={0}>
        <table className="reports-table">
          <thead>
            <tr>
              {isGrandMaster && <th>Provider</th>}
              <th>Module</th>
              <th>Platform cost</th>
              <th>Discount</th>
              <th>Period</th>
              <th>Status</th>
              {isGrandMaster && <th></th>}
            </tr>
          </thead>
          <tbody>
            {subscriptions.length === 0 ? (
              <tr>
                <td colSpan={isGrandMaster ? 7 : 5} className="text-center">
                  No subscriptions
                </td>
              </tr>
            ) : visibleSubscriptions.length === 0 ? (
              <tr>
                <td colSpan={isGrandMaster ? 7 : 5} className="text-center">
                  <div className="provider-billing-filter-empty"><span>No subscriptions match these filters.</span><button type="button" className="btn btn-sm btn-secondary" onClick={() => { setSearchTerm(''); setStatusFilter('all'); }}>Clear filters</button></div>
                </td>
              </tr>
            ) : (
              visibleSubscriptions.map((sub) => (
                <tr key={sub.id}>
                  {isGrandMaster && <td>{orgs[sub.organization_id] || 'Provider name unavailable'}</td>}
                  <td>{moduleLabel(sub.module_key)}</td>
                  <td>{sub.base_price != null ? `$${sub.base_price}` : 'Catalog list price'}<small>{` + ${sub.per_seat_price ?? 0}/seat + ${sub.per_site_price ?? 0}/site`}</small></td>
                  <td>{sub.discount_pct}%</td>
                  <td>{sub.billing_period || 'Catalog period'}</td>
                  <td>
                    <span className={`status-badge status-${sub.status}`}>{sub.status}</span>
                  </td>
                  {isGrandMaster && (
                    <td>
                      <button className="btn btn-sm btn-secondary" onClick={() => openTerms(sub)}>Terms</button>
                      <button className="btn btn-sm btn-secondary" onClick={() => handleToggleStatus(sub)}>
                        {sub.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {editingSubscription && <div className="provider-terms-backdrop"><form className="provider-terms-dialog" onSubmit={saveTerms} role="dialog" aria-modal="true" aria-labelledby="platform-terms-title"><header><div><span>Layer 1 platform contract</span><h2 id="platform-terms-title">{moduleLabel(editingSubscription.module_key)} for {orgs[editingSubscription.organization_id] ?? 'provider'}</h2></div><button type="button" onClick={() => setEditingSubscription(null)} aria-label="Close subscription terms">×</button></header><p>Blank price, period, and currency values inherit the Iron Eagle module catalog. These terms charge the provider or operating branch, never its client.</p><div><label><span>Base price override</span><input type="number" min="0" step="0.01" value={termsForm.basePrice} onChange={(event) => setTermsForm({ ...termsForm, basePrice: event.target.value })} /></label><label><span>Per-seat override</span><input type="number" min="0" step="0.01" value={termsForm.perSeatPrice} onChange={(event) => setTermsForm({ ...termsForm, perSeatPrice: event.target.value })} /></label></div><div><label><span>Per-site override</span><input type="number" min="0" step="0.01" value={termsForm.perSitePrice} onChange={(event) => setTermsForm({ ...termsForm, perSitePrice: event.target.value })} /></label><label><span>Discount %</span><input required type="number" min="0" max="100" step="0.01" value={termsForm.discountPct} onChange={(event) => setTermsForm({ ...termsForm, discountPct: event.target.value })} /></label></div><div><label><span>Billing period</span><select value={termsForm.billingPeriod} onChange={(event) => setTermsForm({ ...termsForm, billingPeriod: event.target.value })}><option value="">Catalog period</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></label><label><span>Currency</span><select value={termsForm.currency} onChange={(event) => setTermsForm({ ...termsForm, currency: event.target.value })}><option value="">Catalog currency</option><option value="NZD">NZD</option><option value="AUD">AUD</option><option value="USD">USD</option></select></label></div><div><label><span>Effective from</span><input type="date" value={termsForm.effectiveFrom} onChange={(event) => setTermsForm({ ...termsForm, effectiveFrom: event.target.value })} /></label><label><span>Effective to</span><input type="date" value={termsForm.effectiveTo} onChange={(event) => setTermsForm({ ...termsForm, effectiveTo: event.target.value })} /></label></div><label><span>Contract note</span><textarea rows={3} value={termsForm.notes} onChange={(event) => setTermsForm({ ...termsForm, notes: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setEditingSubscription(null)}>Cancel</button><button type="submit" className="btn btn-primary">Save platform terms</button></footer></form></div>}
    </div>
  );
};

export default ProviderBillingPage;
