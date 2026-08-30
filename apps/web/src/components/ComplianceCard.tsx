/**
 * ComplianceCard.tsx — Compliance verdict display component
 * 
 * Shows:
 * - Vehicle plate number
 * - Compliance status (green/red)
 * - Compliance reason
 * - Night counters (consecutive, monthly)
 * - Zone rules
 * - SCV requirement status
 */

import React from 'react';

export interface ComplianceVerdict {
  is_compliant: boolean;
  reason: string | null;
  nights_this_zone: number;
  nights_this_month: number;
  limit_consecutive: number | null;
  limit_monthly: number | null;
  scv_required: boolean;
  is_scv: boolean;
}

interface ComplianceCardProps {
  plate: string;
  verdict: ComplianceVerdict;
  loading?: boolean;
  onSubmit?: () => void;
}

export const ComplianceCard: React.FC<ComplianceCardProps> = ({
  plate,
  verdict,
  loading = false,
  onSubmit,
}) => {
  const statusColor = verdict.is_compliant ? 'var(--color-compliant)' : 'var(--color-breach)';
  const statusLabel = verdict.is_compliant ? 'Compliant' : 'Breach';

  return (
    <div
      style={{
        backgroundColor: 'var(--color-bg-primary)',
        border: `2px solid ${statusColor}`,
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-6)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 'var(--font-bold)', fontFamily: 'var(--font-mono)' }}>
            {plate}
          </h3>
        </div>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            paddingLeft: 'var(--space-3)',
            paddingRight: 'var(--space-3)',
            paddingTop: 'var(--space-1)',
            paddingBottom: 'var(--space-1)',
            borderRadius: 'var(--radius-full)',
            backgroundColor: `${statusColor}20`,
            color: statusColor,
            fontWeight: 'var(--font-bold)',
            fontSize: 'var(--text-sm)',
          }}
        >
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: statusColor,
            }}
          />
          {statusLabel}
        </div>
      </div>

      {verdict.reason && (
        <div style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-3)', backgroundColor: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-md)', borderLeft: `3px solid ${statusColor}` }}>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
            {verdict.reason}
          </p>
        </div>
      )}

      {/* Night counters */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-4)',
          marginBottom: 'var(--space-4)',
        }}
      >
        <div>
          <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-1)' }}>
            Consecutive Nights (This Zone)
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
            <span style={{ fontSize: 'var(--text-3xl)', fontWeight: 'var(--font-bold)' }}>
              {verdict.nights_this_zone}
            </span>
            {verdict.limit_consecutive && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                of {verdict.limit_consecutive}
              </span>
            )}
          </div>
          {verdict.limit_consecutive && (
            <div
              style={{
                marginTop: 'var(--space-2)',
                height: '6px',
                backgroundColor: 'var(--color-bg-secondary)',
                borderRadius: 'var(--radius-full)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${(verdict.nights_this_zone / verdict.limit_consecutive) * 100}%`,
                  backgroundColor: verdict.nights_this_zone >= verdict.limit_consecutive ? 'var(--color-error)' : 'var(--color-primary)',
                  borderRadius: 'var(--radius-full)',
                }}
              />
            </div>
          )}
        </div>

        <div>
          <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-1)' }}>
            Monthly Total
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
            <span style={{ fontSize: 'var(--text-3xl)', fontWeight: 'var(--font-bold)' }}>
              {verdict.nights_this_month}
            </span>
            {verdict.limit_monthly && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                of {verdict.limit_monthly}
              </span>
            )}
          </div>
          {verdict.limit_monthly && (
            <div
              style={{
                marginTop: 'var(--space-2)',
                height: '6px',
                backgroundColor: 'var(--color-bg-secondary)',
                borderRadius: 'var(--radius-full)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${(verdict.nights_this_month / verdict.limit_monthly) * 100}%`,
                  backgroundColor: verdict.nights_this_month >= verdict.limit_monthly ? 'var(--color-error)' : 'var(--color-primary)',
                  borderRadius: 'var(--radius-full)',
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* SCV Status */}
      <div style={{ marginBottom: 'var(--space-6)', paddingBottom: 'var(--space-4)', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
          Self-Contained Vehicle (SCV)
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <div
            style={{
              flex: 1,
              padding: 'var(--space-3)',
              backgroundColor: verdict.scv_required ? 'var(--color-error-light)' : 'var(--color-info-light)',
              borderRadius: 'var(--radius-md)',
              border: `1px solid ${verdict.scv_required ? 'var(--color-error)' : 'var(--color-info)'}`,
              color: verdict.scv_required ? '#7f1d1d' : '#0c4a6e',
            }}
          >
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)' }}>
              {verdict.scv_required ? 'Required' : 'Not Required'}
            </div>
          </div>
          <div
            style={{
              flex: 1,
              padding: 'var(--space-3)',
              backgroundColor: verdict.is_scv ? 'var(--color-success-light)' : 'var(--color-warning-light)',
              borderRadius: 'var(--radius-md)',
              border: `1px solid ${verdict.is_scv ? 'var(--color-success)' : 'var(--color-warning)'}`,
              color: verdict.is_scv ? '#065f46' : '#78350f',
            }}
          >
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)' }}>
              Vehicle is {verdict.is_scv ? 'SCV' : 'Not SCV'}
            </div>
          </div>
        </div>
      </div>

      {/* Submit button */}
      {onSubmit && (
        <button
          onClick={onSubmit}
          disabled={loading}
          className="btn-primary"
          style={{
            width: '100%',
            padding: 'var(--space-3)',
            fontSize: 'var(--text-base)',
            fontWeight: 'var(--font-bold)',
          }}
        >
          {loading ? 'Recording...' : 'Record Observation'}
        </button>
      )}
    </div>
  );
};
