/**
 * OfficerCredentialsPage.tsx (Officer module: 'credentials')
 *
 * Canonical schema: staff_credentials (staff_id, credential_type, expiry_date,
 * verified). Officer-scoped read-only view of own credentials.
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface Credential {
  id: string;
  credential_type: string;
  credential_number: string | null;
  issuing_authority: string | null;
  expiry_date: string | null;
  verified: boolean;
}

const isExpiringSoon = (expiryDate: string | null) => {
  if (!expiryDate) return false;
  const days = (new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return days <= 30;
};

const OfficerCredentialsPage: React.FC = () => {
  const { profile } = useAuth();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: staff_credentials
  useEffect(() => {
    const load = async () => {
      if (!profile?.id) return;
      try {
        setLoading(true);
        setError(null);

        const { data, error: err } = await supabase
          .from('staff_credentials')
          .select('id, credential_type, credential_number, issuing_authority, expiry_date, verified')
          .eq('staff_id', profile.id)
          .order('expiry_date', { ascending: true });

        if (err) throw err;
        setCredentials((data as Credential[]) || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load credentials');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [profile?.id]);

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading credentials...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Credentials</h1>
        <p className="subtitle">{credentials.length} on file</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="contacts-list">
        {credentials.length === 0 ? (
          <div className="empty-state">
            <p>No credentials on file.</p>
          </div>
        ) : (
          credentials.map((c) => (
            <div key={c.id} className="contact-card">
              <div className="contact-header">
                <h3>{c.credential_type}</h3>
                <span className={`status-badge status-${c.verified ? 'active' : 'inactive'}`}>
                  {c.verified ? 'Verified' : 'Unverified'}
                </span>
              </div>
              <div className="contact-details">
                {c.credential_number && <p>{c.credential_number}</p>}
                {c.issuing_authority && <p className="contact-meta">{c.issuing_authority}</p>}
                <p className={isExpiringSoon(c.expiry_date) ? 'severity-badge severity-high' : 'contact-meta'}>
                  {c.expiry_date ? `Expires ${new Date(c.expiry_date).toLocaleDateString()}` : 'No expiry'}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerCredentialsPage;
