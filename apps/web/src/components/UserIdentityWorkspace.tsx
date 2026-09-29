import { useState, type FormEvent } from 'react';
import { AlertTriangle, BadgeCheck, BriefcaseBusiness, CheckCircle2, KeyRound, Mail, ShieldCheck, UserRoundCog, X } from 'lucide-react';
import type { AppRole, OperatingOrganization } from '../context/AuthContext';
import { getAssignableRoles, IDENTITY_ROLE_LABEL } from '../lib/identityRoles';
import { supabase } from '../lib/supabase';
import { StaffBranchAccessPanel } from './StaffBranchAccessPanel';
import './UserIdentityWorkspace.css';

export interface ManagedUserIdentity {
  id: string;
  display_name: string | null;
  role: AppRole;
  email: string | null;
  phone: string | null;
  updated_at: string;
  deactivated_at: string | null;
}

export interface UserAccessPreset { id: string; key: string; name: string; role: string | null; }
export interface UserPresetAssignment { id: string; user_id: string; preset_id: string; status: string; }
export interface UserSpineReadiness { user_id: string; identity_status: string; employment_status: string; access_status: string; credential_status: string; work_status: string; blockers: string[]; next_action: string; }

export function UserIdentityWorkspace({ user, callerRole, presets, assignment, readiness, branches, onClose, onChanged }: { user: ManagedUserIdentity; callerRole: AppRole; presets: UserAccessPreset[]; assignment: UserPresetAssignment | null; readiness: UserSpineReadiness | null; branches: OperatingOrganization[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState({ displayName: user.display_name ?? '', phone: user.phone ?? '', role: user.role });
  const [presetId, setPresetId] = useState(assignment?.preset_id ?? '');
  const [identityReason, setIdentityReason] = useState('');
  const [accessReason, setAccessReason] = useState('');
  const [email, setEmail] = useState(user.email ?? '');
  const [emailReason, setEmailReason] = useState('');
  const [saving, setSaving] = useState<'identity' | 'access' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(user.updated_at);
  const [activeAssignment, setActiveAssignment] = useState(assignment);
  const assignableRoles = getAssignableRoles(callerRole);
  const adminTier = ['grand_master', 'master', 'admin', 'admin_officer'].includes(form.role);

  const saveIdentity = async (event: FormEvent) => {
    event.preventDefault(); setSaving('identity'); setError(null); setNotice(null);
    const { data, error: saveError } = await supabase.rpc('manage_user_identity_access', { p_user_id: user.id, p_expected_updated_at: expectedUpdatedAt, p_action: 'update_identity', p_display_name: form.displayName.trim(), p_phone: form.phone.trim() || null, p_role: form.role, p_preset_id: null, p_assignment_id: null, p_grant_id: null, p_reason: identityReason.trim() });
    if (saveError) setError(saveError.message); else { const receipt = data as { updated_at?: string } | null; if (receipt?.updated_at) setExpectedUpdatedAt(receipt.updated_at); setNotice('Identity and role updated with audit history.'); setIdentityReason(''); await onChanged(); }
    setSaving(null);
  };

  /** The sign-in identity lives in auth.users, so this goes through the governed edge function, not the table. */
  const saveEmail = async (event: FormEvent) => {
    event.preventDefault(); setSaving('email'); setError(null); setNotice(null);
    const { data, error: saveError } = await supabase.functions.invoke('update-user-email', { body: { user_id: user.id, email: email.trim(), reason: emailReason.trim() } });
    const receipt = data as { error?: string; email?: string; pending_email?: string; requires_confirmation?: boolean; invitation_resent?: boolean } | null;
    if (saveError || receipt?.error) setError(receipt?.error ?? (saveError instanceof Error ? saveError.message : 'The email address could not be changed.'));
    else if (receipt?.requires_confirmation) { setNotice(`${user.display_name ?? 'This person'} has signed in before, so ${receipt.pending_email} has to be confirmed before it becomes their sign-in address. Until then they keep signing in with ${receipt.email}. Their profile, role and history are unchanged.`); setEmailReason(''); await onChanged(); }
    else { setNotice(receipt?.invitation_resent ? `Email corrected to ${receipt.email}. Their unclaimed invitation was re-sent to the new address.` : `Email corrected to ${receipt?.email ?? email.trim()}. They sign in with it from now on.`); setEmailReason(''); await onChanged(); }
    setSaving(null);
  };

  const saveAccess = async (event: FormEvent) => {
    event.preventDefault(); setSaving('access'); setError(null); setNotice(null);
    const action = presetId ? 'set_preset' : 'clear_preset';
    const { data, error: saveError } = await supabase.rpc('manage_user_identity_access', { p_user_id: user.id, p_expected_updated_at: expectedUpdatedAt, p_action: action, p_display_name: form.displayName.trim(), p_phone: form.phone.trim() || null, p_role: form.role, p_preset_id: presetId || null, p_assignment_id: activeAssignment?.id ?? null, p_grant_id: null, p_reason: accessReason.trim() });
    if (saveError) setError(saveError.message); else { const receipt = data as { updated_at?: string; assignment_id?: string | null } | null; if (receipt?.updated_at) setExpectedUpdatedAt(receipt.updated_at); setActiveAssignment(receipt?.assignment_id ? { id: receipt.assignment_id, user_id: user.id, preset_id: presetId, status: 'active' } : null); setNotice(presetId ? 'Access preset assigned.' : 'Access preset ended.'); setAccessReason(''); await onChanged(); }
    setSaving(null);
  };

  return <div className="user-spine-backdrop"><section className="user-spine-dialog" role="dialog" aria-modal="true" aria-labelledby="user-spine-title">
    <header><div><span>User spine</span><h2 id="user-spine-title">{user.display_name ?? user.email ?? 'User account'}</h2><p>{user.email ?? 'No email recorded'} · {user.deactivated_at ? 'Deactivated' : 'Active'}</p></div><button type="button" onClick={onClose} aria-label="Close user workspace"><X size={18} /></button></header>
    {error && <div className="user-spine-message is-error" role="alert"><AlertTriangle size={16} />{error}</div>}
    {notice && <div className="user-spine-message is-success" role="status"><CheckCircle2 size={16} />{notice}</div>}
    <section className="user-spine-readiness"><div><strong>{readiness?.next_action ?? 'Review user setup'}</strong><span>{readiness?.blockers.length ? `${readiness.blockers.length} setup steps remain` : 'No current blockers'}</span></div><dl><div><dt>Identity</dt><dd>{readiness?.identity_status ?? 'unknown'}</dd></div><div><dt>Employment</dt><dd>{readiness?.employment_status ?? 'unknown'}</dd></div><div><dt>Access</dt><dd>{readiness?.access_status ?? 'unknown'}</dd></div><div><dt>Credential</dt><dd>{readiness?.credential_status ?? 'unknown'}</dd></div><div><dt>Work</dt><dd>{readiness?.work_status ?? 'unknown'}</dd></div></dl>{readiness?.blockers.length ? <ul>{readiness.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : null}</section>
    <div className="user-spine-columns">
      <form onSubmit={saveIdentity}><div className="user-spine-section-title"><UserRoundCog size={18} /><div><strong>Identity and role</strong><span>Canonical name, contact, and application authority.</span></div></div><label><span>Display name</span><input required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label><label><span>Phone</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label><label><span>Role</span><select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as AppRole })}>{assignableRoles.map((role) => <option value={role} key={role}>{IDENTITY_ROLE_LABEL[role]}</option>)}</select></label><label><span>Reason for change</span><textarea required rows={3} value={identityReason} onChange={(event) => setIdentityReason(event.target.value)} placeholder="Why is this identity or role changing?" /></label><button type="submit" disabled={saving !== null || !form.displayName.trim() || !identityReason.trim()}>{saving === 'identity' ? 'Saving' : 'Save identity'}</button></form>
      <form onSubmit={saveAccess}><div className="user-spine-section-title"><KeyRound size={18} /><div><strong>Access preset</strong><span>One named administration access bundle at this organization.</span></div></div>{adminTier ? <><label><span>Preset</span><select value={presetId} onChange={(event) => setPresetId(event.target.value)}><option value="">No active preset</option>{presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select></label><label><span>Reason for access change</span><textarea required rows={3} value={accessReason} onChange={(event) => setAccessReason(event.target.value)} placeholder="Role responsibilities or approval reference" /></label><button type="submit" disabled={saving !== null || !accessReason.trim() || (!presetId && !assignment)}>{saving === 'access' ? 'Saving' : presetId ? 'Assign preset' : 'End preset'}</button></> : <div className="user-spine-not-applicable"><ShieldCheck size={22} /><strong>Role-scoped access</strong><span>Field and client roles use their role, branch authorization, and module scope rather than an administration preset.</span></div>}
      </form>
    </div>
    <form className="user-spine-email" onSubmit={saveEmail}><div className="user-spine-section-title"><Mail size={18} /><div><strong>Email and sign-in</strong><span>The address this person signs in with, and where their invitation is sent.</span></div></div><div className="user-spine-email-grid"><label><span>Email address</span><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label><span>Reason for change</span><input required value={emailReason} onChange={(event) => setEmailReason(event.target.value)} placeholder="Corrected typo, name change, new work address" /></label></div><button type="submit" disabled={saving !== null || !email.trim() || !emailReason.trim() || email.trim().toLowerCase() === (user.email ?? '').toLowerCase()}>{saving === 'email' ? 'Saving' : 'Change email'}</button><small>If they have never signed in, the address is corrected and their invitation re-sent to it. If they have signed in before, the new address must be confirmed before it replaces the old one — their profile, role and history stay as they are.</small></form>
    <StaffBranchAccessPanel userId={user.id} branches={branches} onChanged={onChanged} />
    <footer><span><BriefcaseBusiness size={14} />Employment, credentials, and work readiness remain governed in People &amp; HR.</span><span><BadgeCheck size={14} />Every change requires a reason and is retained in the identity audit trail.</span></footer>
  </section></div>;
}
