/**
 * ScanShell.tsx — Lightweight scan-operator shell
 *
 * Minimal interface for scan operators who only need to:
 * - Scan QR codes
 * - Enter observations
 * - Submit photos
 *
 * No roster, dispatch, welfare monitoring, or dashboard features.
 * Reference: #150 slice 2
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function ScanShell() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [scanInput, setScanInput] = useState('');

  if (!profile) {
    return <div style={{ padding: 32, textAlign: 'center' }}>Loading...</div>;
  }

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  const handleScan = (e: React.FormEvent) => {
    e.preventDefault();
    if (scanInput.trim()) {
      // TODO: Process scan - look up site/zone from QR code
      console.log('Scanned:', scanInput);
      setScanInput('');
    }
  };

  return (
    <div style={styles.root}>
      {/* Top bar */}
      <header style={styles.topBar}>
        <div style={styles.logo}>ScanOps</div>
        <div style={styles.userInfo}>
          <span>{profile.displayName}</span>
          <button onClick={handleSignOut} style={styles.signOutBtn}>Sign out</button>
        </div>
      </header>

      {/* Main scan interface */}
      <main style={styles.content}>
        <div style={styles.scanContainer}>
          <div style={styles.scanTitle}>QR Code Scanner</div>
          <p style={styles.scanHint}>Point your camera at a QR code or paste a code below</p>

          <form onSubmit={handleScan} style={styles.form}>
            <input
              type="text"
              autoFocus
              placeholder="Scan or paste QR code..."
              value={scanInput}
              onChange={(e) => setScanInput(e.target.value)}
              style={styles.input}
            />
            <button type="submit" style={styles.submitBtn}>
              Scan
            </button>
          </form>

          {/* Quick actions */}
          <div style={styles.actions}>
            <ActionCard icon="📷" label="Take Photo" onClick={() => navigate('/scan/photo')} />
            <ActionCard icon="📝" label="Add Observation" onClick={() => navigate('/scan/observation')} />
            <ActionCard icon="📍" label="Check In" onClick={() => navigate('/scan/checkin')} />
          </div>
        </div>
      </main>
    </div>
  );
}

function ActionCard({ icon, label, onClick }: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={styles.card}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.transform = 'translateY(-4px)';
        (e.currentTarget as HTMLElement).style.boxShadow = '0 8px 16px rgba(0,0,0,0.12)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.transform = 'translateY(0)';
        (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)';
      }}
    >
      <div style={styles.cardIcon}>{icon}</div>
      <div style={styles.cardLabel}>{label}</div>
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: 'var(--color-bg-primary)',
    color: 'var(--color-text-primary)',
  },
  topBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    background: 'var(--color-bg-surface)',
    borderBottom: '1px solid rgba(158,158,158,0.15)',
  },
  logo: {
    fontSize: 18,
    fontWeight: 600,
  },
  userInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    fontSize: 14,
  },
  signOutBtn: {
    padding: '8px 16px',
    background: 'transparent',
    border: '1px solid rgba(158,158,158,0.2)',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  content: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  },
  scanContainer: {
    width: '100%',
    maxWidth: 500,
    textAlign: 'center',
  },
  scanTitle: {
    fontSize: 28,
    fontWeight: 600,
    marginBottom: 8,
  },
  scanHint: {
    color: 'var(--color-text-secondary)',
    marginBottom: 32,
    fontSize: 14,
  },
  form: {
    display: 'flex',
    gap: 8,
    marginBottom: 32,
  },
  input: {
    flex: 1,
    padding: '12px 16px',
    fontSize: 14,
    border: '1px solid rgba(158,158,158,0.3)',
    borderRadius: 6,
    background: 'var(--color-bg-surface)',
    color: 'var(--color-text-primary)',
  },
  submitBtn: {
    padding: '12px 24px',
    background: '#1976d2',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontWeight: 600,
  },
  actions: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 12,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: '24px 16px',
    background: 'var(--color-bg-surface)',
    border: '1px solid rgba(158,158,158,0.15)',
    borderRadius: 8,
    cursor: 'pointer',
    transition: 'all 200ms',
  },
  cardIcon: {
    fontSize: 32,
  },
  cardLabel: {
    fontSize: 14,
    fontWeight: 500,
  },
};
