import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({ supabase: { functions: { invoke } } }));

import { runIncidentScan, runPrivacyCheck } from './reportBob';

const response = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  checked: 1,
  reworded: 0,
  editorial_reworded: 0,
  remaining: 0,
  cleared: true,
  updated_at: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

beforeEach(() => invoke.mockReset());

describe('report incident scans', () => {
  const scan = (overrides: Record<string, unknown> = {}) => ({
    ok: true, checked: 3, flagged: 1, remaining: 0, not_itemised: 0, ...overrides,
  });

  it.each([
    {},
    { ok: true },
    scan({ checked: '3' }),
    scan({ checked: -1 }),
    scan({ flagged: 4 }),
    scan({ remaining: null }),
    scan({ not_itemised: undefined }),
  ])('does not present a malformed response as a completed scan', async (data) => {
    invoke.mockResolvedValueOnce({ data, error: null });
    const result = await runIncidentScan('pack');
    expect(result.error).toMatch(/invalid incident-scan result/);
    expect(result.checked).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('retains the last verified progress if a later scan pass is malformed', async () => {
    invoke
      .mockResolvedValueOnce({ data: scan({ remaining: 4, not_itemised: 2 }), error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });
    const result = await runIncidentScan('pack');
    expect(result).toEqual({
      checked: 3, flagged: 1, remaining: 4, notItemised: 2,
      error: expect.stringMatching(/invalid incident-scan result/),
    });
  });
});

describe('report privacy checks', () => {
  it('carries the saved version through every pass and uses only checked wording', async () => {
    const wording = { title: 'Report', executive_summary: 'Original', client_notes: '', follow_up: '' };
    const checkedWording = { ...wording, executive_summary: '[name withheld]' };
    invoke
      .mockResolvedValueOnce({ data: response({ checked: 2, remaining: 1, cleared: false, reworded: 1, updated_at: '2026-10-01T10:01:00.000Z' }), error: null })
      .mockResolvedValueOnce({ data: response({ updated_at: '2026-10-01T10:02:00.000Z' }), error: null })
      .mockResolvedValueOnce({ data: response({ checked: 0, editorial_reworded: 1, updated_at: '2026-10-01T10:03:00.000Z', editorial: checkedWording }), error: null });

    const result = await runPrivacyCheck('pack', { editorial: wording, expectedUpdatedAt: '2026-10-01T10:00:00.000Z' });

    expect(result).toEqual({ cleared: true, remaining: 0, reworded: 2, editorial: checkedWording, updatedAt: '2026-10-01T10:03:00.000Z', error: null });
    expect(invoke.mock.calls.map((call) => call[1].body.expected_updated_at)).toEqual([
      '2026-10-01T10:00:00.000Z', '2026-10-01T10:01:00.000Z', '2026-10-01T10:02:00.000Z',
    ]);
    expect(invoke.mock.calls[2][1].body.editorial).toEqual(wording);
  });

  it.each([
    { ok: true },
    response({ remaining: '0' }),
    response({ remaining: 1, cleared: true }),
    response({ checked: -1 }),
    response({ updated_at: 'not a timestamp' }),
  ])('does not treat a malformed response as privacy clearance', async (data) => {
    invoke.mockResolvedValueOnce({ data, error: null });
    const result = await runPrivacyCheck('pack');
    expect(result.cleared).toBe(false);
    expect(result.error).toMatch(/invalid privacy-check result/);
  });

  it('does not fall back to unchecked wording when the editorial response is incomplete', async () => {
    invoke
      .mockResolvedValueOnce({ data: response(), error: null })
      .mockResolvedValueOnce({ data: response({ editorial: { title: 'Report' } }), error: null });
    const result = await runPrivacyCheck('pack', {
      editorial: { title: 'Report', executive_summary: 'Original', client_notes: '', follow_up: '' },
    });
    expect(result.cleared).toBe(false);
    expect(result.editorial).toBeNull();
    expect(result.error).toMatch(/invalid checked wording/);
  });

  it('keeps a partial check pending when no more entries were processed', async () => {
    invoke.mockResolvedValueOnce({ data: response({ checked: 0, remaining: 506, cleared: false }), error: null });
    const result = await runPrivacyCheck('pack');
    expect(result.cleared).toBe(false);
    expect(result.remaining).toBe(506);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
