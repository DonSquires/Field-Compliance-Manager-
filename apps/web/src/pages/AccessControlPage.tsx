/**
 * AccessControlPage.tsx
 *
 * Canonical schema: access_presets (named grant bundles) + preset_assignments
 * (links a user to a preset at an org scope — grants resolve live from the
 * preset) + staff_area_grants (direct per-area grants, level: view/verify/
 * approve/adjust/manage).
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface AccessPreset {
  id: string;
  key: string;
  name: string;
  description: string | null;
  role: string | null;
  is_system: boolean;
}

interface PresetAssignment {
  id: string;
  user_id: string;
  preset_id: string;
  status: string;
}

interface AreaGrant {
  id: string;
  user_id: string;
  area: string;
  level: string;
  status: string;
  source_preset: string | null;
}

interface UserLite {
  id: string;
  display_name: string | null;
  email: string | null;
}

const AccessControlPage: React.FC = () => {
  const { profile } = useAuth();
  const [presets, setPresets] = useState<AccessPreset[]>([]);
  const [assignments, setAssignments] = useState<PresetAssignment[]>([]);
  const [grants, setGrants] = useState<AreaGrant[]>([]);
  const [users, setUsers] = useState<Record<string, UserLite>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: access_presets, preset_assignments, staff_area_grants, user_profiles
  const loadAll = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;

    try {
      setLoading(true);
      setError(null);

      const [presetsRes, assignmentsRes, grantsRes, usersRes] = await Promise.all([
        supabase
          .from('access_presets')
          .select('id, key, name, description, role, is_system')
          .or(`organization_id.eq.${orgId},is_system.eq.true`),
        supabase.from('preset_assignments').select('id, user_id, preset_id, status').eq('scope_org_id', orgId),
        supabase
          .from('staff_area_grants')
          .select('id, user_id, area, level, status, source_preset')
          .eq('scope_org_id', orgId),
        supabase.from('user_profiles').select('id, display_name, email').eq('organization_id', orgId),
      ]);

      if (presetsRes.error) throw presetsRes.error;
      if (assignmentsRes.error) throw assignmentsRes.error;
      if (grantsRes.error) throw grantsRes.error;
      if (usersRes.error) throw usersRes.error;

      const userMap: Record<string, UserLite> = {};
      (usersRes.data || []).forEach((u: UserLite) => {
        userMap[u.id] = u;
      });

      setPresets((presetsRes.data as AccessPreset[]) || []);
      setAssignments((assignmentsRes.data as PresetAssignment[]) || []);
      setGrants((grantsRes.data as AreaGrant[]) || []);
      setUsers(userMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access control data');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleRevokeGrant = async (grant: AreaGrant) => {
    try {
      // ATLAS WRITES: staff_area_grants
      const { error } = await supabase.from('staff_area_grants').update({ status: 'ended' }).eq('id', grant.id);
      if (error) throw error;
      setGrants(grants.map((g) => (g.id === grant.id ? { ...g, status: 'ended' } : g)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke grant');
    }
  };

  const userLabel = (id: string) => users[id]?.display_name || users[id]?.email || id;

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading access control data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Access Control</h1>
        <p className="subtitle">{presets.length} presets · {grants.length} direct area grants</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <section className="reports-section">
        <h2>Access Presets ({presets.length})</h2>
        <div className="contacts-list">
          {presets.length === 0 ? (
            <div className="empty-state">
              <p>No presets configured.</p>
            </div>
          ) : (
            presets.map((preset) => {
              const holders = assignments.filter((a) => a.preset_id === preset.id && a.status === 'active');
              return (
                <div key={preset.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{preset.name}</h3>
                    <span className="contact-type-badge">{preset.is_system ? 'System' : 'Custom'}</span>
                  </div>
                  <div className="contact-details">
                    {preset.description && <p>{preset.description}</p>}
                    <p className="contact-meta">
                      {holders.length} active holder{holders.length === 1 ? '' : 's'}
                      {holders.length > 0 && `: ${holders.map((h) => userLabel(h.user_id)).join(', ')}`}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className="reports-section">
        <h2>Direct Area Grants ({grants.filter((g) => g.status === 'active').length})</h2>
        <div className="reports-table-wrapper">
          <table className="reports-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Area</th>
                <th>Level</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {grants.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center">
                    No direct grants
                  </td>
                </tr>
              ) : (
                grants.map((grant) => (
                  <tr key={grant.id}>
                    <td>{userLabel(grant.user_id)}</td>
                    <td>{grant.area}</td>
                    <td>
                      <span className="badge">{grant.level}</span>
                    </td>
                    <td>
                      <span className={`status-badge status-${grant.status}`}>{grant.status}</span>
                    </td>
                    <td>
                      {grant.status === 'active' && (
                        <button className="btn btn-sm btn-danger" onClick={() => handleRevokeGrant(grant)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default AccessControlPage;
