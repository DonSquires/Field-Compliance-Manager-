import { expect, test, type Page } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const ORG_ID = '33333333-3333-4333-8333-333333333333';

type Enquiry = {
  id: string; reference: string; received_at: string; name: string; email: string | null; phone: string | null;
  organisation: string | null; location: string | null; services: string[]; message: string; preferred_contact: string;
  source_page: string | null; status: string; status_note: string | null; handled_at: string | null; version: number;
  provider_organization_id: string;
};

function seedEnquiries(): Enquiry[] {
  return [
    {
      id: '90909090-9090-4090-8090-909090909001', reference: 'ENQ-9A1B2C', received_at: '2026-08-29T08:15:00.000Z',
      name: 'Aroha Ngata', email: 'aroha@example.co.nz', phone: '021 555 0101', organisation: 'Harbour Storage Ltd',
      location: 'Onehunga yard', services: ['static-guarding', 'cctv-surveillance'],
      message: 'We need overnight guarding for our storage yard from next month, including weekends and public holidays. '.repeat(3).trim(),
      preferred_contact: 'phone', source_page: '/contact', status: 'new', status_note: null, handled_at: null, version: 1,
      provider_organization_id: ORG_ID,
    },
    {
      id: '90909090-9090-4090-8090-909090909002', reference: 'ENQ-4D5E6F', received_at: '2026-08-28T21:40:00.000Z',
      name: 'Sam Patel', email: 'sam@example.com', phone: null, organisation: null, location: 'Rotorua forestry block',
      services: ['forestry-rural'], message: 'Can you patrol a forestry block during harvest?', preferred_contact: 'email',
      source_page: '/services/forestry', status: 'new', status_note: null, handled_at: null, version: 1,
      provider_organization_id: ORG_ID,
    },
  ];
}

async function installEnquiryRoutes(page: Page, enquiries: Enquiry[], options: { staleOnReview?: boolean } = {}) {
  const reviews: Array<Record<string, unknown>> = [];
  await page.route('**/rest/v1/website_enquiries**', async (route) => {
    const url = new URL(route.request().url());
    const statusFilter = url.searchParams.get('status');
    const status = statusFilter?.startsWith('eq.') ? statusFilter.slice(3) : null;
    const rows = enquiries
      .filter((row) => !status || row.status === status)
      .sort((a, b) => b.received_at.localeCompare(a.received_at));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(rows) });
  });
  await page.route('**/rest/v1/rpc/review_website_enquiry**', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    reviews.push(payload);
    const row = enquiries.find((enquiry) => enquiry.id === payload.p_enquiry_id);
    if (!row || options.staleOnReview || row.version !== payload.p_expected_version) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'PT409', message: 'This enquiry was changed by someone else. Reload and try again.', details: null, hint: null }) });
      return;
    }
    row.status = String(payload.p_status);
    row.status_note = (payload.p_note as string | null) ?? null;
    row.handled_at = '2026-08-29T12:00:00.000Z';
    row.version += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: row.id, reference: row.reference, status: row.status, status_note: row.status_note, version: row.version, handled_by: '11111111-1111-4111-8111-111111111111', handled_at: row.handled_at }) });
  });
  return reviews;
}

test.beforeEach(async ({ page }) => { await installSupabaseFixtures(page); });

test('R&M admin reviews website enquiries and marks one contacted', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  const enquiries = seedEnquiries();
  const reviews = await installEnquiryRoutes(page, enquiries);
  await signInAsAdmin(page, '/admin/website-enquiries');

  await expect(page.getByRole('heading', { name: 'Website enquiries', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const list = page.getByRole('list', { name: 'Website enquiries' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first()).toContainText('ENQ-9A1B2C');

  const first = list.getByRole('listitem').filter({ hasText: 'ENQ-9A1B2C' });
  await expect(first).toContainText('Received');
  await expect(first).toContainText(/29 Aug 2026/);
  await expect(first).toContainText('Aroha Ngata, Harbour Storage Ltd');
  await expect(first).toContainText('Static guarding, CCTV surveillance');
  await expect(first).toContainText('Prefers a phone call');
  await expect(first.getByRole('link', { name: 'aroha@example.co.nz' })).toHaveAttribute('href', 'mailto:aroha@example.co.nz');
  const expand = first.getByRole('button', { name: 'Show full message' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  await expect(first.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');

  const search = page.getByRole('searchbox', { name: 'Search enquiries' });
  await search.fill('patel');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByRole('listitem').first()).toContainText('ENQ-4D5E6F');
  await search.fill('nobody-matches');
  await expect(page.getByText('No enquiries match that search.')).toBeVisible();
  await search.fill('');

  await first.getByRole('button', { name: 'Close', exact: true }).click();
  await first.getByRole('button', { name: 'Save: Close' }).click();
  await expect(first.getByLabel(/Note for "Close" \(required\)/)).toBeFocused();
  expect(reviews).toHaveLength(0);
  await first.getByRole('button', { name: 'Cancel' }).click();

  await first.getByRole('button', { name: 'Mark contacted' }).click();
  await first.getByLabel(/Note for "Mark contacted" \(optional\)/).fill('Phoned, site visit booked');
  await first.getByRole('button', { name: 'Save: Mark contacted' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'ENQ-9A1B2C is now contacted.' })).toBeVisible();
  expect(reviews).toEqual([{ p_enquiry_id: '90909090-9090-4090-8090-909090909001', p_status: 'contacted', p_note: 'Phoned, site visit booked', p_expected_version: 1 }]);
  await expect(list.getByRole('listitem')).toHaveCount(1);

  await page.getByRole('button', { name: 'Contacted', exact: true }).click();
  const contacted = list.getByRole('listitem').filter({ hasText: 'ENQ-9A1B2C' });
  await expect(contacted).toContainText('Contacted');
  await expect(contacted).toContainText('Note: Phoned, site visit booked');
  await expect(contacted.getByRole('button', { name: 'Mark contacted' })).toHaveCount(0);
  await expect(contacted.getByRole('button', { name: 'Converted' })).toBeVisible();
  expect(errors.filter((error) => !error.includes('409')), errors.join('\n')).toEqual([]);
});

test('a stale enquiry version tells the admin to reload instead of overwriting', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  const enquiries = seedEnquiries();
  await installEnquiryRoutes(page, enquiries, { staleOnReview: true });
  await signInAsAdmin(page, '/admin/website-enquiries');

  const row = page.getByRole('list', { name: 'Website enquiries' }).getByRole('listitem').filter({ hasText: 'ENQ-4D5E6F' });
  await row.getByRole('button', { name: 'Converted' }).click();
  await expect(row.getByText('This does not create a client. After saving, set up the client in CRM.')).toBeVisible();
  await row.getByLabel(/Note for "Converted" \(required\)/).fill('Signed a guarding agreement');
  await row.getByRole('button', { name: 'Save: Converted' }).click();
  await expect(row.getByRole('alert')).toContainText('This enquiry was changed by someone else. Reload the list and try again.');
  await row.getByRole('button', { name: 'Reload' }).click();
  await expect(row.getByRole('alert')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Converted' })).toBeVisible();
  expect(errors.filter((error) => !error.includes('409')), errors.join('\n')).toEqual([]);
});
