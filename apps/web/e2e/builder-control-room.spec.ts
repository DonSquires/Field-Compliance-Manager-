import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const JOB_ID = '91919191-9191-4919-8919-919191919191';
const PROJECT_ID = '92929292-9292-4929-8929-929292929292';
const ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333';

test('Builder renders a partial historical job without crashing on missing labels', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/functions/v1/bob-builder-control-room', async (route) => {
    const body = route.request().postDataJSON() as { action?: string } | null;
    const job = {
      id: JOB_ID, organization_id: ORGANIZATION_ID, project_id: PROJECT_ID,
      title: 'Historical Builder job', status: 'approval_pending', current_step_name: null,
      target_sha: 'a'.repeat(40), frontend_required: true, backend_required: false,
      code_review_status: 'pending', last_error: null,
      created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T01:00:00.000Z',
    };
    const response = body?.action === 'list'
      ? { projects: [{ id: PROJECT_ID, organization_id: ORGANIZATION_ID, gitea_owner: 'Iron-Eagle-Security-Ltd', gitea_repo: 'field-compliance-manager', name: 'FCM' }], jobs: [job] }
      : body?.action === 'get'
        ? { job, steps: [], artifacts: [], workerRuns: [], approvals: [] }
        : { context: null };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });

  await signInAsAdmin(page, '/admin/builder');
  await expect(page.getByRole('heading', { name: 'Builder control room' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Historical Builder job' })).toBeVisible();
  await expect(page.getByText('Review: Not recorded')).toBeVisible();
  await expect(page.getByText('Not recorded for Not recorded')).toBeVisible();
  await expect(page.getByText('This page could not load.')).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});