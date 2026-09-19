export type ClientPortalMode = 'transparency_only' | 'full_modules' | 'scan_only';
export type ClientPortalPage = 'overview' | 'delivery' | 'sites' | 'observations' | 'reports' | 'finance' | 'scan';

export interface ClientPortalAgreementAccess {
  mode: ClientPortalMode | null;
  reportsEnabled: boolean;
  financeEnabled: boolean;
}

export function getClientPortalPages(access: ClientPortalAgreementAccess | null): ReadonlySet<ClientPortalPage> {
  if (!access) return new Set<ClientPortalPage>(['overview']);

  const pages = new Set<ClientPortalPage>(['overview']);
  // Transparency is the point of the portal: what was delivered at the client's places is visible in every operational mode.
  if (access.mode === 'transparency_only' || access.mode === 'full_modules') pages.add('delivery');
  if (access.reportsEnabled) pages.add('reports');
  if (access.financeEnabled) pages.add('finance');
  if (access.mode === 'full_modules') {
    pages.add('sites');
    pages.add('observations');
  }
  if (access.mode === 'scan_only') pages.add('scan');
  return pages;
}

export function isClientPortalPage(value: string | undefined): value is ClientPortalPage {
  return value === 'overview' || value === 'delivery' || value === 'sites' || value === 'observations' || value === 'reports' || value === 'finance' || value === 'scan';
}