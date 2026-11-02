/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const hub = readFileSync(resolve(process.cwd(), 'src/pages/WebsiteHubPage.tsx'), 'utf8');
const statistics = readFileSync(resolve(process.cwd(), 'src/pages/WebsiteStatisticsPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');

describe('Website hub and statistics', () => {
  it('keeps both workspaces under the CRM module and admin-tier guard', () => {
    expect(shell).toContain("{ id: 'website', label: 'Website', icon: BarChart3 }");
    expect(shell).toContain("website: 'crm', 'website-statistics': 'crm'");
    expect(shell).toContain("'website', 'website-statistics', 'website-enquiries'");
    expect(hub).toContain('isAdminTierRole(profile?.role)');
    expect(statistics).toContain('isAdminTierRole(profile?.role)');
  });

  it('shows enquiry and aggregate statistics cards with explicit load feedback', () => {
    expect(hub).toContain("onNavigate('website-enquiries')");
    expect(hub).toContain("onNavigate('website-statistics')");
    expect(hub).toContain('New enquiry count is unavailable');
    expect(hub).toContain('Website statistics are unavailable');
    expect(hub).toContain('page views, not visitors');
  });

  it('loads aggregate summaries only, with bounded periods and privacy states', () => {
    expect(statistics).toContain("supabase.rpc('get_website_page_view_summary'");
    expect(statistics).toContain('7 days');
    expect(statistics).toContain('30 days');
    expect(statistics).toContain('90 days');
    expect(statistics).toContain('fewer than five page views are withheld');
    expect(statistics).toContain('Loading website statistics');
    expect(statistics).toContain('Website statistics could not be loaded');
    expect(statistics).not.toContain("from('website_page_views_daily')");
  });
});
