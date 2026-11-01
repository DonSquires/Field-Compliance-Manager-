import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ServiceRelationshipProvider } from './context/ServiceRelationshipContext';
import { RoleRouter } from './routing/RoleRouter';
import LoginPage from './pages/LoginPage';
import PublicDisputePage from './pages/PublicDisputePage';
import AcceptCapabilityShareInvitePage from './pages/AcceptCapabilityShareInvitePage';
import { installBobFrictionMonitor } from './lib/bobFrictionMonitor';
import { AppUpdateNotice } from './components/AppUpdateNotice';

function RuntimeFrictionMonitor() {
  const { hasSession } = useAuth();
  useEffect(() => {
    if (!hasSession) return;
    return installBobFrictionMonitor();
  }, [hasSession]);
  return null;
}

function AuthGate() {
  const { hasSession, recoveryMode, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--color-text-secondary)' }}>
        Loading…
      </div>
    );
  }

  if (!hasSession || recoveryMode) return <LoginPage />;

  return <RoleRouter />;
}

export function App() {
  return (
    <AuthProvider>
      <ServiceRelationshipProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <RuntimeFrictionMonitor />
          <AppUpdateNotice />
          <Routes>
            <Route path="/dispute" element={<PublicDisputePage />} />
            <Route path="/invite/capability/:token" element={<AcceptCapabilityShareInvitePage />} />
            <Route path="*" element={<AuthGate />} />
            <Route path="/" element={<Navigate to="/officer" replace />} />
          </Routes>
        </BrowserRouter>
      </ServiceRelationshipProvider>
    </AuthProvider>
  );
}
