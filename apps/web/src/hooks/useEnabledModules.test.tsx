import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useEnabledModules } from './useEnabledModules';
import { canUseModule } from '../lib/moduleAccess';

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../lib/supabase', () => {
  return { supabase: { from } };
});

function mockOrgModulesResult(result: { data: unknown; error: unknown }) {
  from.mockReturnValue({
    select: () => ({
      eq: () => Promise.resolve(result),
    }),
  });
}

describe('useEnabledModules', () => {
  it('reports loading while organizationId is present but the query has not resolved', () => {
    from.mockReturnValue({
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

  it.each([true, false])('gives the canonical switch (%s) precedence over its conflicting alias', async (enabled) => {
    mockOrgModulesResult({ data: [
      { module_key: 'parking', enabled: !enabled },
      { module_key: 'parking_enforcement', enabled },
    ], error: null });
    const { result } = renderHook(() => useEnabledModules('org-1'));
    await waitFor(() => expect(result.current.status).toBe('configured'));
    expect(result.current.isModuleEnabled('parking')).toBe(enabled);
    expect(result.current.isModuleEnabled('parking_enforcement')).toBe(enabled);
    expect(canUseModule({
      moduleKey: 'parking', role: 'admin_officer', moduleAccess: [],
      isModuleEnabled: result.current.isModuleEnabled,
    })).toBe(enabled);
  });

  it('uses a historical alias when no canonical switch exists', async () => {
    mockOrgModulesResult({ data: [{ module_key: 'parking', enabled: true }], error: null });
    const { result } = renderHook(() => useEnabledModules('org-1'));
    await waitFor(() => expect(result.current.status).toBe('configured'));
    expect(result.current.isModuleEnabled('parking_enforcement')).toBe(true);
  });

  it('denies the new organisation from its first render, before the loading effect runs', async () => {
    from.mockReturnValue({ select: () => ({ eq: (_column: string, org: string) => org === 'org-1'
      ? Promise.resolve({ data: [{ module_key: 'parking_enforcement', enabled: true }], error: null })
      : new Promise(() => {}) }) });
    const renders: Array<{ org: string; status: string; enabled: boolean }> = [];
    const { result, rerender } = renderHook(({ org }) => {
      const gate = useEnabledModules(org);
      renders.push({ org, status: gate.status, enabled: gate.isModuleEnabled('parking') });
      return gate;
    }, { initialProps: { org: 'org-1' } });
    await waitFor(() => expect(result.current.isModuleEnabled('parking')).toBe(true));
    rerender({ org: 'org-2' });
    const newOrgRenders = renders.filter((render) => render.org === 'org-2');
    expect(newOrgRenders.length).toBeGreaterThan(0);
    expect(newOrgRenders.every((render) => render.status === 'loading' && !render.enabled)).toBe(true);
    expect(result.current.enabledModules.size).toBe(0);
  });
});
