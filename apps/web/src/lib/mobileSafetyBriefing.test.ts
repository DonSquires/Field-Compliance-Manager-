import { describe, expect, it, vi } from 'vitest';
import { fetchMobileShiftSafety } from '../../../mobile/src/lib/officerSafetyBriefing';

const safety = () => ({
  shift_id: 'shift-1', stop_id: null, briefing_hash: 'v1', item_count: 1,
  acknowledged: false, is_assigned_officer: true,
  places: [{ kind: 'site', id: 'site-1', name: 'Site' }],
  hazards: [{
    id: 'hazard-1', title: 'Reviewed hazard', risk_level: 'high', controls: ['Work in pairs'],
    details: null, status: 'active', place_name: 'Site', source_name: null, source_locator: null,
    has_source_document: false,
  }],
  warnings: [],
});

const privateResult = (status = 'checked') => ({
  data: { post: { shift: { id: 'shift-1' } }, safety: safety(), privacy: { status } },
  error: null,
});

describe('native officer safety privacy', () => {
  it.each(['static_guarding', 'site_guard', 'static', ' STATIC_GUARDING '])('uses the private briefing for %s and does not request raw safety', async (serviceType) => {
    const transport = {
      privateBriefing: vi.fn().mockResolvedValue(privateResult()),
      generalBriefing: vi.fn(),
    };
    const result = await fetchMobileShiftSafety(transport, 'shift-1', serviceType);
    expect(result.hazards[0].title).toBe('Reviewed hazard');
    expect(transport.privateBriefing).toHaveBeenCalledWith('shift-1');
    expect(transport.generalBriefing).not.toHaveBeenCalled();
  });

  it.each(['partly_withheld', 'unavailable'])('does not fall back when private review is %s', async (status) => {
    const transport = { privateBriefing: vi.fn().mockResolvedValue(privateResult(status)), generalBriefing: vi.fn() };
    await expect(fetchMobileShiftSafety(transport, 'shift-1', 'static_guarding')).rejects.toThrow(/withheld pending private review/);
    expect(transport.generalBriefing).not.toHaveBeenCalled();
  });

  it('logs a private transport failure and does not expose its technical message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const transport = { privateBriefing: vi.fn().mockResolvedValue({ data: null, error: { message: 'internal detail' } }), generalBriefing: vi.fn() };
      await expect(fetchMobileShiftSafety(transport, 'shift-1', 'static_guarding')).rejects.toThrow('The safety briefing could not be checked.');
      expect(transport.generalBriefing).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('keeps the existing general safety path for non-static shifts', async () => {
    const transport = {
      privateBriefing: vi.fn(),
      generalBriefing: vi.fn().mockResolvedValue({ data: safety(), error: null }),
    };
    await expect(fetchMobileShiftSafety(transport, 'shift-1', 'patrol')).resolves.toMatchObject({ briefing_hash: 'v1' });
    expect(transport.privateBriefing).not.toHaveBeenCalled();
    expect(transport.generalBriefing).toHaveBeenCalledWith('shift-1');
  });

  it.each([null, '   '])('fails closed when the shift type is missing', async (serviceType) => {
    const transport = { privateBriefing: vi.fn(), generalBriefing: vi.fn() };
    await expect(fetchMobileShiftSafety(transport, 'shift-1', serviceType)).rejects.toThrow(/shift type could not be confirmed/);
    expect(transport.privateBriefing).not.toHaveBeenCalled();
    expect(transport.generalBriefing).not.toHaveBeenCalled();
  });

  it.each([
    { post: { shift: { id: 'other' } }, safety: safety() },
    { post: { shift: { id: 'shift-1' } }, safety: { ...safety(), shift_id: 'other' } },
    { post: { shift: { id: 'shift-1' } }, safety: { ...safety(), is_assigned_officer: false } },
    { post: { shift: { id: 'shift-1' } }, safety: { ...safety(), hazards: [{ ...safety().hazards[0], controls: [null] }] } },
  ])('rejects a mismatched or malformed private briefing', async (payload) => {
    const transport = {
      privateBriefing: vi.fn().mockResolvedValue({ data: { ...payload, privacy: { status: 'checked' } }, error: null }),
      generalBriefing: vi.fn(),
    };
    await expect(fetchMobileShiftSafety(transport, 'shift-1', 'static_guarding')).rejects.toThrow();
    expect(transport.generalBriefing).not.toHaveBeenCalled();
  });
});
