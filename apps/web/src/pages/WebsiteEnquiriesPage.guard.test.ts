/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/WebsiteEnquiriesPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const crm = readFileSync(resolve(process.cwd(), 'src/pages/CRMPage.tsx'), 'utf8');

describe('Website enquiries page', () => {
  it('reads website_enquiries under RLS and changes status only through the governed RPC', () => {
    expect(page).toContain(".from('website_enquiries')");
    expect(page).toContain(".order('received_at', { ascending: false })");
    expect(page).toContain("supabase.rpc('review_website_enquiry', {");
    expect(page).toContain('p_expected_version: enquiry.version');
    expect(page).not.toMatch(/from\('website_enquiries'\)[\s\S]{0,200}\.(insert|update|upsert|delete)\(/);
  });

  it('requires a note for converted, close, spam and reopen, and explains stale versions', () => {
    expect(page).toContain("{ status: 'converted', label: 'Converted', noteRequired: true }");
    expect(page).toContain("{ status: 'closed', label: 'Close', noteRequired: true }");
    expect(page).toContain("{ status: 'spam', label: 'Spam', noteRequired: true }");
    expect(page).toContain("{ status: 'contacted', label: 'Mark contacted', noteRequired: false }");
    expect(page).toContain("error.code === 'PT409'");
    expect(page).toContain('changed by someone else');
  });

  it('never creates organisations and points converted enquiries at client setup', () => {
    expect(page).toContain("onNavigate('client-setup')");
    expect(page).not.toContain("from('organizations')");
    expect(page).not.toContain('create_crm');
  });

  it('shows times in New Zealand time with loading, empty, error and permission states', () => {
    expect(page).toContain("timeZone: 'Pacific/Auckland'");
    expect(page).toContain('Loading website enquiries');
    expect(page).toContain('No website enquiries yet');
    expect(page).toContain('Website enquiries could not be loaded.');
    expect(page).toContain('Only R&amp;M administrators can see website enquiries');
  });

  it('lives inside the CRM area instead of a new top-level destination', () => {
    expect(shell).toContain("{ id: 'website-enquiries', label: 'Website enquiries', icon: Inbox }");
    expect(shell).toContain("'website-enquiries': 'crm'");
    expect(shell).toContain("'sites', 'website', 'website-statistics', 'website-enquiries',");
    expect(crm).toContain("{ page: 'website-enquiries', label: 'Website enquiries' }");
  });
});
