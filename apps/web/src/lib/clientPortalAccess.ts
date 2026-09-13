export type ClientPortalMode = 'transparency_only' | 'full_modules' | 'scan_only';
export type ClientPortalPage = 'overview' | 'sites' | 'observations' | 'reports' | 'finance' | 'scan';

export interface ClientPortalAgreementAccess {
  mode: ClientPortalMode | null;
  reportsEnabled: boolean;
  financeEnabled: boolean;
}

export function getClientPortalPages(access: ClientPortalAgreementAccess | null): ReadonlySet<ClientPortalPage> {
  if (!access) return new Set<ClientPortalPage>(['overview']);

  const pages = new Set<ClientPortalPage>(['overview']);
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
  return value === 'overview' || value === 'sites' || value === 'observations' || value === 'reports' || value === 'finance' || value === 'scan';
}