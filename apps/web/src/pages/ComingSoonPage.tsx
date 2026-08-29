import React from 'react';

/**
 * Placeholder for admin surfaces not yet rebuilt against canonical schema.
 * Deliberately visible as "not built" rather than faking data wiring.
 */
const ComingSoonPage: React.FC<{ title?: string }> = ({ title = 'This page' }) => (
  <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>
    <div style={{ fontSize: '32px', marginBottom: '12px' }}>🚧</div>
    <h2 style={{ color: 'var(--color-text-primary)', margin: '0 0 8px 0' }}>{title}</h2>
    <p>Not yet rebuilt against canonical schema.</p>
  </div>
);

export default ComingSoonPage;
