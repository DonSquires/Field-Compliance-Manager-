/**
 * moduleAccessMessage.ts — one shared source of gating language for every
 * shell/screen that surfaces a module, per Bob's UX review (docs/ui-baseline.md
 * "Bob's UX presentation review"):
 *
 *   1. loading / error / unconfigured must never collapse into the same
 *      visible outcome.
 *   2. safety-relevant surfaces must say "unavailable, could not verify
 *      configuration" — never silently hide or silently show.
 *   3. "not enabled for this organisation" is distinct wording from
 *      "missing"/"broken".
 *   4. shell consistency is satisfied structurally: every shell calls this
 *      SAME function, so admin and officer can never draw different
 *      conclusions from the same backend state.
 *   9. every blocked/unavailable outcome carries a compact explanation and
 *      the responsible scope, never a bare dead end.
 */
import type { ModuleGateStatus } from '../hooks/useEnabledModules';

export type AccessTone = 'visible' | 'unavailable' | 'blocked';

export interface ModuleAccessMessage {
  tone: AccessTone;
  /** Short label suitable for a nav item / tab / button. */
  title: string;
  /** Longer explanation suitable for a body/detail area. */
  description: string;
}

export function getModuleAccessMessage(
  status: ModuleGateStatus,
  isEnabled: boolean,
  options: { safetyRelevant?: boolean; moduleLabel: string } = { moduleLabel: 'This module' },
): ModuleAccessMessage {
  const { safetyRelevant = false, moduleLabel } = options;

  if (status === 'loading') {
    return safetyRelevant
      ? { tone: 'blocked', title: `${moduleLabel} — checking access…`, description: `${moduleLabel} configuration is still loading. Safety-relevant features stay hidden until access can be confirmed.` }
      : { tone: 'unavailable', title: `${moduleLabel} — loading…`, description: `${moduleLabel} configuration is still loading.` };
  }

  if (status === 'error') {
    return {
      tone: 'blocked',
      title: `${moduleLabel} — unavailable`,
      description: `${moduleLabel} is unavailable because its configuration could not be verified. This is not the same as being disabled — try again, and contact your administrator if it persists.`,
    };
  }

  if (status === 'unconfigured') {
    return safetyRelevant
      ? { tone: 'blocked', title: `${moduleLabel} — unavailable`, description: `${moduleLabel} is unavailable because organisation configuration could not be verified. Contact your administrator.` }
      : { tone: 'visible', title: moduleLabel, description: `${moduleLabel} is available (no organisation-specific configuration is set yet).` };
  }

  // status === 'configured'
  if (isEnabled) {
    return { tone: 'visible', title: moduleLabel, description: `${moduleLabel} is enabled for your organisation.` };
  }
  return {
    tone: 'unavailable',
    title: `${moduleLabel} — not enabled`,
    description: `${moduleLabel} is not enabled for this organisation. It is not missing or broken — contact your administrator if you believe it should be available.`,
  };
}
