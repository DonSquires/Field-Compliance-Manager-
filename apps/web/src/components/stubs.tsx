import React from 'react';

// BobPanel moved to ./BobPanel.tsx — real bob_conversations/bob_messages wiring.

export const NotificationsBell: React.FC<any> = (props) => (
  <button {...props} style={{ fontSize: '20px', background: 'none', border: 'none', cursor: 'pointer' }}>
    🔔
  </button>
);

export const PortalSwitcher: React.FC<any> = ({ onSwitch }) => (
  <div style={{ padding: '8px' }}>
    <button onClick={() => onSwitch?.('admin')} style={{ marginRight: '8px', padding: '8px 12px', borderRadius: '4px', border: '1px solid #ccc', background: '#f0f0f0', cursor: 'pointer' }}>
      Admin
    </button>
    <button onClick={() => onSwitch?.('officer')} style={{ marginRight: '8px', padding: '8px 12px', borderRadius: '4px', border: '1px solid #ccc', background: '#f0f0f0', cursor: 'pointer' }}>
      Officer
    </button>
  </div>
);

export const UniversalSearch: React.FC<any> = (props) => (
  <input {...props} type="search" placeholder="Search..." style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid #ccc', width: '200px' }} />
);

export const ReportButton: React.FC<any> = ({ style, ...props }) => (
  <button {...props} style={style ?? { padding: '8px 12px', borderRadius: '4px', border: 'none', cursor: 'pointer' }}>
    📝 Report
  </button>
);
