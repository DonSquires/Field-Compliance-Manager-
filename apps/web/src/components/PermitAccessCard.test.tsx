import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PermitAccessCard } from './PermitAccessCard';
import type { PermitSummary } from '../lib/permits';

const permit = (overrides: Partial<PermitSummary> = {}): PermitSummary => ({
  id: 'permit-1',
  canonical_person_id: 'person-1',
  holder_name: 'Pat Holder',
  permit_number: '10001',
  permit_type: 'Recreational',
  status: 'active',
  validity_state: 'expired',
  date_from: '2024-07-01',
  date_to: '2025-06-30',
  firearm_licence_valid: true,
  contact_email: 'holder@example.test',
  vehicles: [
    { canonical_vehicle_id: null, plate_number: 'ABC123' },
    { canonical_vehicle_id: null, plate_number: 'XYZ9' },
  ],
  ...overrides,
});

describe('permit access card', () => {
  afterEach(cleanup);

  it('shows the holder and the other vehicles on a vehicle view, without application contact details', () => {
    render(<PermitAccessCard permit={permit()} showHolder currentPlate="abc 123" />);
    const card = screen.getByRole('article', { name: 'Permit 10001' });
    expect(card.textContent).toContain('Recreational · Pat Holder');
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getByText('Other vehicles on this permit')).toBeTruthy();
    expect(screen.getByText('XYZ9')).toBeTruthy();
    expect(screen.queryByText('ABC123')).toBeNull();
    expect(card.textContent).not.toContain('holder@example.test');
    expect(card.textContent).not.toContain('No valid firearms licence');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('hands the permit to the person record when allowed', () => {
    const onOpenPerson = vi.fn();
    render(<PermitAccessCard permit={permit({ firearm_licence_valid: false })} showHolder onOpenPerson={onOpenPerson} />);
    expect(screen.getByText('No valid firearms licence')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open person record for Pat Holder' }));
    expect(onOpenPerson).toHaveBeenCalledWith(expect.objectContaining({ canonical_person_id: 'person-1' }));
  });

  it('says plainly when the permit dates were never recorded', () => {
    render(<PermitAccessCard permit={permit({ validity_state: null, date_from: null, date_to: null })} />);
    expect(screen.getByText('Dates not recorded')).toBeTruthy();
    expect(screen.getAllByText('Not recorded').length).toBeGreaterThanOrEqual(2);
  });
});
