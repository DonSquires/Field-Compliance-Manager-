import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ServiceRelationshipProvider } from './context/ServiceRelationshipContext';
import { RoleRouter } from './routing/RoleRouter';
import LoginPage from './pages/LoginPage';

function AuthGate() {
  const { profile, hasSession, recoveryMode, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--color-text-secondary)' }}>
        Loading…
      </div>
    );
  }

  if (!hasSession || recoveryMode) return <LoginPage />;

  if (!profile) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--color-text-secondary)', textAlign: 'center', padding: '24px' }}>
        Signed in, but no matching user profile was found for this account. Contact an administrator.
      </div>
    );
  }

  return <RoleRouter />;
}

export function App() {
  return (
    <AuthProvider>
      <ServiceRelationshipProvider>
        <BrowserRouter>
          <Routes>
            <Route path="*" element={<AuthGate />} />
            <Route path="/" element={<Navigate to="/officer" replace />} />
          </Routes>
        </BrowserRouter>
      </ServiceRelationshipProvider>
    </AuthProvider>
  );
}
