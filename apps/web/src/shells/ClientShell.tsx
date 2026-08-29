/**
 * ClientShell.tsx — Client portal shell
 *
 * Provides the client-facing interface for viewing field compliance reports,
 * observations, and incident summaries related to their sites.
 *
 * Roles: client_admin, client_officer, client_viewer
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function ClientShell() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  if (!profile) {
    return <div style={{ padding: 32, textAlign: 'center' }}>Loading...</div>;
  }

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <div style={styles.root}>
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logo}>
          <div style={styles.logoBg}>FC</div>
        </div>

        <nav style={styles.nav}>
          <NavItem label="Dashboard" icon="📊" onClick={() => navigate('/client')} />
          <NavItem label="My Sites" icon="📍" onClick={() => navigate('/client/sites')} />
          <NavItem label="Observations" icon="👁️" onClick={() => navigate('/client/observations')} />
          <NavItem label="Incidents" icon="⚠️" onClick={() => navigate('/client/incidents')} />
          <NavItem label="Reports" icon="📋" onClick={() => navigate('/client/reports')} />
        </nav>

        <button onClick={handleSignOut} style={styles.signOutBtn}>
          {sidebarCollapsed ? '⎋' : 'Sign out'}
        </button>
      </aside>

      {/* Main content */}
      <div style={styles.main}>
        <header style={styles.topBar}>
          <span style={styles.orgName}>Client Portal</span>
          <span style={styles.userName}>{profile.displayName}</span>
        </header>

        <main style={styles.content}>
          <div style={styles.placeholder}>
            <div style={styles.placeholderIcon}>👋</div>
            <div style={styles.placeholderTitle}>Welcome to Field Compliance</div>
            <p style={styles.placeholderText}>
              Select an option from the menu to view your compliance data.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

function NavItem({ label, icon, onClick }: {
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={styles.navItem}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'rgba(158,158,158,0.1)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      <span style={styles.navIcon}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    height: '100vh',
    background: 'var(--color-bg-primary)',
    color: 'var(--color-text-primary)',
  },
  sidebar: {
    width: 240,
    background: 'var(--color-bg-surface)',
    borderRight: '1px solid rgba(158,158,158,0.15)',
    display: 'flex',
    flexDirection: 'column',
    padding: '16px 0',
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    marginBottom: '16px',
  },
  logoBg: {
    width: 40,
    height: 40,
    background: '#1976d2',
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    fontWeight: 600,
    color: 'white',
  },
  nav: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '0 12px',
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 16px',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-primary)',
    cursor: 'pointer',
    fontSize: 14,
    borderRadius: 6,
    transition: 'background 200ms',
    textAlign: 'left',
  },
  navIcon: {
    fontSize: 18,
    flexShrink: 0,
  },
  signOutBtn: {
    margin: '12px',
    padding: '10px',
    background: 'transparent',
    border: '1px solid rgba(158,158,158,0.2)',
    borderRadius: 6,
    color: 'var(--color-text-primary)',
    cursor: 'pointer',
    fontSize: 14,
    transition: 'background 200ms',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  topBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    borderBottom: '1px solid rgba(158,158,158,0.15)',
    background: 'var(--color-bg-surface)',
  },
  orgName: {
    fontSize: 16,
    fontWeight: 600,
  },
  userName: {
    fontSize: 14,
    color: 'var(--color-text-secondary)',
  },
  content: {
    flex: 1,
    padding: '24px',
    overflow: 'auto',
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 300,
    textAlign: 'center',
  },
  placeholderIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  placeholderTitle: {
    fontSize: 20,
    fontWeight: 600,
    marginBottom: 8,
  },
  placeholderText: {
    color: 'var(--color-text-secondary)',
    fontSize: 14,
  },
};
