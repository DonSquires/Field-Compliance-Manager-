import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PersonInteractionForm } from './PersonInteractionForm';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

describe('PersonInteractionForm', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  const open = () => {
    render(<PersonInteractionForm organizationId="org-1" dispatchJobId="job-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Add a person involved/ }));
  };

  it('records a named person on the dispatch job and confirms review', async () => {
    rpc.mockResolvedValue({ data: { interaction_id: 'pi-1', person_record_id: 'pr-1', outcome: 'recorded' }, error: null });
    open();
    const save = screen.getByRole('button', { name: 'Save person' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name as given'), { target: { value: ' Unknown male ' } });
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'trespass_notice_served' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Served under the covered area.' } });
    fireEvent.click(save);
    expect(await screen.findByText(/Recorded for Unknown male. An administrator will review/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('record_person_interaction', expect.objectContaining({
      p_organization_id: 'org-1', p_dispatch_job_id: 'job-1', p_shift_id: null, p_person_record_id: null,
      p_new_person_name: 'Unknown male', p_interaction_type: 'trespass_notice_served', p_notes: 'Served under the covered area.', p_source: 'field',
    }));
    expect((screen.getByLabelText('Name as given') as HTMLInputElement).value).toBe('');
  });

  it('keeps the same request id when a save fails so a retry cannot double-record', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('Network dropped') })
      .mockResolvedValueOnce({ data: { interaction_id: 'pi-1', person_record_id: 'pr-1' }, error: null });
    open();
    fireEvent.change(screen.getByLabelText('Name as given'), { target: { value: 'Jo Bloggs' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Spoke with them.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save person' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save person' }));
    expect(await screen.findByText(/Recorded for Jo Bloggs/)).toBeTruthy();
    const [first, second] = rpc.mock.calls.map(([, args]) => (args as { p_client_request_id: string }).p_client_request_id);
    expect(second).toBe(first);
  });
});
