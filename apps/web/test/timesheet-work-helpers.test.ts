import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ webRpc: vi.fn(), mobileRpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocked.webRpc } }));
vi.mock('../../mobile/src/lib/supabase', () => ({ supabase: { rpc: mocked.mobileRpc } }));

import { loadOfficerTimesheetWork as loadWebWork } from '../src/lib/officerTimesheetWork';
import { loadOfficerTimesheetWork as loadMobileWork } from '../../mobile/src/lib/officerTimesheetWork';

beforeEach(() => {
  vi.resetAllMocks();
});

describe.each([
  ['web', loadWebWork, mocked.webRpc],
  ['mobile', loadMobileWork, mocked.mobileRpc],
] as const)('%s timesheet work response', (_platform, loadWork, rpc) => {
  it('accepts a confirmed empty array', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(loadWork('2026-08-24', '2026-08-29')).resolves.toEqual([]);
  });

  it('rejects an absent preview instead of presenting it as empty', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(loadWork('2026-08-24', '2026-08-29')).rejects.toThrow('Timesheet work preview was not confirmed.');
  });

  it('surfaces a backend failure', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('Unavailable') });
    await expect(loadWork('2026-08-24', '2026-08-29')).rejects.toThrow('Unavailable');
  });
});
