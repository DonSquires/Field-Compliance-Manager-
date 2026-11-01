import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin } from './fixtures';

for (const postedLabour of [false, true]) {
  test(`source work appears in the main roster calendar${postedLabour ? ' without duplicating posted labour' : ''}`, async ({ page }) => {
    await installSupabaseFixtures(page);
    await page.clock.setFixedTime(new Date('2026-08-27T12:00:00Z'));
    await page.route('**/rest/v1/rpc/get_operating_organization_contexts', (route) => route.fulfill({ json: [{
      organization_id: '41414141-4141-4141-8141-414141414141', organization_name: 'Northern Branch',
      authority_basis: 'branch_authorisation', role_at_branch: 'admin', module_access: ['roster'],
      can_be_rostered: false, is_default: true,
    }] }));
    await page.route('**/rest/v1/roster_assignments**', (route) => route.fulfill({ json: [{
      id: '94949494-9494-4494-8494-949494949494', officer_id: '22222222-2222-4222-8222-222222222222',
      patrol_route_id: '19191919-1919-4919-8919-191919191919', specific_date: '2026-08-26',
      start_time: '10:00:00', end_time: '16:00:00', officer: { display_name: 'Ana Ngata' },
      external_refs: { source: 'rm_patrol_log_roster_evidence', source_event_count: 2, beat_names: ['Sample forestry beat'] },
    }] }));
    if (postedLabour) await page.route('**/rest/v1/roster_work_units**', (route) => route.fulfill({ json: [{
      id: '18181818-1818-4818-8818-181818181818', name: 'North District Patrol', work_unit_type: 'patrol', service_type: 'patrol',
      patrol_route_id: '19191919-1919-4919-8919-191919191919', workshop_work_order_id: null, external_refs: null,
      patrol_route: { primary_staff_id: '22222222-2222-4222-8222-222222222222' },
    }] }));
    if (postedLabour) await page.route('**/rest/v1/roster_slots**', (route) => route.fulfill({ json: [{
      id: '95959595-9595-4595-8595-959595959595', work_unit_id: '18181818-1818-4818-8818-181818181818',
      staff_id: '22222222-2222-4222-8222-222222222222',
      scheduled_start: new Date(2026, 7, 26, 10).toISOString(), scheduled_end: new Date(2026, 7, 26, 12).toISOString(),
      status: 'completed', linked_shift_id: null, notes: null,
      external_refs: { source: 'rm_patrol_log_labour', recorded_hours: 2, pay_code: 'FORESTRY-PATROL', source_records: [{}],
        client_name: 'Sample Forestry Client', route_code: 'NORTH-PATROL', route_basis: 'site' },
    }] }));
    await signInAsAdmin(page, '/admin/roster');
    await expect(page.locator('.roster-history-table-wrap')).toHaveCount(0);
    for (const mode of ['Staff schedule', 'Work unit schedule']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      if (postedLabour) {
        await expect(page.locator('.roster-cell').getByText(/2h recorded/)).toHaveCount(1);
        await expect(page.locator('.roster-cell').getByText(/Patrol log · Sample Forestry Client · 2h recorded/)).toHaveCount(1);
        await expect(page.locator('.roster-cell').getByText('Patrol log · source assignment', { exact: true })).toHaveCount(0);
        if (mode === 'Work unit schedule') await expect(page.locator('.roster-person').filter({ hasText: 'North District Patrol' })).toContainText('Usual officer: Ana Ngata');
      } else {
        const card = page.locator('.roster-cell').getByRole('button').filter({ hasText: 'Patrol log · source assignment' });
        await expect(card).toHaveCount(1);
        await expect(card).toContainText('Ana Ngata');
        await card.click();
        await expect(page.getByLabel('Patrol source assignment').getByText('Sample forestry beat')).toBeVisible();
        await page.getByRole('button', { name: 'Close source assignment' }).click();
      }
    }
  });
}
