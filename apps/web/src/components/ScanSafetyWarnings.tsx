/**
 * ScanSafetyWarnings.tsx — the redacted hazard list returned on a scan
 * (`safety_warnings` from process-officer-scan → get_safety_warnings).
 * Shown before anything else the officer might act on: what to expect, how
 * serious, who raised it and how to reach them. Never the narrative.
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { alertLevelLabel, hazardClassLabel, highestAlertLevel, safetyWarningTone } from '../lib/safetyWarnings';
import './ScanSafetyWarnings.css';

export interface ScanSafetyWarning {
  id: string;
  hazard_class: string;
  alert_level: string;
  raised_at: string;
  organization_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  is_own_organization: boolean;
}

export const ScanSafetyWarnings: React.FC<{ warnings: ScanSafetyWarning[] | null | undefined }> = ({ warnings }) => {
  if (!warnings || warnings.length === 0) return null;
  const worst = highestAlertLevel(warnings);
  return (
    <section className={`scan-safety scan-safety--${safetyWarningTone(worst)}`} role="alert" aria-label="Safety warnings on this vehicle" data-testid="scan-safety-warnings">
      <div className="scan-safety__title">
        <AlertTriangle size={18} aria-hidden="true" />
        <strong>Safety warning{warnings.length === 1 ? '' : 's'} on this vehicle — read before approaching</strong>
      </div>
      <ul className="scan-safety__list">
        {warnings.map((warning) => {
          const contact = [warning.contact_phone, warning.contact_email].filter((value): value is string => Boolean(value && value.trim()));
          return (
            <li key={warning.id} className={`scan-safety__item scan-safety__item--${safetyWarningTone(warning.alert_level)}`}>
              <span className="scan-safety__hazard">{hazardClassLabel(warning.hazard_class)}</span>
              <span className="scan-safety__level">{alertLevelLabel(warning.alert_level)}</span>
              <span className="scan-safety__source">
                {warning.is_own_organization ? 'Raised by your organisation' : `Raised by ${warning.organization_name ?? 'another organisation'}`}
                {!warning.is_own_organization && contact.length > 0 ? ` · contact ${contact.join(' / ')}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default ScanSafetyWarnings;
