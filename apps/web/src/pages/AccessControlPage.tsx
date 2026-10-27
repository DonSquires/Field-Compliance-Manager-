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
import './AccessControlPage.css';

const BRANCH_AUTHORITY_AREAS = [
  ['timesheet_local_review', 'Timesheet local review'], ['leave_branch_approve', 'Leave branch approval'], ['roster_impact_approve', 'Roster impact approval'],
  ['credentials_supervise', 'Credential supervision'], ['hr_case_local_investigate', 'Local people-matter investigation'], ['incident_manage_local', 'Local incident management'],
] as const;
const BRANCH_AUTHORITY_LABELS = { ...Object.fromEntries(BRANCH_AUTHORITY_AREAS), vehicle_owner_identity: 'Vehicle owner details (NZTA restricted)', person_search: 'Person search (operational, read-only)' } as Record<string, string>;
const ACCESS_LEVEL_LABELS: Record<string, string> = { view: 'View', verify: 'Verify', approve: 'Approve', adjust: 'Adjust', manage: 'Manage' };
const ACCESS_STATUS_LABELS: Record<string, string> = { active: 'Active', ended: 'Ended', suspended: 'Suspended' };
const accessLabel = (value: string) => {
  const words = value.replaceAll('_', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

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
  updated_at: string;
}

interface UserLite {
  id: string;
  display_name: string | null;
  email: string | null;
  updated_at: string;
}

const AccessControlPage: React.FC = () => {
  const { profile, operatingOrganizationId, operatingOrganizations } = useAuth();
  const [presets, setPresets] = useState<AccessPreset[]>([]);
  const [assignments, setAssignments] = useState<PresetAssignment[]>([]);
  const [grants, setGrants] = useState<AreaGrant[]>([]);
  const [users, setUsers] = useState<Record<string, UserLite>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokeGrant, setRevokeGrant] = useState<AreaGrant | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [showGrantForm, setShowGrantForm] = useState(false);
  const [grantForm, setGrantForm] = useState<{ userId: string; area: string; level: string; reason: string }>({ userId: '', area: BRANCH_AUTHORITY_AREAS[0][0], level: 'approve', reason: '' });

  // ATLAS READS: access_presets, preset_assignments, staff_area_grants, user_profiles
  const loadAll = useCallback(async () => {
    const orgId = profile?.organizationId;
    const operatingBranchId = operatingOrganizationId ?? orgId;
    if (!orgId || !operatingBranchId) {
      setLoading(false);
      setError(null);
      return;
    }
    const operatingContext = operatingOrganizations.find((context) => context.organizationId === operatingBranchId);
    if (operatingContext && !['branch_authorisation', 'organisation_home', 'corporate_oversight'].includes(operatingContext.authorityBasis)) {
      setError('Select an organisation or branch you can operate to manage access.');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      // Area grants are branch-scoped; the people list is served for the organisation itself and for branches.
      const canLoadBranchAccess = operatingContext?.authorityBasis === 'branch_authorisation' || operatingContext?.authorityBasis === 'corporate_oversight';

      const [presetsRes, assignmentsRes, grantsRes, usersRes] = await Promise.all([
        supabase
          .from('access_presets')
          .select('id, key, name, description, role, is_system')
          .or(`organization_id.eq.${orgId},is_system.eq.true`),
        supabase.from('preset_assignments').select('id, user_id, preset_id, status').eq('scope_org_id', orgId),
        canLoadBranchAccess
          ? supabase.rpc('get_branch_area_grants', { p_operating_organization_id: operatingBranchId })
          : Promise.resolve({ data: [], error: null }),
        supabase.rpc('get_manageable_user_identities', { p_operating_organization_id: operatingBranchId }),
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
  }, [operatingOrganizationId, operatingOrganizations, profile?.organizationId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleRevokeGrant = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!revokeGrant || !revokeReason.trim()) return;
    try {
      const target = users[revokeGrant.user_id];
      if (!target) throw new Error('Grant user could not be resolved.');
      const { error } = await supabase.rpc('end_branch_area_grant', { p_grant_id: revokeGrant.id, p_expected_updated_at: revokeGrant.updated_at, p_reason: revokeReason.trim() });
      if (error) throw error;
      setRevokeGrant(null); setRevokeReason(''); await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke grant');
    }
  };

  const handleGrant = async (event: React.FormEvent) => {
    event.preventDefault();
    const operatingBranchId = operatingOrganizationId ?? profile?.organizationId;
    if (!operatingBranchId || !grantForm.userId || !grantForm.reason.trim()) return;
    try {
      const { error } = await supabase.rpc('grant_branch_area_access', { p_operating_organization_id: operatingBranchId, p_user_id: grantForm.userId, p_area: grantForm.area, p_level: grantForm.level, p_reason: grantForm.reason.trim() });
      if (error) throw error;
      setShowGrantForm(false); setGrantForm({ userId: '', area: BRANCH_AUTHORITY_AREAS[0][0], level: 'approve', reason: '' }); await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to grant branch authority');
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
        <h1>Access rules</h1>
        <p className="subtitle">{presets.length} named access presets · {grants.filter((grant) => grant.status === 'active').length} extra branch permissions</p>
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
        <h2>Named access presets ({presets.length})</h2>
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
        <div className="access-section-heading"><div><h2>Extra branch permissions ({grants.filter((g) => g.status === 'active').length})</h2><p className="access-section-hint">Use these only when a person needs authority beyond their named access preset.</p></div><button className="btn btn-sm btn-primary" onClick={() => { setGrantForm({ userId: '', area: BRANCH_AUTHORITY_AREAS[0][0], level: 'approve', reason: '' }); setShowGrantForm(true); }}>Add branch permission</button></div>
        <div className="reports-table-wrapper">
          <table className="reports-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Permission</th>
                <th>Access</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {grants.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center">
                    No extra branch permissions
                  </td>
                </tr>
              ) : (
                grants.map((grant) => (
                  <tr key={grant.id}>
                    <td>{userLabel(grant.user_id)}</td>
                    <td>{BRANCH_AUTHORITY_LABELS[grant.area] ?? accessLabel(grant.area)}</td>
                    <td>
                      <span className="badge">{ACCESS_LEVEL_LABELS[grant.level] ?? grant.level}</span>
                    </td>
                    <td>
                      <span className={`status-badge status-${grant.status}`}>{ACCESS_STATUS_LABELS[grant.status] ?? grant.status}</span>
                    </td>
                    <td>
                      {grant.status === 'active' && (
                        <button className="btn btn-sm btn-danger" onClick={() => { setRevokeGrant(grant); setRevokeReason(''); }}>
                          End access
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
      {showGrantForm && <div className="access-dialog-backdrop"><form className="access-dialog" role="dialog" aria-modal="true" aria-labelledby="grant-branch-authority-title" onSubmit={handleGrant}><h2 id="grant-branch-authority-title">Add branch permission</h2><p>This applies only to the selected operating branch. Corporate payroll and formal disciplinary authority are managed separately.</p><label><span>Staff member</span><select required value={grantForm.userId} onChange={(event) => setGrantForm({ ...grantForm, userId: event.target.value })}><option value="">Select staff member</option>{Object.values(users).filter((user) => user.id !== profile?.id).map((user) => <option value={user.id} key={user.id}>{user.display_name ?? user.email ?? user.id}</option>)}</select></label><label><span>Permission</span><select value={grantForm.area} onChange={(event) => setGrantForm({ ...grantForm, area: event.target.value })}>{BRANCH_AUTHORITY_AREAS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>Access</span><select value={grantForm.level} onChange={(event) => setGrantForm({ ...grantForm, level: event.target.value })}><option value="view">View</option><option value="verify">Verify</option><option value="approve">Approve</option><option value="adjust">Adjust</option><option value="manage">Manage</option></select></label><label><span>Why is this needed?</span><textarea required rows={3} value={grantForm.reason} onChange={(event) => setGrantForm({ ...grantForm, reason: event.target.value })} /></label><div className="access-dialog-actions"><button type="button" onClick={() => setShowGrantForm(false)}>Cancel</button><button type="submit" disabled={!grantForm.userId || !grantForm.reason.trim()}>Add permission</button></div></form></div>}
      {revokeGrant && <div className="access-dialog-backdrop"><form className="access-dialog" role="dialog" aria-modal="true" aria-labelledby="revoke-grant-title" onSubmit={handleRevokeGrant}><h2 id="revoke-grant-title">End branch permission</h2><p>{userLabel(revokeGrant.user_id)} · {BRANCH_AUTHORITY_LABELS[revokeGrant.area] ?? accessLabel(revokeGrant.area)} · {ACCESS_LEVEL_LABELS[revokeGrant.level] ?? accessLabel(revokeGrant.level)}</p><label><span>Reason for ending access</span><textarea required rows={3} value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} /></label><div className="access-dialog-actions"><button type="button" onClick={() => setRevokeGrant(null)}>Cancel</button><button type="submit" className="is-danger" disabled={!revokeReason.trim()}>End access</button></div></form></div>}
    </div>
  );
};

export default AccessControlPage;
