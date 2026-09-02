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
    expect(source).toContain("orgManDownEnabled: isModuleEnabled('welfare', { safetyRelevant: true })");
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

  it('keeps Welfare as persistent safety infrastructure rather than a module destination', () => {
    expect(source).toContain("Array.from(enabledModules).filter((module) => module !== 'welfare')");
    expect(source).not.toContain("welfare: { label:");
    expect(source).not.toContain("case 'welfare':");
  });

  it('routes the module selector to its own URL', () => {
    expect(source).not.toContain("module === 'modules' || module === null");
    expect(source).toContain('navigate(`/officer/${module}`');
  });

  it('routes post-debrief actions through the owning officer shell', () => {
    expect(source).toContain("<OfficerDebriefPage onNavigate={(destination) => navigateToModule(destination === 'home' ? null : destination)} />");
  });

  it('shows the unbuilt physical Access Control module honestly', () => {
    expect(source).toContain("access_control: { label: 'Physical Access Control'");
    expect(source).toContain("case 'access_control':");
    expect(source).toContain('<ComingSoonPage title="Physical Access Control" />');
  });

  it('does not present generic field reporting as an EMS workflow', () => {
    expect(source).toContain("ems: { label: 'Electronic Monitoring Equipment'");
    expect(source).toMatch(/case 'ems':\s*return <ComingSoonPage title="Electronic Monitoring Equipment" \/>/);
    expect(source).not.toMatch(/case 'ems':\s*return <OfficerFieldReportPage \/>/);
  });

  it('does not present the disconnected PTT prototype as a working radio', () => {
    expect(source).toContain("ptt_radio: { label: 'PTT Radio'");
    expect(source).toMatch(/case 'ptt_radio':\s*return <ComingSoonPage title="PTT Radio" \/>/);
    expect(source).not.toContain('PttBar');
  });
});