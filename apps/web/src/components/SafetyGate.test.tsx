import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SafetyGate } from './SafetyGate';

describe('SafetyGate', () => {
  it('never renders safety-relevant content while loading, on error, or unconfigured — data-level fail-closed, not just menu-level', () => {
    const states = ['loading', 'error', 'unconfigured'] as const;
    for (const status of states) {
      const { unmount } = render(
        <SafetyGate status={status} isEnabled={false} moduleLabel="Welfare" safetyRelevant>
          <div data-testid="real-content">Live welfare data</div>
        </SafetyGate>,
      );
      expect(screen.queryByTestId('real-content')).toBeNull();
      unmount();
    }
  });

  it('renders safety-relevant content only when status is configured AND enabled', () => {
    render(
      <SafetyGate status="configured" isEnabled={true} moduleLabel="Welfare" safetyRelevant>
        <div data-testid="real-content">Live welfare data</div>
      </SafetyGate>,
    );
    expect(screen.getByTestId('real-content')).toBeTruthy();
  });

  it('does not render safety-relevant content even when configured but disabled for this org', () => {
    render(
      <SafetyGate status="configured" isEnabled={false} moduleLabel="Welfare" safetyRelevant>
        <div data-testid="real-content">Live welfare data</div>
      </SafetyGate>,
    );
    expect(screen.queryByTestId('real-content')).toBeNull();
  });

  it('allows non-safety-relevant content to render on a genuinely unconfigured org (deliberate rollout allowance)', () => {
    render(
      <SafetyGate status="unconfigured" isEnabled={false} moduleLabel="Field Reports" safetyRelevant={false}>
        <div data-testid="real-content">Field reports UI</div>
      </SafetyGate>,
    );
    expect(screen.getByTestId('real-content')).toBeTruthy();
  });

  it('supports a custom unavailable renderer for map/panel/badge-specific presentation', () => {
    render(
      <SafetyGate
        status="error"
        isEnabled={false}
        moduleLabel="Welfare"
        safetyRelevant
        renderUnavailable={(msg) => <div data-testid="custom">{msg.title}</div>}
      >
        <div data-testid="real-content">Live welfare data</div>
      </SafetyGate>,
    );
    expect(screen.getByTestId('custom')).toBeTruthy();
    expect(screen.queryByTestId('real-content')).toBeNull();
  });
});
