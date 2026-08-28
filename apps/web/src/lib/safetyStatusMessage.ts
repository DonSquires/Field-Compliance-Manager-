/**
 * safetyStatusMessage.ts — officer-facing plain-language text for man-down
 * detection state and alert lifecycle, per Bob's UX review items 6 and 7:
 *
 *   6. Whether detection is active, org-disabled, officer-disabled, or
 *      unknown must be visible to the officer in plain language — safety
 *      systems should not feel mysterious.
 *   7. Since movement can no longer auto-resolve an alert, resolution is
 *      always an explicit officer action — the wording must say so plainly,
 *      so it never looks like an alert vanished arbitrarily.
 */
import type { DetectionState } from '../hooks/useOfficerSafety';

export function getDetectionStatusMessage(state: DetectionState): string {
  switch (state) {
    case 'active':
      return 'Man-down detection is active.';
    case 'disabled_by_org':
      return 'Man-down detection is turned off for your organisation. Contact your administrator if you believe this should be enabled.';
    case 'disabled_by_officer':
      return 'Man-down detection is turned off in your personal settings.';
    case 'unknown':
      return 'Man-down detection status is not yet known.';
  }
}

export function getAlertResolvedMessage(resolvedBy: 'check_in' | 'acknowledge'): string {
  return resolvedBy === 'check_in'
    ? 'This alert was cleared because you checked in.'
    : 'You acknowledged and cleared this alert.';
}
