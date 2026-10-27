import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadVehiclePermits } from './vehiclePermits';

const { from, select, results } = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn(), results: [] as unknown[] }));
vi.mock('./supabase', () => ({ supabase: { from } }));

describe('vehicle permits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    results.length = 0;
    from.mockImplementation(() => {
      const query = {
        select: (columns: string) => { select(columns); return query; },
        contains: () => query,
        order: () => Promise.resolve(results.shift()),
      };
      return query;
    });
  });

  it('reads validity from the view and lists the permit plates as vehicles', async () => {
    results.push({ data: [{ id: 'p1', permit_number: '10001', status: 'active', validity_state: 'valid', date_from: null, date_to: null, vehicle_plates: ['ABC123', 'XYZ9'] }], error: null });
    const { data, error } = await loadVehiclePermits('ABC123');
    expect(error).toBeNull();
    expect(from).toHaveBeenCalledWith('person_permits_fieldwork');
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0]).toContain('validity_state');
    expect(data[0].validity_state).toBe('valid');
    expect(data[0].vehicles).toEqual([
      { canonical_vehicle_id: null, plate_number: 'ABC123' },
      { canonical_vehicle_id: null, plate_number: 'XYZ9' },
    ]);
  });

  it('falls back to the earlier view columns until validity_state is deployed', async () => {
    results.push({ data: null, error: { code: '42703', message: 'column person_permits_fieldwork.validity_state does not exist' } });
    results.push({ data: [{ id: 'p1', permit_number: '10001', status: 'active', date_from: null, date_to: null, vehicle_plates: null }], error: null });
    const { data, error } = await loadVehiclePermits('ABC123');
    expect(error).toBeNull();
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[1][0]).not.toContain('validity_state');
    expect(data).toHaveLength(1);
    expect(data[0].vehicles).toEqual([]);
  });

  it('returns any other failure without retrying', async () => {
    results.push({ data: null, error: { code: '42501', message: 'permission denied' } });
    const { data, error } = await loadVehiclePermits('ABC123');
    expect(error?.code).toBe('42501');
    expect(data).toEqual([]);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
