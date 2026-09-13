import { useState } from 'react';
import { CheckCircle2, Send } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './CrmAgreementReportingPanel.css';

type Capability = 'reporting' | 'finance';

interface InviteRecord {
  capability: Capability;
  email: string;
  token: string;
  expiresAt: string;
}

export function CrmCapabilityShareInvites({ agreementId }: { agreementId: string }) {
  const [capability, setCapability] = useState<Capability>('reporting');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<InviteRecord | null>(null);

  const send = async () => {
    setSending(true); setError(null); setSent(null);
    const { data, error: inviteError } = await supabase.functions.invoke('send-capability-share-invite', {
      body: { service_agreement_id: agreementId, capability, email: email.trim() },
    });
    if (inviteError || !data?.invite) setError(inviteError?.message ?? data?.error ?? 'The invite could not be created.');
    else {
      const invite = data.invite as { email: string; expires_at: string };
      setSent({
        capability,
        email: invite.email,
        token: data.email_sent ? '' : (data.accept_url as string),
        expiresAt: invite.expires_at,
      });
      setEmail('');
    }
    setSending(false);
  };

  return <section className="agreement-reporting" aria-label="Client capability sharing">
    <div className="agreement-section-heading"><div><h3>Client sharing</h3><p>Invite the client to see reporting or finance without accepting the whole operational agreement. The client accepts the invite independently to unlock only that capability.</p></div></div>
    {error && <div className="agreement-setup-message is-error" role="alert">{error}</div>}
    {sent && <div className="agreement-setup-message is-success" role="status"><CheckCircle2 size={15} />{sent.token ? <>Invite created for {sent.email} ({sent.capability}). Email delivery is not configured — share this link manually: <code>{sent.token}</code></> : <>Invite emailed to {sent.email} for {sent.capability}.</>} (expires {new Date(sent.expiresAt).toLocaleDateString('en-NZ')}).</div>}
    <article>
      <div>
        <strong>Share a capability</strong>
        <span>The client's own acceptance enables only the chosen capability, nothing else.</span>
      </div>
      <label><span>Capability</span><select value={capability} onChange={(event) => setCapability(event.target.value as Capability)}><option value="reporting">Reporting</option><option value="finance">Finance</option></select></label>
      <label><span>Client email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="client-contact@example.com" /></label>
      <button type="button" disabled={sending || !email.trim()} onClick={() => void send()}><Send size={15} />{sending ? 'Sending' : 'Send invite'}</button>
    </article>
  </section>;
}
