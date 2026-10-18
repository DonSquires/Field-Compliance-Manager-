// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChangeRequestButton } from './ChangeRequestButton';
import * as requests from '../lib/bobChangeRequest';

const auth = vi.hoisted(() => ({ profile: { id: 'officer-1', role: 'officer' } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../lib/bobChangeRequest', async (load) => ({
  ...await load<typeof import('../lib/bobChangeRequest')>(),
  submitChangeRequest: vi.fn(),
  listChangeRequests: vi.fn().mockResolvedValue([]),
}));
beforeEach(() => {
  auth.profile.role = 'officer';
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.mocked(requests.submitChangeRequest).mockReset();
});
afterEach(cleanup);

describe('governed change request dialog', () => {
  it('hides the trigger from unauthorised roles', () => {
    auth.profile.role = 'client_viewer';
    render(<ChangeRequestButton />);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('shows safe context, retains retry identity and gives a stored review receipt', async () => {
    vi.mocked(requests.submitChangeRequest).mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce({
      packet_id: 'packet-123', triage: 'ux_gap', route: 'self_heal_apparatus', repair_risk: 'significant', automation_status: 'awaiting_grandmaster', stop_line_hit: null,
    });
    render(<ChangeRequestButton workspaceLabel="Dispatch" />);
    fireEvent.click(screen.getByRole('button', { name: 'Request change' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/After/), { target: { value: 'Show unfilled shifts at the top' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to review queue' }));
    await screen.findByText('Connection interrupted');
    fireEvent.click(screen.getByRole('button', { name: 'Send to review queue' }));
    await screen.findByText('Request recorded');
    expect(requests.submitChangeRequest).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(requests.submitChangeRequest).mock.calls;
    expect(calls[0][2]).toBe(calls[1][2]);
    expect(calls[0][1].workspace).toBe('Dispatch');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Request change' }));
  });
});
