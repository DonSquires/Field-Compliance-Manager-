import { describe, expect, it } from 'vitest';
import { getClientPortalPages, isClientPortalPage } from './clientPortalAccess';

describe('client portal agreement access', () => {
  it('keeps transparency-only agreements limited to overview, delivery and enabled reports', () => {
    expect([...getClientPortalPages({ mode: 'transparency_only', reportsEnabled: true, financeEnabled: false })]).toEqual(['overview', 'delivery', 'reports']);
  });

  it('allows operational reads only for full-module agreements', () => {
    const pages = getClientPortalPages({ mode: 'full_modules', reportsEnabled: false, financeEnabled: false });
    expect(pages.has('delivery')).toBe(true);
    expect(pages.has('sites')).toBe(true);
    expect(pages.has('observations')).toBe(true);
    expect(pages.has('reports')).toBe(false);
    expect(pages.has('finance')).toBe(false);
    expect(pages.has('scan')).toBe(false);
  });

  it('keeps scan-only access distinct from the operational portal', () => {
    expect([...getClientPortalPages({ mode: 'scan_only', reportsEnabled: false, financeEnabled: false })]).toEqual(['overview', 'scan']);
  });

  it('shows nothing but the overview when no agreement is selected', () => {
    expect([...getClientPortalPages(null)]).toEqual(['overview']);
    expect(isClientPortalPage('delivery')).toBe(true);
  });

  it('adds finance only when the agreement enables client billing visibility', () => {
    const pages = getClientPortalPages({ mode: 'transparency_only', reportsEnabled: false, financeEnabled: true });
    expect(pages.has('finance')).toBe(true);
  });

  it('rejects unknown direct routes', () => {
    expect(isClientPortalPage('sites')).toBe(true);
    expect(isClientPortalPage('finance')).toBe(true);
    expect(isClientPortalPage(undefined)).toBe(false);
  });
});