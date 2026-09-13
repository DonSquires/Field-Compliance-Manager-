import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import LoginPage from './LoginPage';
import './PublicDisputePage.css';

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
    <div className="dispute-page">
      <div className="dispute-card">
        <h1>Accept shared access</h1>
        {status === 'accepted' ? (
          <p role="status"><CheckCircle2 size={18} /> Access accepted{agreementName ? ` for ${agreementName}` : ''}. You can now view the shared information in your client portal.</p>
        ) : (
          <>
            <p>A provider has invited you to view a specific shared capability (reporting or finance) without accepting a full operational agreement.</p>
            {error && <p role="alert"><ShieldAlert size={18} /> {error}</p>}
            <button type="button" disabled={status === 'accepting' || !token} onClick={() => void accept()}>
              {status === 'accepting' ? 'Accepting…' : 'Accept shared access'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
