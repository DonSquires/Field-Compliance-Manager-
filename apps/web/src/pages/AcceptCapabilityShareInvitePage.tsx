import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import LoginPage from './LoginPage';
import './AcceptCapabilityShareInvitePage.css';

export default function AcceptCapabilityShareInvitePage() {
  const { token = '' } = useParams<{ token: string }>();
  const { hasSession, loading } = useAuth();
  const [status, setStatus] = useState<'idle' | 'accepting' | 'accepted' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [agreementName, setAgreementName] = useState<string | null>(null);

  const accept = async () => {
    setStatus('accepting');
    setError(null);
    const { data, error: acceptError } = await supabase.rpc('accept_client_capability_share', { p_token: token });
    if (acceptError || !data) {
      setError(acceptError?.message ?? 'This invite could not be accepted.');
      setStatus('error');
      return;
    }
    setAgreementName((data as { name?: string }).name ?? null);
    setStatus('accepted');
  };

  if (loading) return <div className="page-container"><p>Loading…</p></div>;
  if (!hasSession) return <LoginPage />;

  return (
    <div className="accept-capability-share">
      <div className="accept-capability-share-card">
        <h1>Accept shared access</h1>
        {status === 'accepted' ? (
          <div className="alert alert-success" role="status"><CheckCircle2 size={18} aria-hidden="true" /> Access accepted{agreementName ? ` for ${agreementName}` : ''}. You can now view the shared information in your client portal.</div>
        ) : (
          <>
            <p>A provider has invited you to view a specific shared capability (reporting or finance) without accepting a full operational agreement.</p>
            {error && <div className="alert alert-error" role="alert"><ShieldAlert size={18} aria-hidden="true" /> {error}</div>}
            <button type="button" disabled={status === 'accepting' || !token} onClick={() => void accept()}>
              {status === 'accepting' ? 'Accepting…' : 'Accept shared access'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
