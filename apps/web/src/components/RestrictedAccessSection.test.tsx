import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RestrictedAccessSection } from './UserIdentityWorkspace';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const access = { direct: false, via_role: false, via_preset: false, via_grant: false, active: true };

describe('restricted user access', () => {
  beforeEach(() => { vi.clearAllMocks(); rpc.mockResolvedValue({ data: access, error: null }); });
  afterEach(cleanup);

  it('requires a reason and saves person permission independently of NZTA', async () => {
    render(<RestrictedAccessSection userId="officer" kind="person" />);
    const checkbox = await screen.findByRole('checkbox', { name: /Person search/ });
    fireEvent.click(checkbox);
    const save = screen.getByRole('button', { name: 'Save person search access' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: '  Permit checks  ' } });
    rpc.mockResolvedValue({ data: { ...access, direct: true }, error: null });
    fireEvent.click(save);
    expect(await screen.findByText('Direct authorization enabled.')).toBeTruthy();
    expect(rpc).toHaveBeenLastCalledWith('set_person_search_access', { p_user_id: 'officer', p_enabled: true, p_reason: 'Permit checks' });
    expect(rpc.mock.calls.some(([name]) => name === 'set_vehicle_owner_access')).toBe(false);
  });

  it('fails closed on load errors and retries rather than presenting an editable checkbox', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Access check unavailable' } });
    render(<RestrictedAccessSection userId="officer" kind="person" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry access check' }));
    expect(await screen.findByRole('checkbox')).toBeTruthy();
  });

  it('does not claim effective revocation when an inherited preset remains', async () => {
    rpc.mockResolvedValueOnce({ data: { ...access, direct: true, via_preset: true }, error: null });
    render(<RestrictedAccessSection userId="officer" kind="person" />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'End direct grant' } });
    rpc.mockResolvedValueOnce({ data: { ...access, via_preset: true }, error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Save person search access' }));
    expect(await screen.findByText(/Access remains through their role, preset or inherited grant/)).toBeTruthy();
  });

  it('allows revoking an inactive user grant without allowing activation', async () => {
    rpc.mockResolvedValueOnce({ data: { ...access, direct: true, active: false }, error: null });
    render(<RestrictedAccessSection userId="inactive-officer" kind="person" />);
    const checkbox = await screen.findByRole('checkbox');
    expect(checkbox.hasAttribute('disabled')).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'End inactive account authority' } });
    rpc.mockResolvedValueOnce({ data: { ...access, active: false }, error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Save person search access' }));
    expect(await screen.findByText('Authorization removed.')).toBeTruthy();
    expect(rpc).toHaveBeenLastCalledWith('set_person_search_access', { p_user_id: 'inactive-officer', p_enabled: false, p_reason: 'End inactive account authority' });
    expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(true);
  });

  it('preserves the NZTA setter and reports a save failure', async () => {
    render(<RestrictedAccessSection userId="officer" kind="vehicle" />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'Approved lawful duties' } });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Organisation administrator required' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save restricted access' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Organisation administrator required'));
    expect(rpc).toHaveBeenLastCalledWith('set_vehicle_owner_access', { p_user_id: 'officer', p_enabled: true, p_reason: 'Approved lawful duties' });
    expect(screen.queryByText('Direct authorization enabled.')).toBeNull();
  });
});
