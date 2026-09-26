import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ContactRound, Filter, History, MailPlus, MoreHorizontal, RefreshCw, Search, ShieldCheck, UserCheck, UserMinus, Users, X } from 'lucide-react';
import { useAuth, type AppRole } from '../context/AuthContext';
import { getAssignableRoles, IDENTITY_ROLE_LABEL } from '../lib/identityRoles';
import { supabase } from '../lib/supabase';
import { UserIdentityWorkspace, type ManagedUserIdentity, type UserAccessPreset, type UserPresetAssignment, type UserSpineReadiness } from '../components/UserIdentityWorkspace';
import { IdentityRecordsWorkspace } from '../components/IdentityRecordsWorkspace';
import './UserManagementPage.css';

interface UserRow {
  id: string;
  display_name: string | null;
  role: AppRole;
  email: string | null;
  phone: string | null;
  module_access: string[];
  deactivated_at: string | null;
  updated_at: string;
}

interface AuditRow {
  id: string;
  target_user_id: string;
  action_type: string;
  performed_by: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

type StatusFilter = 'all' | 'active' | 'deactivated';
type LifecycleAction = 'deactivate' | 'reactivate';

const UserManagementPage: React.FC = () => {
  const { profile, operatingOrganizationId, operatingOrganizations } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: '', displayName: '', role: 'officer' as AppRole, employmentType: 'permanent', presetKey: '' });
  const [lifecycle, setLifecycle] = useState<{ user: UserRow; action: LifecycleAction } | null>(null);
  const [reason, setReason] = useState('');
  const [presets, setPresets] = useState<UserAccessPreset[]>([]);
  const [assignments, setAssignments] = useState<UserPresetAssignment[]>([]);
  const [readiness, setReadiness] = useState<UserSpineReadiness[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserRow | null>(null);
  const [showIdentityRecords, setShowIdentityRecords] = useState(false);

  const assignableRoles = useMemo(() => getAssignableRoles(profile?.role ?? 'unknown'), [profile?.role]);
  const directInviteRoles = useMemo(() => assignableRoles.filter((role) => !['officer', 'admin_officer'].includes(role)), [assignableRoles]);
  const canManageIdentityRecords = ['grand_master', 'master', 'admin'].includes(profile?.role ?? 'unknown');

  const loadIdentity = useCallback(async () => {
    const operatingBranchId = operatingOrganizationId ?? profile?.organizationId;
    if (!operatingBranchId || !profile?.organizationId) return;
    const operatingContext = operatingOrganizations.find((context) => context.organizationId === operatingBranchId);
    if (operatingContext && !['branch_authorisation', 'organisation_home', 'corporate_oversight'].includes(operatingContext.authorityBasis)) {
      setError('Select an organisation or branch you can operate to manage its people.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    // get_manageable_user_identities serves the organisation itself (its own people) and branches (authorised people).
    try {
      const [usersResponse, auditResponse, presetResponse, assignmentResponse, readinessResponse] = await Promise.all([
        supabase.rpc('get_manageable_user_identities', { p_operating_organization_id: operatingBranchId }),
        supabase
          .from('user_management_audit')
          .select('id, target_user_id, action_type, performed_by, metadata, created_at')
          .order('created_at', { ascending: false })
          .limit(30),
        supabase.from('access_presets').select('id,key,name,role').or(`organization_id.eq.${profile.organizationId},is_system.eq.true`),
        supabase.from('preset_assignments').select('id,user_id,preset_id,status').eq('scope_org_id', profile.organizationId).eq('status', 'active'),
        supabase.rpc('get_user_spine_readiness', { p_organization_id: profile.organizationId }),
      ]);
      if (usersResponse.error) throw usersResponse.error;
      if (auditResponse.error) throw auditResponse.error;
      if (presetResponse.error) throw presetResponse.error;
      if (assignmentResponse.error) throw assignmentResponse.error;
      if (readinessResponse.error) throw readinessResponse.error;
      setUsers((usersResponse.data as UserRow[]) ?? []);
      setAuditRows((auditResponse.data as AuditRow[]) ?? []);
      setPresets((presetResponse.data as UserAccessPreset[]) ?? []);
      setAssignments((assignmentResponse.data as UserPresetAssignment[]) ?? []);
      setReadiness((readinessResponse.data as UserSpineReadiness[]) ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Identity records could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [operatingOrganizationId, operatingOrganizations, profile?.organizationId]);

  useEffect(() => {
    void loadIdentity();
  }, [loadIdentity]);

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    return users.filter((user) => {
      const matchesStatus = statusFilter === 'all' || (statusFilter === 'active' ? !user.deactivated_at : Boolean(user.deactivated_at));
      const matchesSearch = !term || [user.display_name, user.email, user.role].some((value) => value?.toLowerCase().includes(term));
      return matchesStatus && matchesSearch;
    });
  }, [search, statusFilter, users]);

  const inviteUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile?.organizationId || !directInviteRoles.includes(inviteForm.role)) return;
    setBusyId('invite');
    setError(null);
    setNotice(null);
    try {
      const { error: invokeError } = await supabase.functions.invoke('create-user', {
        body: {
          email: inviteForm.email.trim(),
          display_name: inviteForm.displayName.trim(),
          role: inviteForm.role,
          organization_id: profile.organizationId,
          staff: ['officer', 'admin_officer'].includes(inviteForm.role) ? { employment_type: inviteForm.employmentType } : undefined,
          access_preset_key: ['grand_master', 'master', 'admin', 'admin_officer'].includes(inviteForm.role) ? inviteForm.presetKey || undefined : undefined,
        },
      });
      if (invokeError) throw invokeError;
      setNotice(`Invitation sent to ${inviteForm.email.trim()}.`);
      setInviteForm({ email: '', displayName: '', role: directInviteRoles[0] ?? 'client_viewer', employmentType: 'permanent', presetKey: '' });
      setShowInvite(false);
      await loadIdentity();
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : 'The invitation could not be sent.');
    } finally {
      setBusyId(null);
    }
  };

  const resendInvite = async (user: UserRow) => {
    setBusyId(user.id);
    setError(null);
    setNotice(null);
    try {
      const { error: invokeError } = await supabase.functions.invoke('resend-invite', { body: { user_id: user.id } });
      if (invokeError) throw invokeError;
      setNotice(`Invitation resent to ${user.email ?? user.display_name ?? 'the selected user'}.`);
      await loadIdentity();
    } catch (resendError) {
      setError(resendError instanceof Error ? resendError.message : 'The invitation could not be resent.');
    } finally {
      setBusyId(null);
    }
  };

  const submitLifecycle = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!lifecycle || lifecycle.user.id === profile?.id) return;
    if (lifecycle.action === 'deactivate' && !reason.trim()) {
      setError('A deactivation reason is required for the audit trail.');
      return;
    }
    setBusyId(lifecycle.user.id);
    setError(null);
    setNotice(null);
    try {
      const { error: invokeError } = await supabase.functions.invoke('deactivate-user', {
        body: { user_id: lifecycle.user.id, action: lifecycle.action, reason: reason.trim() || undefined },
      });
      if (invokeError) throw invokeError;
      setNotice(`${lifecycle.user.display_name ?? lifecycle.user.email ?? 'User'} ${lifecycle.action === 'deactivate' ? 'deactivated' : 'reactivated'}.`);
      setLifecycle(null);
      setReason('');
      await loadIdentity();
    } catch (lifecycleError) {
      setError(lifecycleError instanceof Error ? lifecycleError.message : `The account could not be ${lifecycle.action}d.`);
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = users.filter((user) => !user.deactivated_at).length;
  const deactivatedCount = users.length - activeCount;

  return (
    <div className="identity-page">
      <header className="identity-heading">
        <div><span>Administration</span><h1>Identity and access</h1><p>Manage staff identity and access for the selected operating branch.</p></div>
        <div className="identity-heading-actions">{canManageIdentityRecords && <button type="button" onClick={() => setShowIdentityRecords(true)}><ContactRound size={17} /> Identity records</button>}<button type="button" className="identity-invite-button" onClick={() => setShowInvite((open) => !open)}><MailPlus size={17} /> Invite user</button></div>
      </header>

      <section className="identity-summary" aria-label="Account summary">
        <div><Users size={18} /><span>Total accounts</span><strong>{users.length}</strong></div>
        <div><UserCheck size={18} /><span>Active</span><strong>{activeCount}</strong></div>
        <div><UserMinus size={18} /><span>Deactivated</span><strong>{deactivatedCount}</strong></div>
        <div><ShieldCheck size={18} /><span>Your authority</span><strong>{profile ? IDENTITY_ROLE_LABEL[profile.role] : 'Unknown'}</strong></div>
      </section>

      {error && <div className="identity-message is-error" role="alert"><AlertTriangle size={17} /> <span>{error}</span><button type="button" onClick={() => setError(null)} title="Dismiss"><X size={16} /></button></div>}
      {notice && <div className="identity-message is-success" role="status"><CheckCircle2 size={17} /> <span>{notice}</span><button type="button" onClick={() => setNotice(null)} title="Dismiss"><X size={16} /></button></div>}

      {showInvite && (
        <form className="identity-invite-form" onSubmit={inviteUser}>
          <div className="identity-panel-heading"><div><span>Provision account</span><h2>Invite a user</h2></div><button type="button" onClick={() => setShowInvite(false)} title="Close invite form"><X size={18} /></button></div>
          <div className="identity-form-grid">
            <label><span>Display name</span><input required value={inviteForm.displayName} onChange={(event) => setInviteForm((form) => ({ ...form, displayName: event.target.value }))} /></label>
            <label><span>Email address</span><input type="email" required value={inviteForm.email} onChange={(event) => setInviteForm((form) => ({ ...form, email: event.target.value }))} /></label>
            <label><span>Role</span><select value={inviteForm.role} onChange={(event) => setInviteForm((form) => ({ ...form, role: event.target.value as AppRole }))}>{directInviteRoles.map((role) => <option value={role} key={role}>{IDENTITY_ROLE_LABEL[role]}</option>)}</select></label>
            {['grand_master', 'master', 'admin', 'admin_officer'].includes(inviteForm.role) && <label><span>Access preset</span><select value={inviteForm.presetKey} onChange={(event) => setInviteForm((form) => ({ ...form, presetKey: event.target.value }))}><option value="">Assign after invitation</option>{presets.map((preset) => <option value={preset.key} key={preset.id}>{preset.name}</option>)}</select></label>}
          </div>
          <div className="identity-form-footer"><span>Field staff are provisioned through Recruitment after offer acceptance.</span><button type="submit" disabled={busyId === 'invite'}>{busyId === 'invite' ? <RefreshCw size={16} className="is-spinning" /> : <MailPlus size={16} />}{busyId === 'invite' ? 'Sending' : 'Send invitation'}</button></div>
        </form>
      )}

      <div className="identity-layout">
        <section className="identity-directory">
          <div className="identity-panel-heading"><div><span>Directory</span><h2>Branch staff access</h2></div><button type="button" onClick={() => void loadIdentity()} disabled={loading} title="Refresh identity records"><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /></button></div>
          <div className="identity-toolbar">
            <label><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, email, or role" /></label>
            <label><Filter size={15} /><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}><option value="all">All statuses</option><option value="active">Active</option><option value="deactivated">Deactivated</option></select></label>
          </div>

          {loading ? <div className="identity-empty"><RefreshCw size={20} className="is-spinning" /> Loading accounts</div> : filteredUsers.length === 0 ? <div className="identity-empty"><Users size={20} /> No accounts match this view</div> : (
            <div className="identity-user-list">
              {filteredUsers.map((user) => {
                const self = user.id === profile?.id;
                return (
                  <article key={user.id} className={user.deactivated_at ? 'is-deactivated' : ''}>
                    <span className="identity-avatar">{(user.display_name ?? user.email ?? '?').slice(0, 2).toUpperCase()}</span>
                    <div className="identity-user-primary"><strong>{user.display_name ?? 'Unnamed user'}{self && <em>You</em>}</strong><small>{user.email ?? 'No email recorded'}</small></div>
                    <span className="identity-role">{IDENTITY_ROLE_LABEL[user.role] ?? user.role}</span>
                    <span className={`identity-status ${user.deactivated_at ? 'is-off' : 'is-on'}`}>{user.deactivated_at ? 'Deactivated' : 'Active'}</span>
                    <div className="identity-actions">
                      <button type="button" disabled={busyId === user.id} onClick={() => void resendInvite(user)} title="Resend invitation"><MailPlus size={16} /><span>Resend</span></button>
                      <button type="button" disabled={self || busyId === user.id} onClick={() => { setLifecycle({ user, action: user.deactivated_at ? 'reactivate' : 'deactivate' }); setReason(''); }} title={self ? 'You cannot change your own lifecycle state' : user.deactivated_at ? 'Reactivate account' : 'Deactivate account'}>{user.deactivated_at ? <UserCheck size={16} /> : <UserMinus size={16} />}<span>{user.deactivated_at?'Reactivate':'Deactivate'}</span></button>
                      <button type="button" onClick={() => setSelectedUser(user)} title="Manage identity and access"><MoreHorizontal size={16} /><span>Manage access</span></button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="identity-audit">
          <div className="identity-panel-heading"><div><span>Audit trail</span><h2>Recent activity</h2></div><History size={19} /></div>
          {auditRows.length === 0 ? <div className="identity-empty"><History size={20} /> No identity activity recorded</div> : (
            <div className="identity-audit-list">{auditRows.map((row) => <AuditEvent row={row} users={users} key={row.id} />)}</div>
          )}
        </aside>
      </div>

      {lifecycle && (
        <div className="identity-dialog-backdrop" role="presentation">
          <form className="identity-dialog" onSubmit={submitLifecycle} role="dialog" aria-modal="true" aria-labelledby="lifecycle-title">
            <div className="identity-panel-heading"><div><span>Account lifecycle</span><h2 id="lifecycle-title">{lifecycle.action === 'deactivate' ? 'Deactivate account' : 'Reactivate account'}</h2></div><button type="button" onClick={() => setLifecycle(null)} title="Close"><X size={18} /></button></div>
            <p>{lifecycle.action === 'deactivate' ? 'The account will lose application access. Existing records and audit history are retained.' : 'The account will regain access under its existing role and organisation scope.'}</p>
            <strong>{lifecycle.user.display_name ?? lifecycle.user.email}</strong>
            {lifecycle.action === 'deactivate' && <label><span>Reason for deactivation</span><textarea required rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required for the audit trail" /></label>}
            <div className="identity-dialog-actions"><button type="button" onClick={() => setLifecycle(null)}>Cancel</button><button type="submit" className={lifecycle.action === 'deactivate' ? 'is-danger' : 'is-primary'} disabled={busyId === lifecycle.user.id}>{busyId === lifecycle.user.id ? 'Saving' : lifecycle.action === 'deactivate' ? 'Deactivate account' : 'Reactivate account'}</button></div>
          </form>
        </div>
      )}
      {selectedUser && <UserIdentityWorkspace user={selectedUser as ManagedUserIdentity} callerRole={profile?.role ?? 'unknown'} presets={presets} assignment={assignments.find((assignment) => assignment.user_id === selectedUser.id) ?? null} readiness={readiness.find((row) => row.user_id === selectedUser.id) ?? null} branches={operatingOrganizations} onClose={() => setSelectedUser(null)} onChanged={async () => { await loadIdentity(); }} />}
      {canManageIdentityRecords && showIdentityRecords && profile?.id && (operatingOrganizationId ?? profile.organizationId) && <IdentityRecordsWorkspace organizationId={(operatingOrganizationId ?? profile.organizationId) as string} userId={profile.id} onClose={() => setShowIdentityRecords(false)} />}
    </div>
  );
};

function AuditEvent({ row, users }: { row: AuditRow; users: UserRow[] }) {
  const target = users.find((user) => user.id === row.target_user_id);
  const actor = users.find((user) => user.id === row.performed_by);
  return (
    <article><span className="identity-audit-mark" /><div><strong>{row.action_type.replace(/_/g, ' ')}</strong><small>{target?.display_name ?? String(row.metadata?.display_name ?? 'User')} · by {actor?.display_name ?? 'Authorised administrator'}</small>{typeof row.metadata?.reason === 'string' && <p>{row.metadata.reason}</p>}</div><time dateTime={row.created_at}>{new Date(row.created_at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></article>
  );
}

export default UserManagementPage;