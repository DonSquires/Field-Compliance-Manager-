import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  locationStatus: 'resolved',
  locationMode: 'gps',
  currentAddress: '1 Test Street',
  selectedSite: { name: 'Test site' } as { name: string } | null,
  selectedZone: null as { name: string } | null,
}));
vi.mock('../context/ServiceRelationshipContext', () => ({ useServiceRelationships: () => state }));
vi.mock('./PlaceContextBanner', () => ({ PlaceContextBanner: () => <div>Detailed geofence evidence</div> }));
import { OfficerLocationPill } from './OfficerLocationPill';

describe('OfficerLocationPill', () => {
  beforeEach(() => {
    state.locationStatus = 'resolved';
    state.locationMode = 'gps';
    state.currentAddress = '1 Test Street';
    state.selectedSite = { name: 'Test site' };
    state.selectedZone = null;
  });

  it('shows a verified current place and keeps detailed evidence one tap away', () => {
    render(<OfficerLocationPill />);
    const control = screen.getByRole('button', { name: /Current location.*1 Test Street/ });
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Detailed geofence evidence').closest('[hidden]')).toBeTruthy();
    fireEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Detailed geofence evidence').closest('[hidden]')).toBeNull();
    fireEvent.click(control);
    expect(screen.getByText('Detailed geofence evidence').closest('[hidden]')).toBeTruthy();
  });

  it('does not present a stale address or manually selected place as current GPS proof', () => {
    state.locationStatus = 'unavailable';
    const { rerender } = render(<OfficerLocationPill />);
    expect(screen.getByRole('button', { name: /No current location.*Last known: 1 Test Street/ })).toBeTruthy();
    state.locationMode = 'manual';
    rerender(<OfficerLocationPill />);
    expect(screen.getByRole('button', { name: /Selected place.*Test site/ })).toBeTruthy();
    expect(screen.queryByText('Current location')).toBeNull();
    expect(screen.queryByText(/1 Test Street/)).toBeNull();
  });

  it('distinguishes finding a location from a missing location', () => {
    state.locationStatus = 'locating';
    render(<OfficerLocationPill />);
    expect(screen.getByRole('button', { name: /Finding location.*Last known: 1 Test Street/ })).toBeTruthy();
  });
});
