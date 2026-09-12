import type { ReactNode } from 'react';
import './ShellLayout.css';

export type ShellKind = 'officer' | 'admin' | 'master';

interface ShellLayoutProps {
  shell: ShellKind;
  children: ReactNode;
  topBar?: ReactNode;
  filterRibbon?: ReactNode;
  pageHeader?: ReactNode;
  statusStrip?: ReactNode;
  primaryAction?: ReactNode;
  className?: string;
}

export function ShellLayout({
  shell,
  children,
  topBar,
  filterRibbon,
  pageHeader,
  statusStrip,
  primaryAction,
  className = '',
}: ShellLayoutProps) {
  return (
    <div className={`shell-layout shell-layout--${shell} ${className}`.trim()}>
      {topBar && <div className="shell-layout__topbar">{topBar}</div>}
      {filterRibbon && <div className="shell-layout__filter-ribbon">{filterRibbon}</div>}
      {pageHeader && <div className="shell-layout__page-header">{pageHeader}</div>}
      {statusStrip && <div className="shell-layout__status-strip">{statusStrip}</div>}
      {primaryAction && <div className="shell-layout__primary-action">{primaryAction}</div>}
      <main className="shell-layout__content">{children}</main>
    </div>
  );
}