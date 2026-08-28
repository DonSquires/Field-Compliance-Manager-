import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useEnabledModules } from './useEnabledModules';

vi.mock('../lib/supabase', () => {
  return { supabase: { from: vi.fn() } };
});

import { supabase } from '../lib/supabase';

function mockOrgModulesResult(result: { data: unknown; error: unknown }) {
  (supabase.from as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    select: () => ({
      eq: () => Promise.resolve(result),
    }),
  });
}

describe('useEnabledModules', () => {
  it('reports loading while organizationId is present but the query has not resolved', () => {
    (supabase.from as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      select: () => ({ eq: () => new Promise(() => {}) }),
    });
    const { result } = renderHook(() => useEnabledModules('org-1'));
    expect(result.current.status).toBe('loading');
  });

  it('fails CLOSED for a safety-relevant module on a read error, never exposing it', async () => {
    mockOrgModulesResult({ data: null, error: { message: 'network error' } });
    const { result } = renderHook(() => useEnabledModules('org-1'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.isModuleEnabled('welfare', { safetyRelevant: true })).toBe(false);
    expect(result.current.isModuleEnabled('field_reports')).toBe(false);
  });

  it('reports unconfigured (not error, not configured) when the org has zero module rows', async () => {
    mockOrgModulesResult({ data: [], error: null });
    const { result } = renderHook(() => useEnabledModules('org-1'));
    await waitFor(() => expect(result.current.status).toBe('unconfigured'));
    // non-safety-relevant modules may fail open on a genuinely unconfigured org
    expect(result.current.isModuleEnabled('field_reports')).toBe(true);
    // safety-relevant modules never fail open, even here
    expect(result.current.isModuleEnabled('welfare', { safetyRelevant: true })).toBe(false);
  });

  it('confirms an explicitly-configured org with welfare disabled does not expose welfare', async () => {
    mockOrgModulesResult({
      data: [
        { module_key: 'field_reports', enabled: true },
        { module_key: 'welfare', enabled: false },
      ],
      error: null,
    });
    const { result } = renderHook(() => useEnabledModules('org-1'));
    await waitFor(() => expect(result.current.status).toBe('configured'));
    expect(result.current.isModuleEnabled('field_reports')).toBe(true);
    expect(result.current.isModuleEnabled('welfare', { safetyRelevant: true })).toBe(false);
  });

  it('confirms an explicitly-configured org with welfare enabled does expose welfare', async () => {
    mockOrgModulesResult({
      data: [{ module_key: 'welfare', enabled: true }],
      error: null,
    });
    const { result } = renderHook(() => useEnabledModules('org-1'));
    await waitFor(() => expect(result.current.status).toBe('configured'));
    expect(result.current.isModuleEnabled('welfare', { safetyRelevant: true })).toBe(true);
  });
});
