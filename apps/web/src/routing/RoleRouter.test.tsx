import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { RoleRouter } from './RoleRouter';

// AdminShell/OfficerShell and their descendant pages/hooks reach into
// Supabase directly (queries, realtime channels, function invokes). This is
// a full-tree smoke render, not a unit test of any one query, so every call
// is answered with an inert, always-chainable/thenable stand-in rather than
// mocking each call site individually.
function chainable(): unknown {
  return new Proxy(function chainableTarget() { /* callable no-op */ }, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
      return () => chainable();
    },
    apply() {
      return chainable();
    },
  });
}

vi.mock('../lib/supabase', () => ({
  supabase: new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'auth') {
          return {
            getSession: () => Promise.resolve({ data: { session: null }, error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
          };
        }
        if (prop === 'functions') return { invoke: () => Promise.resolve({ data: null, error: null }) };
        if (prop === 'storage') return { from: () => chainable() };
        if (prop === 'removeChannel') return () => undefined;
        return () => chainable();
      },
    },
  ),
}));

describe('RoleRouter', () => {
  it('renders the admin shell for admin roles', () => {
    render(
      <AuthContext.Provider value={{
        profile: { id: 'u1', role: 'admin', organizationId: 'org-1', displayName: 'Admin User' },
        hasSession: true,
        recoveryMode: false,
        loading: false,
        error: null,
        signInWithPassword: async () => ({ error: null }),
        requestPasswordReset: async () => ({ error: null }),
        updatePassword: async () => ({ error: null }),
        signOut: async () => undefined,
      }}>
        <MemoryRouter>
          <RoleRouter />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(screen.getAllByText(/field compliance manager/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/today at a glance/i).length).toBeGreaterThan(0);
  });

  it('renders the officer shell for officer roles', () => {
    render(
      <AuthContext.Provider value={{
        profile: { id: 'u2', role: 'officer', organizationId: 'org-1', displayName: 'Officer User' },
        hasSession: true,
        recoveryMode: false,
        loading: false,
        error: null,
        signInWithPassword: async () => ({ error: null }),
        requestPasswordReset: async () => ({ error: null }),
        updatePassword: async () => ({ error: null }),
        signOut: async () => undefined,
      }}>
        <MemoryRouter>
          <RoleRouter />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(screen.getAllByText(/officer operations/i).length).toBeGreaterThan(0);
  });
});
