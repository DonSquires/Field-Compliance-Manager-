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
  const isGrandMaster = profile?.role === 'grand_master';

  // ATLAS READS: org_module_subscriptions, organizations
  const loadSubscriptions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const query = supabase
        .from('org_module_subscriptions')
        .select('id, organization_id, module_key, base_price, per_seat_price, per_site_price, discount_pct, billing_period, currency, status, started_at, updated_at')
        .order('started_at', { ascending: false });

      const { data, error: err } = isGrandMaster
        ? await query
        : await query.eq('organization_id', profile?.organizationId ?? '');

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

      <div className="reports-table-wrapper">
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
            ) : (
              subscriptions.map((sub) => (
                <tr key={sub.id}>
                  {isGrandMaster && <td>{orgs[sub.organization_id] || sub.organization_id}</td>}
                  <td>{moduleLabel(sub.module_key)}</td>
                  <td>{sub.base_price != null ? `$${sub.base_price}` : 'Catalog list price'}<small>{` + ${sub.per_seat_price ?? 0}/seat + ${sub.per_site_price ?? 0}/site`}</small></td>
                  <td>{sub.discount_pct}%</td>
                  <td>{sub.billing_period || 'Catalog period'}</td>
                  <td>
                    <span className={`status-badge status-${sub.status}`}>{sub.status}</span>
                  </td>
                  {isGrandMaster && (
                    <td>
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
    </div>
  );
};

export default ProviderBillingPage;
