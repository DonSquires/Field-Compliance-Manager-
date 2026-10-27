import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NztaRevealDialog, nztaWarningText } from './NztaRevealDialog';
import { toCsv } from '../lib/nztaRegister';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const renderDialog = (notices: Array<{ id: string; label: string }> = []) => {
  const onRevealed = vi.fn();
  const onClose = vi.fn();
  render(<NztaRevealDialog subjectType="vehicle" subjectId="vehicle-1" subjectLabel="ABC123" organizationId="org"
    notices={notices} onRevealed={onRevealed} onClose={onClose} />);
  return { onRevealed, onClose };
};

describe('NZTA reveal dialog', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  it('refuses to reveal without a purpose and a real reason', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Record purpose and view' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Choose why you need this information.');
    expect(alert.textContent).toContain('at least 10 characters');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('disables notice follow-up when there is no notice to follow up', () => {
    renderDialog();
    const radio = screen.getByRole('radio', { name: /Following up a trespass or warning notice/ });
    expect(radio.hasAttribute('disabled')).toBe(true);
  });

  it('requires the notice for a notice follow-up and sends it to the server', async () => {
    rpc.mockResolvedValue({ data: { revealed_until: '2026-11-01T01:15:00Z', organization_count: 1, warnings: [] }, error: null });
    const { onRevealed } = renderDialog([{ id: 'notice-1', label: 'TN-1 · 01/11/2026' }]);
    fireEvent.click(screen.getByRole('radio', { name: /Following up a trespass or warning notice/ }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '  Second visit after warning  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record purpose and view' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Choose the notice you are following up.');
    fireEvent.change(screen.getByLabelText(/Notice/), { target: { value: 'notice-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record purpose and view' }));
    await waitFor(() => expect(onRevealed).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith('reveal_nzta_registered_person', {
      p_subject_type: 'vehicle', p_subject_id: 'vehicle-1', p_purpose: 'notice_follow_up',
      p_explanation: 'Second visit after warning', p_organization_id: 'org', p_notice_id: 'notice-1', p_observation_id: null,
    });
  });

  it('shows the server refusal and does not reveal', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'NZTA register access required' } });
    const { onRevealed } = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /without a valid permit/ }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Parked in reserved bay 4 without permit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record purpose and view' }));
    expect((await screen.findByRole('alert')).textContent).toContain('NZTA register access required');
    expect(onRevealed).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('explains missing readiness after a logged reveal', () => {
    expect(nztaWarningText([])).toBeNull();
    expect(nztaWarningText(['training', 'confidentiality'])).toContain('current NZTA register training and a current confidentiality acceptance');
  });

  it('guards CSV exports against spreadsheet formula injection', () => {
    const csv = toCsv([{ plate: '=HYPERLINK("x")', note: 'a,"b"' }], [['plate', 'Plate'], ['note', 'Note']]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"a,""b"""');
  });
});
