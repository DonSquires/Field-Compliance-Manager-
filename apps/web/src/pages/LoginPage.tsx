import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';

const LoginPage: React.FC = () => {
  const { signInWithPassword, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setLocalError(null);

    const { error: signInError } = await signInWithPassword(email, password);
    if (signInError) setLocalError(signInError);
    setSubmitting(false);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        backgroundColor: 'var(--color-bg-primary, #020617)',
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: '320px',
          padding: '32px',
          borderRadius: '12px',
          backgroundColor: 'var(--color-bg-secondary, #0f172a)',
          border: '1px solid var(--color-border, #334155)',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: '20px', color: 'var(--color-text-primary, #e2e8f0)' }}>
            Field Compliance Manager
          </h1>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--color-text-secondary, #94a3b8)' }}>
            Sign in to continue
          </p>
        </div>

        {(localError || error) && (
          <div style={{ fontSize: '13px', color: '#EF5350' }}>{localError || error}</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={{ fontSize: '13px', color: 'var(--color-text-secondary, #94a3b8)' }}>Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--color-border, #334155)' }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={{ fontSize: '13px', color: 'var(--color-text-secondary, #94a3b8)' }}>Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--color-border, #334155)' }}
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: '10px 12px',
            borderRadius: '6px',
            border: 'none',
            backgroundColor: 'var(--color-primary, #1d4ed8)',
            color: 'white',
            fontWeight: 600,
            cursor: submitting ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  );
};

export default LoginPage;
