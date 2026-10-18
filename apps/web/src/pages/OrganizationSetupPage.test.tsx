import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { JurisdictionRequestStatus, toJurisdictionRequest } from './OrganizationSetupPage';

vi.mock('../lib/supabase', () => ({ supabase: {} }));

afterEach(cleanup);

const failedRow = {
  id: 'a1',
  status: 'failed',
  error_message: 'set_org_jurisdiction_geom failed: canceling statement due to statement timeout',
  proposed_payload: { district_names: ['Nelson City', 'Tasman District'] },
  created_at: '2026-10-12T05:12:10Z',
};

it('explains a failed request instead of leaving an unexplained empty map', () => {
  const onReuse = vi.fn();
  render(<JurisdictionRequestStatus request={toJurisdictionRequest(failedRow)} hasSavedBoundary={false} onReuse={onReuse} />);
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('approved but not saved');
  expect(alert.textContent).toContain('No boundary is saved, so the map is empty.');
  expect(alert.textContent).toContain('statement timeout');
  fireEvent.click(screen.getByRole('button', { name: 'Use these councils again' }));
  expect(onReuse).toHaveBeenCalledOnce();
});

it('reports pending and applied requests without offering a resend', () => {
  const { rerender } = render(<JurisdictionRequestStatus request={toJurisdictionRequest({ ...failedRow, status: 'pending', error_message: null })} hasSavedBoundary onReuse={() => {}} />);
  expect(screen.getByRole('status').textContent).toContain('waiting in Approvals');
  rerender(<JurisdictionRequestStatus request={toJurisdictionRequest({ ...failedRow, status: 'applied', error_message: null })} hasSavedBoundary onReuse={() => {}} />);
  expect(screen.getByRole('status').textContent).toContain('2 councils');
  expect(screen.queryByRole('button')).toBeNull();
});
