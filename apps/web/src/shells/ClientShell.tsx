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
import { ProfessionalNav } from '../components/ProfessionalNav';
import { ProfessionalHeader } from '../components/ProfessionalHeader';

export function ClientShell() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  if (!profile) {
    return <div style={{ padding: 32, textAlign: 'center' }}>Loading...</div>;
  }

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: 'var(--color-bg-primary)' }}>
      {/* Professional Header */}
      <ProfessionalHeader
        title="Client Portal"
        subtitle="View your compliance reports and field observations"
        actions={[
          {
            label: 'Profile',
            onClick: () => navigate('/client/profile'),
            variant: 'secondary',
          },
        ]}
        userDisplayName={profile.displayName}
        onLogout={() => setShowLogoutConfirm(true)}
      />

      {/* Main Layout with Sidebar */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Professional Navigation */}
        <ProfessionalNav
          sections={[
            {
              title: 'Dashboard',
              items: [
                { id: 'dashboard', label: 'Overview', path: '/client', status: 'active' },
                { id: 'sites', label: 'My Sites', path: '/client/sites', status: 'none' },
              ],
            },
            {
              title: 'Compliance Data',
              items: [
                { id: 'observations', label: 'Observations', path: '/client/observations', status: 'alerts' },
                { id: 'incidents', label: 'Incidents', path: '/client/incidents', status: 'pending' },
                { id: 'breaches', label: 'Breaches', path: '/client/breaches', status: 'none' },
              ],
            },
            {
              title: 'Reporting',
              items: [
                { id: 'reports', label: 'Reports', path: '/client/reports', status: 'none' },
                { id: 'export', label: 'Export Data', path: '/client/export', status: 'none' },
                { id: 'schedules', label: 'Report Schedule', path: '/client/schedules', status: 'none' },
              ],
            },
          ]}
          currentPath={window.location.pathname}
          onNavigate={(path) => navigate(path)}
        />

        {/* Main Content Area */}
        <main style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 'var(--space-8)', maxWidth: '1280px', margin: '0 auto', width: '100%' }}>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '60vh',
              gap: 'var(--space-4)',
            }}>
              <div style={{ fontSize: '64px' }}>👋</div>
              <div style={{ fontSize: '28px', fontWeight: 'var(--font-bold)', color: 'var(--color-text-primary)' }}>
                Welcome, {profile.displayName}
              </div>
              <p style={{ fontSize: 'var(--text-base)', color: 'var(--color-text-secondary)', textAlign: 'center', maxWidth: '400px' }}>
                Select an option from the menu to view your compliance reports, observations, and field data.
              </p>
              
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-4)', marginTop: 'var(--space-8)', width: '100%' }}>
                <div className="card" style={{ borderLeft: `4px solid var(--color-primary)` }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                    Active Sites
                  </div>
                  <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 'var(--font-bold)', color: 'var(--color-primary)' }}>
                    3
                  </div>
                </div>

                <div className="card" style={{ borderLeft: `4px solid var(--color-warning)` }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                    Observations
                  </div>
                  <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 'var(--font-bold)', color: 'var(--color-warning)' }}>
                    24
                  </div>
                </div>

                <div className="card" style={{ borderLeft: `4px solid var(--color-error)` }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                    Action Items
                  </div>
                  <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 'var(--font-bold)', color: 'var(--color-error)' }}>
                    2
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Logout Confirmation Modal */}
      {showLogoutConfirm && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
        }}>
          <div style={{
            backgroundColor: 'var(--color-bg-primary)',
            borderRadius: 'var(--radius-lg)',
            padding: 'var(--space-8)',
            maxWidth: '400px',
            boxShadow: 'var(--shadow-lg)',
          }}>
            <h2 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 'var(--font-bold)', marginBottom: 'var(--space-4)' }}>
              Sign out?
            </h2>
            <p style={{ margin: '0 0 var(--space-6) 0', color: 'var(--color-text-secondary)' }}>
              Are you sure you want to sign out?
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowLogoutConfirm(false)}
                style={{
                  padding: 'var(--space-2) var(--space-4)',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--color-text-primary)',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSignOut}
                style={{
                  padding: 'var(--space-2) var(--space-4)',
                  backgroundColor: 'var(--color-error)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  color: 'white',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
