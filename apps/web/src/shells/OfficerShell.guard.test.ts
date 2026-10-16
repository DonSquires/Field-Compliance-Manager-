import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');

describe('OfficerShell state routing', () => {
  it('integrates role-aware notifications', () => {
    expect(source).toContain('<NotificationCenter onNavigate={navigateFromNotification} />');
    expect(source).toContain('resolveNotificationDestination');
  });

  it('renders the officer home page for the home state', () => {
    expect(source).toContain("officerState === 'standby' || officerState === 'home'");
    expect(source).toContain('<OfficerHomePage shift={activeShift}');
  });

  it('only sends selector and portal states through module rendering', () => {
    expect(source).toContain("officerState === 'selector' || officerState === 'portal'");
    expect(source).not.toContain("officerState === 'home' || officerState === 'selector'");
  });

  it('uses one unified safety state and wires persistent actions', () => {
    expect(source).toContain('useOfficerSafety({');
    expect(source).not.toContain('useWelfareCheckin');
    expect(source).not.toContain('useManDownDetection');
    expect(source).toContain('safety.recordMovement');
    expect(source).toContain('safety.triggerSOS()');
    expect(source).toContain("navigateToModule('report')");
    expect(source).not.toContain('PttBar');
    expect(source).not.toContain('ReportButton');
    expect(source).toContain('safety.resolutionOutcome');
    expect(source).toContain('officer-shell-safety-outcome');
  });

  it('routes the module selector to its own URL', () => {
    expect(source).not.toContain("module === 'modules' || module === null");
    expect(source).toContain('navigate(`/officer/${module}`');
  });

  it('routes post-debrief actions through the owning officer shell', () => {
    expect(source).toContain("<OfficerDebriefPage onNavigate={(destination) => navigateToModule(destination === 'home' ? null : destination)} />");
  });

  it('blocks unauthorized module URLs and hides unapproved features from the officer shell', () => {
    expect(source).toContain('const canAccessOfficerModule = useCallback');
    expect(source).toContain("if (!canAccessOfficerModule(module)) {");
    expect(source).toContain("navigate('/officer', { replace: true });");
    expect(source).toContain('grantedModules.includes');
    expect(source).toContain('module === \'modules\'');
    expect(source).toContain('useActiveModuleContext');
    expect(source).toContain('moduleContext.enabled');
  });

  it('exposes stateful accessible semantics on persistent controls', () => {
    expect(source).toContain('aria-label="Open Bob command center"');
    // Bob docks beside the working page rather than replacing it.
    expect(source).toContain('onClick={() => setBobOpen(true)}');
    expect(source).toContain('aria-expanded={bobOpen}');
    expect(source).toContain("aria-current={activeModule === 'modules' ? 'page' : undefined}");
    expect(source).toContain("aria-current={activeModule === 'report' ? 'page' : undefined}");
  });

  it('shows field staff when evidence is queued because the device is offline', () => {
    expect(source).toContain('navigator.onLine');
    expect(source).toContain('No connection — field evidence will remain queued');
    expect(source).toContain('officer-shell-offline-banner');
    expect(source).toContain('officer-connectivity-chip');
  });
});