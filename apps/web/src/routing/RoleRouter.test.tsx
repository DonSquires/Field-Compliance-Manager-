import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { RoleRouter } from './RoleRouter';

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
