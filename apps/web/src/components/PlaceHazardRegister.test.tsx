import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlaceHazardRegister, type RegisterHazard } from './PlaceHazardRegister';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, functions: { invoke: vi.fn() } } }));

describe('place hazard risk assessment', () => {
  beforeEach(() => rpc.mockReset());

  it('supports a whole-location assessment without an addressed site facet', async () => {
    rpc.mockImplementation(async (name: string) => ({ data: name === 'can_manage_place_hazards' ? true : name === 'manage_place_hazard' ? 'hazard-1' : [], error: null }));
    render(<PlaceHazardRegister organizationId="org-1" locationId="house-1" zones={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add hazard' }));
    const form = screen.getByRole('button', { name: 'Cancel' }).closest('form')!;
    fireEvent.change(within(form).getByLabelText('Hazard (short, officer-readable)'), { target: { value: 'Wet entrance' } });
    fireEvent.change(within(form).getByLabelText('Likelihood (1-5, optional)'), { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText('Consequence (1-5, optional)'), { target: { value: '4' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add hazard' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('manage_place_hazard', expect.objectContaining({
      p_action: 'create', p_fields: expect.objectContaining({ organization_id: 'org-1', location_id: 'house-1', client_site_id: null, zone_id: null, likelihood: 2, consequence: 4 }),
    })));
    await screen.findByText(/Hazard added to the register/);
  });

  it('does not offer record creation without place-management authority', async () => {
    rpc.mockImplementation(async (name: string) => ({ data: name === 'can_manage_place_hazards' ? false : [], error: null }));
    render(<PlaceHazardRegister organizationId="org-1" locationId="house-1" zones={[]} />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Add hazard' })).toBeNull();
  });

  it('displays the stored score, custodian and overdue date without inventing a risk category', async () => {
    const hazard: Partial<RegisterHazard> = {
      id: 'h1', title: 'Wet entrance', hazard_class: 'slips_trips_falls', risk_level: 'low',
      likelihood: 2, consequence: 4, controls: [], status: 'active', origin: 'manual', version: 1,
      organization_name: 'Fixture custodian', place_name: 'Fixture place', review_due: '2000-01-01', can_manage: false,
    };
    rpc.mockImplementation(async (name: string) => ({ data: name === 'can_manage_place_hazards' ? false : [hazard], error: null }));
    render(<PlaceHazardRegister organizationId="org-1" locationId="house-1" zones={[]} />);
    await screen.findByText(/Risk score: 2 x 4 = 8\/25/);
    expect(screen.getByText(/Custodian: Fixture custodian/)).toBeTruthy();
    expect(screen.getByText('Review overdue')).toBeTruthy();
    expect(screen.getByText('Low')).toBeTruthy();
  });
});
