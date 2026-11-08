import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin } from './fixtures';

const FIELD_ADMIN_ID = '27272727-2727-4727-8727-272727272727';

test('admin activity timeline can select an admin officer who also works in the field', async ({ page }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/user_profiles**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('role')?.includes('admin_officer')) {
      await route.fulfill({ json: [{ id: FIELD_ADMIN_ID, display_name: 'Synthetic Field Admin', email: 'field-admin@example.test', deactivated_at: null }] });
      return;
    }
    await route.fallback();
  });

  let timelineOfficerId: string | null = null;
  await page.route('**/rest/v1/rpc/get_officer_activity_timeline', async (route) => {
    timelineOfficerId = route.request().postDataJSON().p_officer_id;
    await route.fulfill({ json: [] });
  });

  await signInAsAdmin(page, '/admin/field-ops?area=officer-activity');
  const officer = page.getByRole('combobox', { name: 'Officer' });
  await expect(officer.locator('option', { hasText: 'Synthetic Field Admin' })).toHaveCount(1);
  await officer.selectOption(FIELD_ADMIN_ID);
  await page.getByRole('button', { name: 'Build timeline' }).click();
  await expect(page.getByText('No activity found')).toBeVisible();
  expect(timelineOfficerId).toBe(FIELD_ADMIN_ID);
});
