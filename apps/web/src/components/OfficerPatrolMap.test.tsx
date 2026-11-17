import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  map: vi.fn(),
  marker: vi.fn(),
  tileError: null as (() => void) | null,
}));

vi.mock('leaflet', () => ({
  default: {
    map: mocks.map,
    latLngBounds: () => ({ extend: vi.fn(), isValid: () => true, pad: () => ({}) }),
    marker: mocks.marker,
    divIcon: (options: unknown) => options,
  },
}));
vi.mock('../lib/mapPreferences', () => ({
  addLinzBaseLayers: () => ({ street: { on: (_event: string, handler: () => void) => { mocks.tileError = handler; } } }),
}));

import { OfficerPatrolMap } from './OfficerPatrolMap';

beforeEach(() => {
  mocks.map.mockReset().mockReturnValue({ fitBounds: vi.fn(), remove: vi.fn() });
  mocks.marker.mockReset().mockReturnValue({ addTo: vi.fn() });
  mocks.tileError = null;
});
afterEach(cleanup);

it('waits for the officer before loading map tiles and reports missing positions', () => {
  render(<OfficerPatrolMap points={[{ id: 'one', name: 'Site one', order: 1, latitude: -41, longitude: 174 }]} totalStops={2} />);
  expect(mocks.map).not.toHaveBeenCalled();
  expect(screen.getByText('1 stop has no mapped position and cannot be shown.')).toBeTruthy();
  expect(screen.getByText(/not a road route/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show stop map' }));
  expect(mocks.map).toHaveBeenCalledOnce();
  expect(mocks.marker).toHaveBeenCalledWith([-41, 174], expect.objectContaining({ title: '1. Site one' }));
});

it('shows tile failures and permits retry', () => {
  render(<OfficerPatrolMap points={[{ id: 'one', name: 'Site one', order: 1, latitude: -41, longitude: 174 }]} totalStops={1} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show stop map' }));
  if (!mocks.tileError) throw new Error('Tile error handler was not registered');
  act(() => mocks.tileError?.());
  expect(screen.getByRole('alert').textContent).toContain('Some map tiles could not be loaded');
  fireEvent.click(screen.getByRole('button', { name: 'Retry map' }));
  expect(mocks.map).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not open a map when no stop positions are available', () => {
  render(<OfficerPatrolMap points={[]} totalStops={1} />);
  expect(screen.getByText('No stop positions are available for this shift.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Show stop map' })).toBeNull();
  expect(mocks.map).not.toHaveBeenCalled();
});
