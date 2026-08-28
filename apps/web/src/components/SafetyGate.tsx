/**
 * SafetyGate.tsx — the single enforcement point for "action-level and
 * data-level fail-closed", per Bob's cross-app gating audit (docs/ui-baseline.md).
 *
 * The module-gating fix in useEnabledModules.ts only helps if every consumer
 * actually calls it correctly. Menu-level hiding is not enough: a heat map's
 * data layer, a dispatch panel's quick-action buttons, or a live-monitoring
 * websocket consumer can each independently render/subscribe without ever
 * checking gating state, even after the nav item that would lead to them is
 * correctly hidden. This component exists so no future page, widget, map
 * layer, or subscription consumer has to reinvent the fail-closed decision —
 * it converges every consumer on the exact same four states.
 *
 * Usage: wrap ANY safety-sensitive rendering — not just page-level routes,
 * but individual map layers, panel sections, and action buttons — in this
 * gate rather than checking `isModuleEnabled` ad hoc at each call site.
 */
import type { ReactNode } from 'react';
import type { ModuleGateStatus } from '../hooks/useEnabledModules';
import { getModuleAccessMessage } from '../lib/moduleAccessMessage';

export interface SafetyGateProps {
  status: ModuleGateStatus;
  isEnabled: boolean;
  moduleLabel: string;
  /** True for anything welfare/man-down/safety related; false for ordinary feature discovery. */
  safetyRelevant: boolean;
  children: ReactNode;
  /** Optional custom renderer for the blocked/unavailable state; defaults to plain text. */
  renderUnavailable?: (message: { title: string; description: string }) => ReactNode;
}

/**
 * Renders `children` ONLY when access is positively confirmed. For
 * safety-relevant content this means status === 'configured' AND enabled —
 * loading, error, and unconfigured are all treated as "do not render the
 * real content," never as an opportunity to render it anyway because data
 * happens to have already arrived from some other fetch.
 */
export function SafetyGate({ status, isEnabled, moduleLabel, safetyRelevant, children, renderUnavailable }: SafetyGateProps) {
  const message = getModuleAccessMessage(status, isEnabled, { safetyRelevant, moduleLabel });

  if (message.tone === 'visible') return <>{children}</>;

  if (renderUnavailable) return <>{renderUnavailable(message)}</>;
  return (
    <div role="status" aria-live="polite">
      <strong>{message.title}</strong>
      <p>{message.description}</p>
    </div>
  );
}
