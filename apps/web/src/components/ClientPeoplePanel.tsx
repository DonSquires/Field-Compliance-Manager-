import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, MailPlus, RefreshCw, UserMinus, UserPlus, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './ClientPeoplePanel.css';

interface ClientPerson { id: string; display_name: string | null; email: string | null; role: string; deactivated_at: string | null; created_at: string | null; }
type ClientRole = 'client_viewer' | 'client_officer' | 'client_admin';

export const CLIENT_ROLE_WORDS: Record<ClientRole, { label: string; means: string }> = {
  client_viewer: { label: 'Viewer', means: 'Sees what was delivered, reports and invoices. Cannot change anything.' },
  client_officer: { label: 'Officer', means: 'Everything a viewer sees, plus the day-to-day field records the agreement shares with you.' },
  client_admin: { label: 'Administrator', means: 'Everything above, and can add or remove your people here.' },
};

/** The client administrator's own people: who at the client can sign in, in what role. Provider staff never appear here. */
export function ClientPeoplePanel({ organizationId, currentUserId }: { organizationId: string; currentUserId: string }) {
  const [people, setPeople] = useState<ClientPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', role: 'client_viewer' as ClientRole });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    // ATLAS READS: user_profiles (own organisation only; RLS)
    const { data, error: readError } = await supabase.from('user_profiles').select('id, display_name, email, role, deactivated_at, created_at').eq('organization_id', organizationId).like('role', 'client_%').order('created_at', { ascending: true });
    if (readError) setError(readError.message);
    setPeople((data as ClientPerson[] | null) ?? []);
    setLoading(false);
  }, [organizationId]);
  useEffect(() => { void load(); }, [load]);

  const addPerson = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('add'); setError(null); setNotice(null);
    // ATLAS WRITES: create-user (a client administrator adds client users to their own organisation)
    const { error: inviteError } = await supabase.functions.invoke('create-user', { body: { email: form.email.trim(), display_name: form.name.trim(), role: form.role, organization_id: organizationId } });
    if (inviteError) setError(inviteError.message);
    else { setNotice(`${form.name.trim() || form.email.trim()} has been sent an invitation. They choose their own password from the email.`); setForm({ name: '', email: '', role: 'client_viewer' }); await load(); }
    setBusy(null);
  };

  const resend = async (person: ClientPerson) => {
    setBusy(person.id); setError(null); setNotice(null);
    const { error: resendError } = await supabase.functions.invoke('resend-invite', { body: { user_id: person.id } });
    if (resendError) setError(resendError.message);
    else setNotice(`Invitation sent again to ${person.email ?? person.display_name ?? 'them'}.`);
    setBusy(null);
  };

  const toggleAccess = async (person: ClientPerson) => {
    const action = person.deactivated_at ? 'reactivate' : 'deactivate';
    setBusy(person.id); setError(null); setNotice(null);
    // ATLAS WRITES: deactivate-user (client_admin, own organisation, client roles only)
    const { error: toggleError } = await supabase.functions.invoke('deactivate-user', { body: { user_id: person.id, action } });
    if (toggleError) setError(toggleError.message);
    else { setNotice(action === 'deactivate' ? `${person.display_name ?? person.email} can no longer sign in.` : `${person.display_name ?? person.email} can sign in again.`); await load(); }
    setBusy(null);
  };

  return (
    <section className="client-list-section client-people" aria-labelledby="client-people-title">
      <div className="client-panel-heading"><div><span className="client-kicker">Access</span><h2 id="client-people-title">Who can sign in for your organisation</h2></div><Users size={21} aria-hidden="true" /></div>
      <p className="client-delivery-note">Only your own people appear here. Your service provider's staff never have accounts at your organisation; they see your places through the service agreement.</p>
      {error && <div className="client-inline-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /> {error}</div>}
      {notice && <p className="client-people-notice" role="status"><CheckCircle2 size={16} aria-hidden="true" /> {notice}</p>}

      <form className="client-people-form" onSubmit={addPerson}>
        <label><span>Name</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Full name" required /></label>
        <label><span>Email</span><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="name@yourorganisation.nz" required /></label>
        <label><span>Role</span><select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as ClientRole })}>{(Object.keys(CLIENT_ROLE_WORDS) as ClientRole[]).map((role) => <option key={role} value={role}>{CLIENT_ROLE_WORDS[role].label}</option>)}</select><small>{CLIENT_ROLE_WORDS[form.role].means}</small></label>
        <button type="submit" className="client-people-add" disabled={busy === 'add'}><UserPlus size={16} aria-hidden="true" /> {busy === 'add' ? 'Sending invitation' : 'Add person'}</button>
      </form>

      {loading ? <div className="client-compact-state">Loading your people</div> : (
        <ul className="client-people-list">
          {people.map((person) => {
            const me = person.id === currentUserId;
            const role = CLIENT_ROLE_WORDS[person.role as ClientRole];
            return (
              <li key={person.id} className={person.deactivated_at ? 'is-off' : ''}>
                <div>
                  <strong>{person.display_name ?? person.email ?? 'Unnamed'}{me ? ' (you)' : ''}</strong>
                  <small>{person.email}{role ? ` · ${role.label}` : ''}{person.deactivated_at ? ' · access removed' : ''}</small>
                </div>
                {!me && (
                  <div className="client-people-actions">
                    {!person.deactivated_at && <button type="button" disabled={busy === person.id} onClick={() => void resend(person)} title="Send the invitation email again (only while they have not signed in)"><MailPlus size={15} aria-hidden="true" /> Resend invitation</button>}
                    <button type="button" className={person.deactivated_at ? 'is-restore' : 'is-remove'} disabled={busy === person.id} onClick={() => void toggleAccess(person)}>{person.deactivated_at ? <><RefreshCw size={15} aria-hidden="true" /> Restore access</> : <><UserMinus size={15} aria-hidden="true" /> Remove access</>}</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
