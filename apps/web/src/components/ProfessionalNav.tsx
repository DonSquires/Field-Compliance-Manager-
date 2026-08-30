/**
 * ProfessionalNav.tsx — Enterprise sidebar/navigation component
 * 
 * Replaces emoji-based navigation with:
 * - Clear visual hierarchy
 * - Status indicators
 * - Grouped sections
 * - Tactile interactions
 * - Mobile-responsive collapse
 */

import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

interface NavSection {
  title: string;
  items: NavItem[];
}

interface NavItem {
  id: string;
  label: string;
  path: string;
  icon?: string;
  status?: 'active' | 'pending' | 'alerts' | 'none';
}

interface ProfessionalNavProps {
  sections: NavSection[];
  currentPath: string;
  onNavigate?: (path: string) => void;
  collapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
}

export const ProfessionalNav: React.FC<ProfessionalNavProps> = ({
  sections,
  currentPath,
  onNavigate,
  collapsed = false,
  onCollapseChange,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [localCollapsed, setLocalCollapsed] = useState(collapsed);

  const handleNavClick = (path: string) => {
    navigate(path);
    onNavigate?.(path);
  };

  const toggleCollapse = () => {
    setLocalCollapsed(!localCollapsed);
    onCollapseChange?.(!localCollapsed);
  };

  const getStatusBadge = (status?: string) => {
    switch (status) {
      case 'active':
        return (
          <span style={{
            display: 'inline-flex',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: 'var(--color-success)',
            marginLeft: 'var(--space-2)',
          }} title="Active" />
        );
      case 'pending':
        return (
          <span style={{
            display: 'inline-flex',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: 'var(--color-warning)',
            marginLeft: 'var(--space-2)',
          }} title="Pending" />
        );
      case 'alerts':
        return (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: '20px',
            height: '20px',
            borderRadius: 'var(--radius-full)',
            backgroundColor: 'var(--color-error)',
            color: 'var(--color-text-inverse)',
            fontSize: 'var(--text-xs)',
            fontWeight: 'var(--font-bold)',
            marginLeft: 'var(--space-2)',
          }} title="Alerts">
            !
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <nav
      style={{
        width: localCollapsed ? '60px' : '220px',
        height: '100vh',
        backgroundColor: 'var(--color-neutral-900)',
        color: 'var(--color-neutral-200)',
        borderRight: '1px solid var(--color-neutral-800)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width var(--transition-base)',
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      {/* Header with collapse button */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--space-4)',
        borderBottom: '1px solid var(--color-neutral-800)',
      }}>
        {!localCollapsed && (
          <div style={{
            fontSize: 'var(--text-lg)',
            fontWeight: 'var(--font-bold)',
            color: 'var(--color-text-inverse)',
          }}>
            FCM
          </div>
        )}
        <button
          onClick={toggleCollapse}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-neutral-400)',
            cursor: 'pointer',
            padding: 'var(--space-2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          title={localCollapsed ? 'Expand' : 'Collapse'}
        >
          {localCollapsed ? '→' : '←'}
        </button>
      </div>

      {/* Navigation sections */}
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 'var(--space-3)' }}>
        {sections.map((section, sectionIdx) => (
          <div key={sectionIdx} style={{ marginBottom: 'var(--space-6)' }}>
            {!localCollapsed && (
              <div style={{
                fontSize: 'var(--text-xs)',
                fontWeight: 'var(--font-bold)',
                textTransform: 'uppercase',
                letterSpacing: 'var(--letter-spacing-wide)',
                color: 'var(--color-neutral-500)',
                padding: '0 var(--space-4) var(--space-2)',
              }}>
                {section.title}
              </div>
            )}
            {section.items.map((item) => {
              const isActive = location.pathname === item.path || location.pathname.startsWith(item.path + '/');
              return (
                <button
                  key={item.id}
                  onClick={() => handleNavClick(item.path)}
                  style={{
                    width: '100%',
                    padding: localCollapsed ? 'var(--space-2) var(--space-3)' : 'var(--space-2) var(--space-4)',
                    margin: '2px 0',
                    background: isActive ? 'rgba(62, 150, 255, 0.15)' : 'none',
                    border: 'none',
                    borderLeft: isActive ? '3px solid var(--color-primary)' : '3px solid transparent',
                    color: isActive ? 'var(--color-primary-200)' : 'var(--color-neutral-400)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 'var(--text-sm)',
                    fontWeight: isActive ? 'var(--font-semibold)' : 'var(--font-regular)',
                    transition: 'all var(--transition-fast)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: localCollapsed ? '0' : 'var(--space-2)',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                  }}
                  title={localCollapsed ? item.label : undefined}
                >
                  {item.icon && (
                    <span style={{ minWidth: localCollapsed ? 'auto' : '24px' }}>
                      {item.icon}
                    </span>
                  )}
                  {!localCollapsed && (
                    <>
                      <span style={{ flex: 1 }}>{item.label}</span>
                      {getStatusBadge(item.status)}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{
        borderTop: '1px solid var(--color-neutral-800)',
        padding: 'var(--space-3) var(--space-4)',
        fontSize: 'var(--text-xs)',
        color: 'var(--color-neutral-500)',
        textAlign: 'center',
      }}>
        {!localCollapsed && 'Field Compliance Manager'}
      </div>
    </nav>
  );
};

export default ProfessionalNav;
