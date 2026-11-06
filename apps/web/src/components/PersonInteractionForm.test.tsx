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

  it('sends only the details the officer filled in and does not reveal whether the name matched', async () => {
    rpc.mockResolvedValue({ data: { interaction_id: 'pi-2', person_record_id: null }, error: null });
    open();
    fireEvent.change(screen.getByLabelText('Name as given'), { target: { value: 'Grey Hoodie Male' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Asked to leave the covered area.' } });
    fireEvent.click(screen.getByText('Add person details (optional)'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '  Tall,   grey hoodie ' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '021 555 0101' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save person' }));
    expect(await screen.findByText(/Any details you added will be checked by an administrator/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('record_person_interaction', expect.objectContaining({
      p_details: { description: 'Tall, grey hoodie', phone: '021 555 0101' },
    }));
    expect((screen.getByLabelText('Phone') as HTMLInputElement).value).toBe('');
  });

  it('sends no details when none were added and reports server-side review state', async () => {
    rpc.mockResolvedValueOnce({ data: { interaction_id: 'pi-3', person_record_id: 'pr-1' }, error: null })
      .mockResolvedValueOnce({ data: { interaction_id: 'pi-4', person_record_id: 'pr-1', details_status: 'pending' }, error: null });
    open();
    fireEvent.change(screen.getByLabelText('Name as given'), { target: { value: 'Jo Bloggs' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Spoke with them.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save person' }));
    expect(await screen.findByText(/Recorded for Jo Bloggs/)).toBeTruthy();
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_details: null });
    fireEvent.change(screen.getByLabelText('Name as given'), { target: { value: 'Jo Bloggs' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Gave an address.' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '1 Example Street' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save person' }));
    expect(await screen.findByText(/waiting for an administrator to review/)).toBeTruthy();
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
