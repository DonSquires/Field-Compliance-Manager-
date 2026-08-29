/**
 * UserManagementPage.tsx
 *
 * Canonical schema: user_profiles (identity/role, module_access,
 * deactivated_at/by). Provisioning and lifecycle actions are governed writes —
 * routed through edge functions (create-user, deactivate-user, delete-user,
 * resend-invite), not direct table writes, per the approval-required design
 * for consequential account changes.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface UserRow {
  id: string;
  display_name: string | null;
  role: string;
  email: string | null;
  phone: string | null;
  module_access: string[];
  deactivated_at: string | null;
}

const ROLES = [
  'grand_master',
  'master',
  'admin',
  'admin_officer',
  'nzscv_monitor',
  'officer',
  'client_admin',
  'client_officer',
  'client_viewer',
];

const UserManagementPage: React.FC = () => {
  const { profile } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: '', display_name: '', role: 'officer' });

  // ATLAS READS: user_profiles
  const loadUsers = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;

    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('user_profiles')
        .select('id, display_name, role, email, phone, module_access, deactivated_at')
        .eq('organization_id', orgId)
        .order('display_name', { ascending: true });

      if (err) throw err;
      setUsers((data as UserRow[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.organizationId) return;

    try {
      setBusyId('invite');
      setError(null);

      // ATLAS CALLS: create-user
      const { error: fnError } = await supabase.functions.invoke('create-user', {
        body: {
          email: inviteForm.email,
          display_name: inviteForm.display_name,
          role: inviteForm.role,
          organization_id: profile.organizationId,
        },
      });

      if (fnError) throw fnError;

      setInviteForm({ email: '', display_name: '', role: 'officer' });
      setShowInviteForm(false);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite user');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeactivateToggle = async (user: UserRow) => {
    const action = user.deactivated_at ? 'reactivate' : 'deactivate';
    if (!window.confirm(`${action === 'deactivate' ? 'Deactivate' : 'Reactivate'} ${user.display_name || user.email}?`)) {
      return;
    }

    try {
      setBusyId(user.id);
      setError(null);

      // ATLAS CALLS: deactivate-user
      const { error: fnError } = await supabase.functions.invoke('deactivate-user', {
        body: { user_id: user.id, action },
      });

      if (fnError) throw fnError;
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} user`);
    } finally {
      setBusyId(null);
    }
  };

  const handleResendInvite = async (user: UserRow) => {
    try {
      setBusyId(user.id);
      setError(null);

      // ATLAS CALLS: resend-invite
      const { error: fnError } = await supabase.functions.invoke('resend-invite', {
        body: { user_id: user.id },
      });

      if (fnError) throw fnError;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend invite');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (user: UserRow) => {
    if (!window.confirm(`Permanently delete ${user.display_name || user.email}? This cannot be undone.`)) return;

    try {
      setBusyId(user.id);
      setError(null);

      // ATLAS CALLS: delete-user
      const { error: fnError } = await supabase.functions.invoke('delete-user', {
        body: { user_id: user.id },
      });

      if (fnError) throw fnError;
      setUsers(users.filter((u) => u.id !== user.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading users...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container user-management-page">
      <header className="page-header">
        <h1>Users</h1>
        <p className="subtitle">{users.length} accounts in this organisation</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', margin: '12px 0' }}>
        <h2>All Users</h2>
        <button className="btn btn-primary btn-sm" onClick={() => setShowInviteForm(!showInviteForm)}>
          {showInviteForm ? 'Cancel' : '+ Invite User'}
        </button>
      </div>

      {showInviteForm && (
        <form className="new-contact-form" onSubmit={handleInvite}>
          <div className="form-row">
            <div className="form-group">
              <label>Display Name</label>
              <input
                type="text"
                required
                value={inviteForm.display_name}
                onChange={(e) => setInviteForm({ ...inviteForm, display_name: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input
                type="email"
                required
                value={inviteForm.email}
                onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
              />
            </div>
          </div>
          <div className="form-group">
            <label>Role</label>
            <select value={inviteForm.role} onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busyId === 'invite'}>
            {busyId === 'invite' ? 'Sending invite…' : 'Send Invite'}
          </button>
        </form>
      )}

      <div className="contacts-list">
        {users.length === 0 ? (
          <div className="empty-state">
            <p>No users yet.</p>
          </div>
        ) : (
          users.map((user) => (
            <div key={user.id} className="contact-card">
              <div className="contact-header">
                <h3>{user.display_name || user.email || 'Unnamed'}</h3>
                <span className="contact-type-badge">{user.role}</span>
              </div>
              <div className="contact-details">
                <p>{user.email}</p>
                {user.phone && <p>{user.phone}</p>}
                <p className="contact-meta">
                  {user.deactivated_at
                    ? `Deactivated ${new Date(user.deactivated_at).toLocaleDateString()}`
                    : 'Active'}
                  {user.module_access.length > 0 ? ` · direct modules: ${user.module_access.join(', ')}` : ''}
                </p>
              </div>
              <div className="contact-actions">
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={busyId === user.id}
                  onClick={() => handleResendInvite(user)}
                >
                  Resend Invite
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={busyId === user.id}
                  onClick={() => handleDeactivateToggle(user)}
                >
                  {user.deactivated_at ? 'Reactivate' : 'Deactivate'}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busyId === user.id}
                  onClick={() => handleDelete(user)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default UserManagementPage;
