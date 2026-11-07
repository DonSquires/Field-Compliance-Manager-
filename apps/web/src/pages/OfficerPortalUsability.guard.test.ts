import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const debrief = read('src/pages/OfficerDebriefPage.tsx');
const home = read('src/pages/OfficerHomePage.tsx');
const shell = read('src/shells/OfficerShell.tsx');
const usabilityCss = read('src/shells/OfficerUsability.css');
const dispatch = read('src/pages/OfficerDispatchPage.tsx');
const evidence = read('src/components/DispatchJobEvidence.tsx');
const destination = read('src/components/DispatchJobDestination.tsx');
const routeGuidance = read('src/components/OfficerRouteGuidance.tsx');
const pill = read('src/components/OfficerLocationPill.tsx');
const alertBanner = read('src/components/OfficerJobAlertBanner.tsx');
const alertsHook = read('src/hooks/useNewDispatchJobAlerts.ts');
const installApp = read('src/components/OfficerAppInstall.tsx');
const jobAlerts = read('src/lib/officerJobAlerts.ts');
const indexHtml = read('index.html');
const serviceWorker = read('public/officer-sw.js');
const manifest = JSON.parse(read('public/manifest.webmanifest')) as Record<string, unknown> & { icons: Array<{ src: string; sizes: string; purpose?: string }> };
const edge = read('../../supabase/functions/officer-route-guidance/index.ts');

describe('complaint 9: open shifts are resumable regardless of age', () => {
  it('debrief loads accepted/in_progress shifts with no date window and windows only completed shifts', () => {
    const openQuery = debrief.split('\n').find((line) => line.includes(".in('status', ['accepted', 'in_progress'])"));
    expect(openQuery).toBeDefined();
    expect(openQuery).not.toContain("gte('scheduled_start'");
    const completedQuery = debrief.split('\n').find((line) => line.includes(".eq('status', 'completed')"));
    expect(completedQuery).toContain(".gte('scheduled_start', since)");
  });

  it('home offers Resume job, a Debrief action, and end-shift debrief goes to the debrief page', () => {
    expect(home).toContain('Resume job');
    expect(home).toContain("else if (destination === 'debrief') onNavigate('debrief');");
    expect(home).toContain('label="Debrief"');
    expect(home).toContain('onOpenJob');
  });
});

describe('complaints 4-6: simple home, readable sizes, persistent Home', () => {
  it('home leads with the assigned job and tucks secondary content behind More', () => {
    expect(home.indexOf('officer-next-job')).toBeLessThan(home.indexOf('officer-shift-panel'));
    expect(home).toContain('<details className="officer-home-more"');
  });

  it('shell has an always-visible Home button in the action bar', () => {
    expect(shell).toContain('navigateToModule(null)');
    expect(shell).toContain("aria-current={activeModule === null ? 'page' : undefined}");
    expect(shell).toContain("import './OfficerUsability.css';");
  });

  it('new officer surfaces use 44px+ tap targets without restyling the shared shell', () => {
    expect(usabilityCss).not.toMatch(/\.officer-shell \{|\.officer-action-bar|\.officer-location-pill|\.officer-home-more \{/);
    expect(usabilityCss).toMatch(/min-height: (4[4-9]|5\d|6\d)px/);
    expect(usabilityCss).not.toMatch(/font-size: (1[0-3])px/);
  });
});

describe('complaint 2: new job alert', () => {
  it('shell shows the alert banner from the new-job hook', () => {
    expect(shell).toContain('useNewDispatchJobAlerts(profile?.id)');
    expect(shell).toContain('<OfficerJobAlertBanner');
  });

  it('hook listens to assigned jobs with realtime plus polling and alerts only unseen ids', () => {
    expect(alertsHook).toContain("eq('assigned_officer_id'");
    expect(alertsHook).toContain('postgres_changes');
    expect(alertsHook).toContain('setInterval');
    expect(alertsHook).toContain('unseenJobIds');
    expect(alertsHook).toContain('markJobsSeen');
  });

  it('banner is an assertive live alert with an explicit enable-alerts gesture', () => {
    expect(alertBanner).toContain('aria-live="assertive"');
    expect(alertBanner).not.toContain('role="alert"');
    expect(shell).toContain("activeModule === null || activeModule === 'dispatch' ? [] : jobAlerts.jobs");
    expect(alertBanner).toContain('enableJobAlerts');
  });
});

describe('complaint 8: compact location pill', () => {
  it('replaces the full geofence banner in the shell with an expandable pill', () => {
    expect(shell).toContain('<OfficerLocationPill />');
    expect(shell).not.toContain('<PlaceContextBanner />');
    expect(pill).toContain('Current location');
    expect(pill).toContain('No current location');
    expect(pill).toContain('aria-expanded');
    expect(pill).toContain('<PlaceContextBanner />');
  });
});

describe('complaints 1, 7, 9: job map, evidence and maps in a new tab', () => {
  it('dispatch job shows a destination with an external maps link or a no-location state', () => {
    expect(dispatch).toContain('resolveDispatchDestination');
    expect(dispatch).toContain('<DispatchJobDestination');
    expect(destination).toContain('target="_blank"');
    expect(destination).toContain('rel="noopener noreferrer"');
    expect(destination).toContain('No map location for this job');
    expect(dispatch).toContain('zone_geo:zone_id(center_point, boundary)');
  });

  it('route guidance opens maps externally and does not offer routing without a location', () => {
    expect(routeGuidance).toContain('target="_blank"');
    expect(routeGuidance).toContain('is-no-location');
  });

  it('job detail offers camera capture and file attach through the governed evidence RPC', () => {
    expect(dispatch).toContain('<DispatchJobEvidence jobId={job.id} />');
    expect(evidence).toContain('accept="image/*"');
    expect(evidence).toContain('capture="environment"');
    expect(evidence).toContain('multiple');
    expect(evidence).toContain("rpc('register_evidence_media_item'");
    expect(evidence).toContain('dispatch_job_id');
    expect(evidence).toContain('aria-live');
  });

  it('route guidance edge function authorises directly-assigned officers and falls back to zone geometry', () => {
    expect(edge).toContain('job.assigned_officer_id === user.id');
    expect(edge).toContain("eq('assigned_officer_id'");
    expect(edge).toContain('geometryCentre(zone?.boundary)');
  });
});

describe('complaint 3: installable app (main officer PWA, no second worker)', () => {
  it('keeps the single officer manifest and worker registration', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/officer');
    expect(indexHtml).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(installApp).toContain("register('/officer-sw.js'");
  });

  it('worker stays network-only and opens job notifications inside the officer portal', () => {
    expect(serviceWorker).toContain("request.mode !== 'navigate'");
    expect(serviceWorker).not.toMatch(/supabase|\/rest\/v1|\/functions\/v1|\bcaches\b/);
    expect(serviceWorker).toContain("addEventListener('notificationclick'");
    expect(jobAlerts).toContain("'/assets/pwa/ie-192.png'");
  });
});
