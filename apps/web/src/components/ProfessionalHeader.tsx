/**
 * ProfessionalHeader.tsx — Top navigation and actionbar
 * 
 * Enterprise-grade header with:
 * - Breadcrumb navigation
 * - Live status indicators
 * - User profile menu
 * - Notifications
 * - Quick actions
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface HeaderProps {
  title?: string;
  subtitle?: string;
  breadcrumbs?: Array<{ label: string; path?: string }>;
  actions?: Array<{ label: string; onClick: () => void; variant?: 'primary' | 'secondary' | 'danger' }>;
  userDisplayName?: string;
  onLogout?: () => void;
  statusIndicator?: {
    status: 'online' | 'idle' | 'offline';
    label: string;
  };
  notificationCount?: number;
  onNotifications?: () => void;
}

export const ProfessionalHeader: React.FC<HeaderProps> = ({
  title,
  subtitle,
  breadcrumbs,
  actions,
  userDisplayName,
  onLogout,
  statusIndicator,
  notificationCount = 0,
  onNotifications,
}) => {
  const navigate = useNavigate();
  const [showUserMenu, setShowUserMenu] = useState(false);

  return (
    <header
      style={{
        backgroundColor: 'var(--color-bg-surface)',
        borderBottom: '1px solid var(--color-border)',
        boxShadow: 'var(--shadow-sm)',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}
    >
      {/* Breadcrumb and actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          padding: 'var(--space-4)',
          borderBottom: breadcrumbs || title ? '1px solid var(--color-border-light)' : 'none',
        }}
      >
        {/* Left: Breadcrumbs */}
        {breadcrumbs && (
          <nav style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {breadcrumbs.map((crumb, idx) => (
              <React.Fragment key={idx}>
                {idx > 0 && <span style={{ color: 'var(--color-text-tertiary)' }}>›</span>}
                {crumb.path ? (
                  <button
                    onClick={() => navigate(crumb.path!)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--color-primary)',
                      cursor: 'pointer',
                      fontSize: 'var(--text-sm)',
                      textDecoration: 'none',
                    }}
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
                    {crumb.label}
                  </span>
                )}
              </React.Fragment>
            ))}
          </nav>
        )}

        {/* Right: Actions, notifications, user menu */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', marginLeft: 'auto' }}>
          {/* Actions */}
          {actions && actions.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              {actions.map((action, idx) => (
                <button
                  key={idx}
                  onClick={action.onClick}
                  className={`btn-${action.variant || 'secondary'}`}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}

          {/* Notifications */}
          {onNotifications && (
            <button
              onClick={onNotifications}
              style={{
                position: 'relative',
                background: 'none',
                border: 'none',
                fontSize: 'var(--text-lg)',
                cursor: 'pointer',
                padding: 'var(--space-2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title="Notifications"
            >
              🔔
              {notificationCount > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: '0',
                    right: '0',
                    minWidth: '20px',
                    height: '20px',
                    borderRadius: 'var(--radius-full)',
                    backgroundColor: 'var(--color-error)',
                    color: 'var(--color-text-inverse)',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 'var(--font-bold)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {notificationCount > 9 ? '9+' : notificationCount}
                </span>
              )}
            </button>
          )}

          {/* Status indicator */}
          {statusIndicator && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                fontSize: 'var(--text-sm)',
              }}
            >
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor:
                    statusIndicator.status === 'online'
                      ? 'var(--color-success)'
                      : statusIndicator.status === 'idle'
                        ? 'var(--color-warning)'
                        : 'var(--color-neutral-400)',
                }}
              />
              <span style={{ color: 'var(--color-text-secondary)' }}>
                {statusIndicator.label}
              </span>
            </div>
          )}

          {/* User menu */}
          {userDisplayName && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                style={{
                  background: 'none',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-full)',
                  padding: 'var(--space-1) var(--space-3)',
                  cursor: 'pointer',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                }}
              >
                <span style={{ width: '24px', height: '24px', borderRadius: 'var(--radius-full)', backgroundColor: 'var(--color-primary)', color: 'var(--color-text-inverse)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)' }}>
                  {userDisplayName.charAt(0).toUpperCase()}
                </span>
                {userDisplayName}
              </button>

              {showUserMenu && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + var(--space-2))',
                    right: '0',
                    backgroundColor: 'var(--color-neutral-0)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-lg)',
                    boxShadow: 'var(--shadow-lg)',
                    zIndex: 1000,
                    minWidth: '200px',
                  }}
                >
                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      onLogout?.();
                    }}
                    style={{
                      width: '100%',
                      padding: 'var(--space-3) var(--space-4)',
                      background: 'none',
                      border: 'none',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--color-error)',
                      borderRadius: 'var(--radius-lg)',
                    }}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Title section */}
      {title && (
        <div style={{ padding: 'var(--space-4)', paddingTop: 'var(--space-3)' }}>
          <h1
            style={{
              margin: '0 0 var(--space-1) 0',
              fontSize: 'var(--text-3xl)',
              fontWeight: 'var(--font-bold)',
            }}
          >
            {title}
          </h1>
          {subtitle && (
            <p style={{ margin: '0', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
              {subtitle}
            </p>
          )}
        </div>
      )}
    </header>
  );
};

export default ProfessionalHeader;
