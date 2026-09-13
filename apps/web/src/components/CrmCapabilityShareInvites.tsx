import { useState } from 'react';
import { CheckCircle2, Copy, Mail, Send } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './CrmAgreementReportingPanel.css';

type Capability = 'reporting' | 'finance';

interface InviteReceipt {
  capability: Capability;
  email: string;
  expiresAt: string;
  emailSent: boolean;
  acceptUrl: string | null;
}

export function CrmCapabilityShareInvites({ agreementId }: { agreementId: string }) {
  const [capability, setCapability] = useState<Capability>('reporting');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<InviteReceipt | null>(null);
  const [copied, setCopied] = useState(false);

  const send = async () => {
    setSending(true); setError(null); setSent(null); setCopied(false);
    const { data, error: inviteError } = await supabase.functions.invoke('send-capability-share-invite', {
      body: { service_agreement_id: agreementId, capability, email: email.trim() },
    });
    if (inviteError || !data?.invite) setError(inviteError?.message ?? data?.error ?? 'The invite could not be created.');
    else {
      const invite = data.invite as { email: string; expires_at: string };
      setSent({
        capability,
        email: invite.email,
        expiresAt: invite.expires_at,
        emailSent: Boolean(data.email_sent),
        acceptUrl: data.email_sent ? null : (data.accept_url as string),
      });
      setEmail('');
    }
    setSending(false);
  };

  const copyLink = async () => {
    if (!sent?.acceptUrl) return;
    await navigator.clipboard.writeText(sent.acceptUrl);
    setCopied(true);
  };

  return <section className="agreement-reporting" aria-label="Client capability sharing">
    <div className="agreement-section-heading"><div><h3>Client sharing</h3><p>Invite the client to see reporting or finance without accepting the whole operational agreement. The client accepts the invite independently to unlock only that capability.</p></div></div>
    {error && <div className="agreement-setup-message is-error" role="alert">{error}</div>}
    {sent && (
      <div className="agreement-setup-message is-success" role="status">
        <div><CheckCircle2 size={15} aria-hidden="true" /> <strong>{sent.capability === 'reporting' ? 'Reporting' : 'Finance'} sharing invite sent to {sent.email}.</strong></div>
        <p>Expires {new Date(sent.expiresAt).toLocaleDateString('en-NZ')}. The client unlocks only {sent.capability} when they accept — nothing else on this agreement changes.</p>
        {sent.emailSent ? (
          <p><Mail size={14} aria-hidden="true" /> Delivered by email to {sent.email}.</p>
        ) : (
          <div>
            <p>Email delivery is not configured for this platform — share this link with the client directly:</p>
            <div>
              <code>{sent.acceptUrl}</code>
              <button type="button" onClick={() => void copyLink()}><Copy size={14} aria-hidden="true" /> {copied ? 'Copied' : 'Copy link'}</button>
            </div>
          </div>
        )}
      </div>
    )}
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
