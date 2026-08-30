import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabase', () => ({ supabase: { rpc } }));

import { claimShiftCoverage } from './shiftCoverage';

describe('shift coverage client', () => {
  beforeEach(() => rpc.mockReset());

  it('calls the self-owned RPC with an expected open state', async () => {
    rpc.mockResolvedValue({ data: { id: 'coverage-1' }, error: null });
    await claimShiftCoverage('coverage-1');
    expect(rpc).toHaveBeenCalledWith('claim_shift_coverage', { p_request_id: 'coverage-1', p_expected_status: 'open' });
  });

  it('does not treat an empty response as confirmation', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(claimShiftCoverage('coverage-1')).rejects.toThrow('not confirmed');
  });
});