/**
 * ObservationList.tsx — Professional observation/scan history
 * 
 * Shows recent observations with:
 * - Plate number
 * - Compliance status badge
 * - Time recorded
 * - Zone name
 * - Sorting and filtering
 */

import React, { useMemo } from 'react';

export interface ObservationRecord {
  id: string;
  plate_number: string;
  is_compliant: boolean | null;
  compliance_reason: string | null;
  nights_this_zone: number | null;
  nights_this_month: number | null;
  observed_at: string;
  zone_name?: string;
}

interface ObservationListProps {
  observations: ObservationRecord[];
  loading?: boolean;
  filter?: 'all' | 'breach' | 'compliant';
  plateFilter?: string;
  onFilterChange?: (filter: 'all' | 'breach' | 'compliant') => void;
  onPlateFilterChange?: (plate: string) => void;
}

export const ObservationList: React.FC<ObservationListProps> = ({
  observations,
  loading = false,
  filter = 'all',
  plateFilter = '',
  onFilterChange,
  onPlateFilterChange,
}) => {
  const filtered = useMemo(() => {
    return observations.filter((obs) => {
      if (filter === 'breach' && obs.is_compliant !== false) return false;
      if (filter === 'compliant' && obs.is_compliant !== true) return false;
      if (plateFilter && !obs.plate_number.includes(plateFilter.toUpperCase())) return false;
      return true;
    });
  }, [observations, filter, plateFilter]);

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {/* Filter controls */}
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: 'var(--color-text-secondary)' }}>
          Filter:
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {(['all', 'compliant', 'breach'] as const).map((f) => (
            <button
              key={f}
              onClick={() => onFilterChange?.(f)}
              className={f === filter ? 'fc-filter is-active' : 'fc-filter'}
            >
              {f === 'all' ? 'All Observations' : f === 'compliant' ? '✓ Compliant' : '✗ Breach'}
            </button>
          ))}
        </div>

        {/* Plate filter */}
        <input
          type="text"
          placeholder="Filter by plate..."
          value={plateFilter}
          onChange={(e) => onPlateFilterChange?.(e.target.value)}
          style={{
            marginLeft: 'auto',
            padding: 'var(--space-2) var(--space-3)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-sm)',
            minWidth: '200px',
          }}
        />
      </div>

      {/* Table or empty state */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--color-text-secondary)' }}>
          <div className="spinner" style={{ margin: '0 auto var(--space-3)' }} />
          Loading observations...
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--color-text-secondary)' }}>
          <div style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-2)' }}>No observations found</div>
          <p>
            {plateFilter
              ? `No matches for "${plateFilter}"`
              : filter === 'breach'
                ? 'No breaches recorded'
                : filter === 'compliant'
                  ? 'No compliant observations'
                  : 'Start recording observations to see them here'}
          </p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--color-bg-secondary)', borderBottom: '2px solid var(--color-border)' }}>
                <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'left', fontWeight: 'var(--font-bold)', fontSize: 'var(--text-xs)', color: 'var(--color-text-primary)' }}>
                  Plate
                </th>
                <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'left', fontWeight: 'var(--font-bold)', fontSize: 'var(--text-xs)', color: 'var(--color-text-primary)' }}>
                  Status
                </th>
                <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'left', fontWeight: 'var(--font-bold)', fontSize: 'var(--text-xs)', color: 'var(--color-text-primary)' }}>
                  Zone
                </th>
                <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'left', fontWeight: 'var(--font-bold)', fontSize: 'var(--text-xs)', color: 'var(--color-text-primary)' }}>
                  Nights (Zone / Month)
                </th>
                <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign: 'left', fontWeight: 'var(--font-bold)', fontSize: 'var(--text-xs)', color: 'var(--color-text-primary)' }}>
                  Recorded
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((obs) => {
                const isCompliant = obs.is_compliant;
                const statusColor = isCompliant === true ? 'var(--color-compliant)' : isCompliant === false ? 'var(--color-breach)' : 'var(--color-pending)';
                const statusLabel = isCompliant === true ? 'Compliant' : isCompliant === false ? 'Breach' : 'Pending';

                return (
                  <tr
                    key={obs.id}
                    style={{
                      borderBottom: '1px solid var(--color-border-light)',
                      backgroundColor: isCompliant === false ? 'rgba(239, 68, 68, 0.03)' : 'transparent',
                    }}
                  >
                    <td style={{ padding: 'var(--space-3) var(--space-4)', fontFamily: 'var(--font-mono)', fontWeight: 'var(--font-semibold)', color: 'var(--color-text-primary)' }}>
                      {obs.plate_number}
                    </td>
                    <td style={{ padding: 'var(--space-3) var(--space-4)' }}>
                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 'var(--space-1)',
                          paddingLeft: 'var(--space-2)',
                          paddingRight: 'var(--space-2)',
                          paddingTop: 'var(--space-1)',
                          paddingBottom: 'var(--space-1)',
                          borderRadius: 'var(--radius-full)',
                          backgroundColor: `${statusColor}20`,
                          color: statusColor,
                          fontSize: 'var(--text-xs)',
                          fontWeight: 'var(--font-bold)',
                        }}
                      >
                        <span
                          style={{
                            width: '6px',
                            height: '6px',
                            borderRadius: '50%',
                            backgroundColor: statusColor,
                          }}
                        />
                        {statusLabel}
                      </div>
                    </td>
                    <td style={{ padding: 'var(--space-3) var(--space-4)', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
                      {obs.zone_name || '—'}
                    </td>
                    <td style={{ padding: 'var(--space-3) var(--space-4)', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
                      {obs.nights_this_zone ?? 0} / {obs.nights_this_month ?? 0}
                    </td>
                    <td style={{ padding: 'var(--space-3) var(--space-4)', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
                      {formatTime(obs.observed_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
