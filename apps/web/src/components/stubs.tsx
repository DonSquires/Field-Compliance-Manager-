import React, { useState, useCallback } from 'react';

// BobPanel moved to ./BobPanel.tsx — real bob_conversations/bob_messages wiring.

/**
 * NotificationsBell — Simple notification button with badge support
 * TODO: Wire to bob_notifications/welfare_alerts for unread count
 */
export const NotificationsBell: React.FC<{
  unreadCount?: number;
  onNavigate?: (page: string) => void;
  onOpenBob?: () => void;
}> = ({ unreadCount = 0, onNavigate, onOpenBob }) => (
  <button
    onClick={() => onOpenBob?.() || onNavigate?.('welfare-alerts')}
    style={{
      fontSize: '20px',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      position: 'relative',
      padding: '8px',
    }}
    title={unreadCount > 0 ? `${unreadCount} unread notifications` : 'Notifications'}
  >
    🔔
    {unreadCount > 0 && (
      <span
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          background: '#EF5350',
          color: 'white',
          borderRadius: '50%',
          width: '16px',
          height: '16px',
          fontSize: '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
        }}
      >
        {unreadCount > 9 ? '9+' : unreadCount}
      </span>
    )}
  </button>
);

/**
 * PortalSwitcher — Show current portal role; allow sign out
 * TODO: Full portal switching when multi-role support is needed
 */
export const PortalSwitcher: React.FC<{
  currentPortal?: 'admin' | 'officer';
  userRole?: string;
  onLogout?: () => void;
}> = ({ currentPortal = 'admin', userRole = 'officer', onLogout }) => {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          padding: '8px 12px',
          borderRadius: '4px',
          border: '1px solid #334155',
          background: '#0f172a',
          cursor: 'pointer',
          fontSize: '13px',
          fontWeight: 500,
          color: '#e2e8f0',
        }}
      >
        {userRole} {open ? '▲' : '▼'}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: '4px',
            marginTop: '4px',
            zIndex: 100,
            minWidth: '120px',
          }}
        >
          <button
            onClick={() => {
              onLogout?.();
              setOpen(false);
            }}
            style={{
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              background: 'transparent',
              color: '#e2e8f0',
              cursor: 'pointer',
              fontSize: '13px',
              textAlign: 'left',
              borderRadius: '4px',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#1a2942')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * UniversalSearch — Basic search input
 * TODO: Wire to bob-query-records or similar for live search results
 */
export const UniversalSearch: React.FC<{
  onSearch?: (query: string) => void;
  onNavigate?: ((page: string, query?: string) => void) | ((page: string) => void);
}> = ({ onSearch, onNavigate }) => {
  const [query, setQuery] = useState('');

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (query.trim()) {
        onSearch?.(query);
        (onNavigate as any)?.('vehicle-search', query);
      }
    },
    [query, onSearch, onNavigate]
  );

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex' }}>
      <input
        type="search"
        placeholder="Search organizations, sites, vehicles..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          padding: '8px 12px',
          borderRadius: '4px',
          border: '1px solid #334155',
          width: '240px',
          background: '#0f172a',
          color: '#e2e8f0',
          fontSize: '13px',
        }}
        onFocus={(e) => (e.currentTarget.style.borderColor = '#7db7e8')}
        onBlur={(e) => (e.currentTarget.style.borderColor = '#334155')}
      />
    </form>
  );
};

/**
 * ReportButton — Quick report filing button
 * TODO: Wire to OfficerFieldReportPage or a modal form
 */
export const ReportButton: React.FC<{
  onClick?: () => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}> = ({ onClick, disabled = false, style }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={style ?? {
      padding: '8px 12px',
      borderRadius: '4px',
      border: '1px solid #334155',
      background: disabled ? '#1a1a1a' : '#0f172a',
      color: disabled ? '#666' : '#e2e8f0',
      cursor: disabled ? 'default' : 'pointer',
      fontSize: '13px',
      fontWeight: 500,
      transition: 'all 0.2s',
    }}
    onMouseEnter={(e) => !disabled && (e.currentTarget.style.background = '#1a2942')}
    onMouseLeave={(e) => !disabled && (e.currentTarget.style.background = '#0f172a')}
  >
    📝 Report
  </button>
);
