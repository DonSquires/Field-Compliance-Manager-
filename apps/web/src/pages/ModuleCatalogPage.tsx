/**
 * ModuleCatalogPage.tsx
 *
 * Canonical schema: module_catalog — Layer 1 (owner->provider) platform price
 * list, one row per module_key. No organization_id: applies to all providers,
 * overridden per subscription in org_module_subscriptions. Grand_master write,
 * all authenticated read.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface ModuleCatalogRow {
  module_key: string;
  base_price: number;
  per_seat_price: number;
  per_site_price: number;
  billing_period: string;
  currency: string;
  active: boolean;
}

const ModuleCatalogPage: React.FC = () => {
  const { profile } = useAuth();
  const [rows, setRows] = useState<ModuleCatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isGrandMaster = profile?.role === 'grand_master';

  // ATLAS READS: module_catalog
  const loadCatalog = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('module_catalog')
        .select('module_key, base_price, per_seat_price, per_site_price, billing_period, currency, active')
        .order('module_key', { ascending: true });

      if (err) throw err;
      setRows((data as ModuleCatalogRow[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load module catalog');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const handleUpdatePrice = async (moduleKey: string, field: keyof ModuleCatalogRow, value: number) => {
    try {
      // ATLAS WRITES: module_catalog (grand_master only)
      const { error } = await supabase.from('module_catalog').update({ [field]: value }).eq('module_key', moduleKey);
      if (error) throw error;
      setRows(rows.map((r) => (r.module_key === moduleKey ? { ...r, [field]: value } : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update price');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading module pricing...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Module Pricing</h1>
        <p className="subtitle">Platform price list · {rows.length} modules</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      {!isGrandMaster && (
        <div className="empty-state">
          <p>Read-only — only grand_master can edit platform pricing.</p>
        </div>
      )}

      <div className="reports-table-wrapper">
        <table className="reports-table">
          <thead>
            <tr>
              <th>Module</th>
              <th>Base Price</th>
              <th>Per Seat</th>
              <th>Per Site</th>
              <th>Billing Period</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center">
                  No modules in catalog
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.module_key}>
                  <td>{row.module_key}</td>
                  <td>
                    {isGrandMaster ? (
                      <input
                        type="number"
                        step="0.01"
                        defaultValue={row.base_price}
                        onBlur={(e) => handleUpdatePrice(row.module_key, 'base_price', parseFloat(e.target.value))}
                        style={{ width: '90px' }}
                      />
                    ) : (
                      `${row.currency} ${row.base_price}`
                    )}
                  </td>
                  <td>{row.currency} {row.per_seat_price}</td>
                  <td>{row.currency} {row.per_site_price}</td>
                  <td>{row.billing_period}</td>
                  <td>
                    <span className={`status-badge status-${row.active ? 'active' : 'inactive'}`}>
                      {row.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ModuleCatalogPage;
