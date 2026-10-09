import React, { useEffect, useMemo, useState } from 'react';
import { Building2, ChevronLeft, ChevronRight, Eye, FileText, LayoutDashboard, LogOut, Menu, Receipt, ScanLine, Shield, Users, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { NotificationCenter, type NotificationRecord } from '../components/NotificationCenter';
import { ClientPortalPage as ClientPortalContent } from '../pages/ClientPortalPage';
import { getClientPortalPages, isClientPortalPage, type ClientPortalPage } from '../lib/clientPortalAccess';
import { resolveNotificationDestination } from '../lib/notificationNavigation';
import { HelpInstructions } from '../components/HelpInstructions';
import './ClientShell.css';

const NAVIGATION: Array<{ id: ClientPortalPage; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'delivery', label: 'Service delivered', icon: Shield },
  { id: 'sites', label: 'Sites and zones', icon: Building2 },
  { id: 'observations', label: 'Observations', icon: Eye },
  { id: 'reports', label: 'Reports', icon: FileText },
  { id: 'finance', label: 'Invoices', icon: Receipt },
  { id: 'scan', label: 'Scan access', icon: ScanLine },
  { id: 'people', label: 'Your people', icon: Users },
];

export function ClientShell() {
  const { profile, signOut } = useAuth();
  const relationships = useServiceRelationships();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const routeSegment = location.pathname.split('/').filter(Boolean)[1];
  const activePage: ClientPortalPage = isClientPortalPage(routeSegment) ? routeSegment : 'overview';
  const agreement = relationships.selectedAgreement;
  const allowedPages = useMemo(() => getClientPortalPages(agreement ? {
    mode: agreement.client_portal_access_mode as 'transparency_only' | 'full_modules' | 'scan_only' | null,
    reportsEnabled: agreement.client_portal_reports_enabled,
    financeEnabled: agreement.client_portal_finance_enabled,
  } : null, profile?.role), [agreement, profile?.role]);

  useEffect(() => {
    if (routeSegment && !isClientPortalPage(routeSegment)) navigate('/client', { replace: true });
  }, [navigate, routeSegment]);

  useEffect(() => {
    if (!relationships.loading && !allowedPages.has(activePage)) navigate('/client', { replace: true });
  }, [activePage, allowedPages, navigate, relationships.loading]);

  if (!profile) return <div className="client-shell-loading">Loading client portal</div>;

  const availableNavigation = NAVIGATION.filter((item) => allowedPages.has(item.id));

  const openPage = (page: ClientPortalPage) => {
    navigate(page === 'overview' ? '/client' : `/client/${page}`);
    setMobileOpen(false);
  };

  const navigateFromNotification = (notification: NotificationRecord) => {
    const destination = resolveNotificationDestination(profile.role, notification);
    if (!destination || destination.kind !== 'client_page' || !isClientPortalPage(destination.page)) return false;
    if (!allowedPages.has(destination.page)) return false;
    openPage(destination.page);
    return true;
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  const navigation = (
    <>
      <button type="button" className="client-shell-brand" onClick={() => openPage('overview')} title="Client portal home">
        <img
          src="https://dotczcyyzgabmtmnglqj.supabase.co/storage/v1/object/public/Logo/IES%20Logo.jpg"
          alt="Iron Eagle Security"
          className="client-brand-logo"
        />
        {!collapsed && <div><strong>Field Compliance</strong><small>Client portal</small></div>}
      </button>

      <nav className="client-shell-nav" aria-label="Client portal">
        {availableNavigation.map((item) => {
          const Icon = item.icon;
          return (
            <button type="button" key={item.id} className={activePage === item.id ? 'is-active' : ''} onClick={() => openPage(item.id)} title={collapsed ? item.label : undefined}>
              <Icon size={19} aria-hidden="true" />
              {!collapsed && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      <div className="client-shell-sidebar-footer">
        {!collapsed && agreement && <div className="client-shell-agreement"><span>Selected service</span><strong>{agreement.name}</strong></div>}
        <button type="button" onClick={() => void handleSignOut()} title="Sign out"><LogOut size={18} aria-hidden="true" />{!collapsed && <span>Sign out</span>}</button>
      </div>
    </>
  );

  return (
    <div className="client-shell" data-theme="light">
      <aside className={`client-shell-sidebar ${collapsed ? 'is-collapsed' : ''}`}>
        {navigation}
        <button type="button" className="client-collapse-button" onClick={() => setCollapsed((value) => !value)} title={collapsed ? 'Expand navigation' : 'Collapse navigation'}>
          {collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
        </button>
      </aside>

      {mobileOpen && <button type="button" className="client-mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
      <aside className={`client-mobile-drawer ${mobileOpen ? 'is-open' : ''}`}>
        <button type="button" className="client-mobile-close" onClick={() => setMobileOpen(false)} title="Close navigation"><X size={19} /><span className="sr-only">Close navigation</span></button>
        {navigation}
      </aside>

      <div className="client-shell-main">
        <header className="client-shell-topbar">
          <button type="button" className="client-mobile-menu" onClick={() => setMobileOpen(true)} title="Open navigation"><Menu size={20} /><span className="sr-only">Open navigation</span></button>
          <div><strong>{agreement?.client_name ?? 'Client portal'}</strong><small>{agreement?.provider_name ? `Service by ${agreement.provider_name}` : 'Service relationship loading'}</small></div>
          <NotificationCenter onNavigate={navigateFromNotification} />
          <HelpInstructions context={`client ${activePage}`} role={profile.role} />
          <span className="client-role-badge">{profile.role.replace('client_', '')}</span>
        </header>
        <main className="client-shell-content" data-app-content>
          {/* A client reads delivered records; nothing here needs their position, so no geolocation prompt or evidence banner. */}
          <ClientPortalContent page={activePage} />
        </main>
      </div>
    </div>
  );
}