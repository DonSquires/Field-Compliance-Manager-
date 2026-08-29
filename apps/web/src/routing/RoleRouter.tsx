/**
 * RoleRouter.tsx — Role-based portal routing with URL prefix enforcement
 *
 * Source of truth: docs/INSTRUCTION_MANUAL.md §2.3
 *
 * Routes the authenticated user to the correct portal based on their role:
 *   - grand_master / master / admin / admin_officer / nzscv_monitor → Admin shell (/admin/*)
 *   - officer → Officer shell (/officer/*)
 *   - scan_operator → Scan shell (/scan)
 *   - client_admin / client_officer / client_viewer → Client shell (/client/*)
 *
 * Admin officers see a portal selection screen.
 * URL prefix is enforced: if the URL doesn't match the role, <Navigate> redirects.
 */

import React, { useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AdminShell from '../shells/AdminShell';
import OfficerShell from '../shells/OfficerShell';
import { ClientShell } from '../shells/ClientShell';
import { ScanShell } from '../shells/ScanShell';

const PORTAL_CHOICE_KEY = 'fcm.admin_officer.portal';
type PortalChoice = 'admin' | 'field';

export function RoleRouter() {
  const { profile, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [portalChoice, setPortalChoice] = useState<PortalChoice | null>(
    () => (sessionStorage.getItem(PORTAL_CHOICE_KEY) as PortalChoice | null),
  );

  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-primary)' }}>Loading...</div>;

  if (!profile) return null;

  const { role } = profile;

  function choosePortal(choice: PortalChoice | null) {
    if (choice) sessionStorage.setItem(PORTAL_CHOICE_KEY, choice);
    else sessionStorage.removeItem(PORTAL_CHOICE_KEY);
    setPortalChoice(choice);
    if (choice === 'admin') navigate('/admin', { replace: true });
    else if (choice === 'field') navigate('/officer', { replace: true });
  }

  let expectedPrefix: string;

  if (role === 'admin_officer') {
    if (!portalChoice) {
      return (
        <PortalSelector
          officerName={profile.displayName ?? 'Officer'}
          onChoose={choosePortal}
        />
      );
    }
    expectedPrefix = portalChoice === 'admin' ? '/admin' : '/officer';
  } else if (role === 'scan_operator') {
    expectedPrefix = '/scan';
  } else if (
    role === 'grand_master' ||
    role === 'master' ||
    role === 'admin' ||
    role === 'nzscv_monitor'
  ) {
    expectedPrefix = '/admin';
  } else if (role === 'officer') {
    expectedPrefix = '/officer';
  } else if (
    role === 'client_admin' ||
    role === 'client_officer' ||
    role === 'client_viewer'
  ) {
    expectedPrefix = '/client';
  } else {
    return (
      <div style={{ padding: 32, color: 'var(--color-text-primary)' }}>
        Unknown role: {role}. Contact your administrator.
      </div>
    );
  }

  const path = location.pathname;
  if (!path.startsWith(expectedPrefix)) {
    return <Navigate to={expectedPrefix} replace />;
  }

  if (expectedPrefix === '/admin') {
    return (
      <Routes>
        <Route path="/admin" element={<AdminShell />} />
        <Route path="/admin/:page" element={<AdminShell />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    );
  }

  if (expectedPrefix === '/officer') {
    return (
      <Routes>
        <Route path="/officer" element={<OfficerShell />} />
        <Route path="/officer/:module" element={<OfficerShell />} />
        <Route path="*" element={<Navigate to="/officer" replace />} />
      </Routes>
    );
  }

  if (expectedPrefix === '/scan') {
    return (
      <Routes>
        <Route path="/scan" element={<ScanShell />} />
        <Route path="*" element={<Navigate to="/scan" replace />} />
      </Routes>
    );
  }

  if (expectedPrefix === '/client') {
    return (
      <Routes>
        <Route path="/client" element={<ClientShell />} />
        <Route path="/client/*" element={<ClientShell />} />
        <Route path="*" element={<Navigate to="/client" replace />} />
      </Routes>
    );
  }

  return null;
}

/** Portal chooser shown to admin_officer at login. */
function PortalSelector({ officerName, onChoose }: {
  officerName: string;
  onChoose: (choice: 'admin' | 'field') => void;
}) {
  return (
    <div style={ps.page}>
      <div style={ps.card}>
        <div style={ps.title}>Welcome, {officerName.split(' ')[0]}</div>
        <div style={ps.hint}>You have dual access. Choose how you want to work right now.</div>
        <div style={ps.grid}>
          <button type="button" style={ps.choice} onClick={() => onChoose('admin')}>
            <div style={ps.choiceIcon}>⊞</div>
            <div style={ps.choiceLabel}>Admin Portal</div>
            <div style={ps.choiceSub}>Org setup, reports, compliance</div>
          </button>
          <button type="button" style={ps.choice} onClick={() => onChoose('field')}>
            <div style={ps.choiceIcon}>📍</div>
            <div style={ps.choiceLabel}>Field Portal</div>
            <div style={ps.choiceSub}>Dispatch, patrols, observations</div>
          </button>
        </div>
      </div>
    </div>
  );
}

const ps = {
  page: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: 'var(--color-bg-primary)',
    padding: 16,
  } as React.CSSProperties,
  card: {
    background: 'var(--color-bg-surface)',
    borderRadius: 12,
    padding: 40,
    maxWidth: 500,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  } as React.CSSProperties,
  title: {
    fontSize: 28,
    fontWeight: 600,
    marginBottom: 8,
    color: 'var(--color-text-primary)',
  } as React.CSSProperties,
  hint: {
    fontSize: 14,
    color: 'var(--color-text-secondary)',
    marginBottom: 32,
  } as React.CSSProperties,
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 16,
  } as React.CSSProperties,
  choice: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 12,
    padding: 24,
    border: '1px solid rgba(158,158,158,0.2)',
    borderRadius: 8,
    background: 'transparent',
    cursor: 'pointer',
    transition: 'all 200ms',
  } as React.CSSProperties,
  choiceIcon: {
    fontSize: 32,
  } as React.CSSProperties,
  choiceLabel: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
  } as React.CSSProperties,
  choiceSub: {
    fontSize: 12,
    color: 'var(--color-text-secondary)',
    textAlign: 'center',
  } as React.CSSProperties,
};
