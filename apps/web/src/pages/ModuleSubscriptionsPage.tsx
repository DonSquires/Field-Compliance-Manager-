/**
 * ModuleSubscriptionsPage.tsx
 *
 * Self-serve module subscribe/unsubscribe for the caller's own organisation
 * (any organization_type — unlike the branch-only operating-branch toggle in
 * OrganizationSetupPage). Reads organization_modules + org_module_subscriptions;
 * writes via set_organization_module_subscription, which the module_dependencies
 * trigger still enforces (e.g. Finance requires Rostering).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { PLATFORM_MODULE_MANIFEST } from '../config/platformModuleManifest';
import './PageStyles.css';

interface SubscriptionRow {
  module_key: string;
  status: string;
}

const ModuleSubscriptionsPage: React.FC = () => {
  const { profile } = useAuth();
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [subscriptions, setSubscriptions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;
    try {
      setLoading(true);
      setError(null);
      const [modulesRes, subsRes] = await Promise.all([
        supabase.from('organization_modules').select('module_key, enabled').eq('organization_id', orgId),
        supabase.from('org_module_subscriptions').select('module_key, status').eq('organization_id', orgId),
      ]);
      if (modulesRes.error) throw modulesRes.error;
      if (subsRes.error) throw subsRes.error;
      setEnabled(new Set((modulesRes.data ?? []).filter((row) => row.enabled).map((row) => row.module_key)));
      setSubscriptions(Object.fromEntries(((subsRes.data ?? []) as SubscriptionRow[]).map((row) => [row.module_key, row.status])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load module subscriptions');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (moduleKey: string, nextEnabled: boolean) => {
    const orgId = profile?.organizationId;
    if (!orgId) return;
    setSavingKey(moduleKey);
    setError(null);
    const { error: toggleError } = await supabase.rpc('set_organization_module_subscription', {
      p_organization_id: orgId,
      p_module_key: moduleKey,
      p_enabled: nextEnabled,
    });
    if (toggleError) setError(toggleError.message);
    else await load();
    setSavingKey(null);
  };

  if (loading) {
    return <div className="page-container"><div className="loading-state"><div className="spinner"></div><p>Loading module subscriptions...</p></div></div>;
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Modules & Subscriptions</h1>
        <p className="subtitle">Subscribe to only the modules your organisation needs. Each module is a standalone app you can enable independently.</p>
      </header>
      {error && <div className="alert alert-error" role="alert"><button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">×</button>{error}</div>}
      <div className="reports-table-wrapper">
        <table className="reports-table">
          <thead><tr><th>Module</th><th>Description</th><th>Subscription</th><th>Enabled</th></tr></thead>
          <tbody>
            {PLATFORM_MODULE_MANIFEST.map((module) => {
              const isEnabled = enabled.has(module.key);
              const missing = module.dependsOn.filter((dep) => !enabled.has(dep));
              const blocked = !isEnabled && missing.length > 0;
              const Icon = module.icon;
              return (
                <tr key={module.key}>
                  <td><Icon size={16} aria-hidden="true" /> {module.label}</td>
                  <td>{module.description}</td>
                  <td>{subscriptions[module.key] ? <span className={`status-badge status-${subscriptions[module.key]}`}>{subscriptions[module.key]}</span> : <span className="status-badge status-inactive">not subscribed</span>}</td>
                  <td>
                    {blocked ? (
                      <span title={`Requires ${missing.join(', ')} to be enabled first`}><Lock size={14} aria-hidden="true" /> Requires {missing.join(', ')}</span>
                    ) : (
                      <label className="agreement-check">
                        <input type="checkbox" checked={isEnabled} disabled={savingKey === module.key} onChange={(event) => void toggle(module.key, event.target.checked)} />
                        <span>{isEnabled ? <><CheckCircle2 size={14} aria-hidden="true" /> Enabled</> : 'Disabled'}</span>
                      </label>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ModuleSubscriptionsPage;
