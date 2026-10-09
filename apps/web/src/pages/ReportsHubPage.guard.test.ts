import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/ReportsHubPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
const reviewPanel = readFileSync(resolve(process.cwd(), 'src/components/ReportPackReviewPanel.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260926010000_govern_report_pack_review_and_delivery.sql'), 'utf8');

describe('governed monthly report pack generation', () => {
  it('fails closed when organisation context is unavailable', () => {
    expect(page).toContain("if (!profile?.organizationId) {");
    expect(page).toContain("setError('Organisation access could not be confirmed. Reports are unavailable.');");
    expect(page).toContain('setLoading(false);');
  });

  it('generates through the governed RPC and shows the resulting pack queue', () => {
    expect(page).toContain("rpc('generate_due_report_packs'");
    expect(page).toContain("from('monthly_report_packs')");
    expect(page).toContain('report packs generated');
    expect(page).toContain('Generate report drafts');
    expect(migration).toContain("'draft'");
  });

  it('includes the complete selected end date for timestamped evidence', () => {
    expect(page).toContain('function exclusiveEndIso(date: string): string');
    expect(page).toContain(".lt('created_at', timestampEndExclusive)");
    expect(page).toContain(".lt('observed_at', timestampEndExclusive)");
    expect(page).not.toContain(".lte('created_at', dateRange.end)");
    expect(page).not.toContain(".lte('observed_at', dateRange.end)");
  });

  it('reviews and publishes through the governed RPC before delivery', () => {
    expect(reviewPanel).toContain("rpc('review_monthly_report_pack'");
    expect(reviewPanel).toContain("p_action: action");
    expect(reviewPanel).toContain('Publish reviewed report');
    expect(page).toContain("supabase.functions.invoke('send-report-pack'");
    expect(page).toContain('pack_id: pack.id');
    expect(page).toContain('Send reviewed report');
    expect(page).toContain('Available in client portal');
    expect(page).toContain("storage.from('bob-uploads').download(pack.pdf_path)");
    expect(page).toContain('anchor.download = reportPdfFilename(pack)');
    expect(page).toContain('hasLatestReportPdf(pack)');
    expect(page).not.toMatch(/from\('monthly_report_packs'\)[\s\S]{0,240}\.update\(/);
  });

  it('puts the report queue before secondary analysis and keeps group roll-up available as a disclosure', () => {
    expect(page.indexOf('className="reports-section report-packs-section"')).toBeLessThan(page.indexOf('<ActivityRecordBrowser'));
    expect(page).toContain('<details className="reports-section reports-oversight">');
    expect(page).toContain('Group Reporting Overview');
  });

  it('triggers 24-hour operational rollups through the daily rollup edge function', () => {
    expect(page).toContain("supabase.functions.invoke('generate-daily-operational-rollup')");
    expect(page).toContain('Generate daily rollup');
    expect(page).toContain('Daily operational rollup draft generated');
  });

  it('does not mutate report packs directly from the browser', () => {
    expect(page).not.toMatch(/from\('monthly_report_packs'\)[\s\S]{0,240}\.(insert|update|upsert)\(/);
  });

  it('keeps Freedom Camping summaries behind the organisation module entitlement', () => {
    expect(page).toContain("useEnabledModules(profile?.organizationId)");
    expect(page).toContain("isModuleEnabled('freedom_camping')");
    expect(page).toContain('!freedomCampingEnabled\n          ? Promise.resolve({ data: [], error: null })');
    expect(page).toContain('{freedomCampingEnabled && <div className="kpi-grid">');
    expect(page).toContain('{freedomCampingEnabled && <section className="reports-section">\n        <h2>Recent Breach Alerts');
    expect(page).toContain('{freedomCampingEnabled && <section className="reports-section">\n        <h2>Vehicle Observations');
  });

  it('keeps drafts provider-private and exposes only published client reports', () => {
    expect(migration).toContain("monthly_report_packs.status in ('generated', 'sent')");
    expect(migration).toContain('agreement.client_portal_reports_enabled');
    expect(migration).toContain('public.is_admin_for_org(organization_id)');
    expect(migration).toContain('revoke insert, update, delete on table public.monthly_report_packs from anon, authenticated');
  });

  it('shows parent oversight as a branch-preserving reporting read model', () => {
    expect(page).toContain("rpc('get_consolidated_reporting_overview'");
    expect(page).toContain('Group Reporting Overview');
    expect(page).toContain('row.source_organization_name');
    expect(page).toContain('Branch-owned operational activity, consolidated for parent oversight.');
  });

  it('hands the providers agreement places to the searchable record browser instead of a fixed 50-row table', () => {
    const browser = readFileSync(resolve(process.cwd(), 'src/components/ActivityRecordBrowser.tsx'), 'utf8').replace(/\r\n/g, '\n');
    expect(page).toContain(".select('zone_id,site_id')");
    expect(page).toContain('<ActivityRecordBrowser zoneIds={reportScope.zoneIds} siteIds={reportScope.siteIds}');
    expect(page).not.toContain('Operational Activity (');
    expect(browser).toContain("from('location_events')");
    expect(browser).toContain("from('observations')");
    expect(browser).toContain('zone_id.in.(');
    expect(browser).toContain('client_site_id.in.(');
    expect(browser).toContain('.range(rangeFrom, rangeTo)');
    expect(browser).toContain('ilike');
    // Narrative columns are read only through the signed-in session, so row-level security still decides who sees them.
    expect(browser).toContain('officer_notes');
    expect(browser).not.toContain('service_role');
  });

  it('never replaces the whole Reports page with a spinner, so filters and navigation stay usable', () => {
    expect(page).not.toMatch(/if \(loading\) \{\s*return/);
    expect(page).toContain('Refreshing report totals');
  });


  it('does not fall back to organization-wide Freedom Camping records for an agreement with no patrol zones', () => {
    expect(page).toMatch(/:\s*selectedAgreement\s*\? Promise\.resolve\(\{ data: \[\], error: null \}\)\s*:\s*supabase\s*\.from\('breach_alerts'\)/);
    expect(page).toMatch(/:\s*selectedAgreement\s*\? Promise\.resolve\(\{ data: \[\], error: null \}\)\s*:\s*supabase\s*\.from\('observations'\)/);
  });

  it('limits generation to the active provider administrator and records an audit receipt', () => {
    expect(migration).toContain('agreement.provider_organization_id = any(public.get_descendant_organizations(v_provider))');
    expect(migration).toContain('public.is_admin_for_org(v_provider)');
    expect(migration).toContain("'monthly_report_packs_generated'");
    expect(migration).toContain('from public, anon, authenticated, service_role');
    expect(migration).toContain('to authenticated, service_role');
  });
});