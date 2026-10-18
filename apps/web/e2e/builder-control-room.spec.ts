import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const JOB_ID = '91919191-9191-4919-8919-919191919191';
const PROJECT_ID = '92929292-9292-4929-8929-929292929292';
const ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333';

test('a superseded attempt opens its failed successor without implying that either is running', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  const successorId = '0c388688-c566-42b0-b700-d8267f602ddb';
  const common = {
    organization_id: ORGANIZATION_ID, project_id: PROJECT_ID, target_sha: 'a'.repeat(40),
    current_step_name: 'ui_design', frontend_required: true, backend_required: true,
    code_review_mode: 'independent_ai', code_review_status: 'pending', autopilot_requested_by: 'owner',
    created_at: '2026-10-17T00:00:00Z', updated_at: '2026-10-17T01:00:00Z',
  };
  const old = { ...common, id: JOB_ID, title: 'Historical map attempt', status: 'implementation_pending', last_error: null,
    autopilot_state: 'done', autopilot_report: { resumed_as_job_id: successorId } };
  const next = { ...common, id: successorId, title: 'Map continuation', status: 'failed',
    autopilot_state: 'blocked', last_error: 'two attempts ran out of turns without an edit' };
  const mutations: string[] = [];
  await page.route('**/functions/v1/bob-builder-control-room', async route => {
    const body = route.request().postDataJSON() as { action: string; job_id?: string };
    if (!['list', 'get', 'context_snapshot'].includes(body.action)) mutations.push(body.action);
    const job = body.job_id === successorId ? next : old;
    const response = body.action === 'list'
      ? { projects: [{ id: PROJECT_ID, organization_id: ORGANIZATION_ID, name: 'FCM' }], jobs: [old, next] }
      : body.action === 'get' ? {
        job,
        steps: [
          { id: 'a', step_id: 'ui_design', builder_mode: 'ux_designer', ordinal_position: 2, status: 'completed', attempt_count: 1 },
          { id: 'b', step_id: 'frontend_implementation', builder_mode: 'frontend_engineer', ordinal_position: 3, status: 'failed', attempt_count: 6, error: job.last_error || 'source checkout does not match the target SHA' },
        ],
        artifacts: [], workerRuns: [], modelRuns: [], events: [], approvals: [],
      } : { context: null };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  await signInAsAdmin(page, '/admin/builder');
  await page.locator('.builder-list button').filter({ hasText: 'Historical map attempt' }).click();
  const activity = page.getByLabel('Bob live activity', { exact: true });
  await expect(activity).toContainText('Continued in a newer job');
  await expect(page.getByRole('button', { name: 'Run next step', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open newer job', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Map continuation', exact: true })).toBeVisible();
  await expect(activity).toContainText('Stopped: job failed');
  await expect(activity).toContainText('two attempts ran out of turns without an edit');
  await expect(page.getByLabel('Current build truth')).toContainText('frontend implementation');
  await expect(activity).not.toContainText('Bob will resume');
  expect(mutations).toEqual([]);
  expect(browserErrors).toEqual([]);
});

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
  await page.locator('.builder-list button').filter({ hasText: 'Historical Builder job' }).click();
  await expect(page.getByRole('heading', { name: 'Builder control room' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Historical Builder job' })).toBeVisible();
  await expect(page.getByText('Review: Not recorded')).toBeVisible();
  await expect(page.getByText('Not recorded for Not recorded')).toBeVisible();
  await expect(page.getByText('This page could not load.')).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('Builder control room supports issue tabs, search filtering, and prompt templates', async ({ page, isMobile }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });

  const jobs = [
    {
      id: 'job-1', organization_id: ORGANIZATION_ID, project_id: PROJECT_ID,
      title: 'Repair 1 failing main guard test', status: 'deployed', current_step_name: 'release_prep',
      target_sha: 'a'.repeat(40), frontend_required: true, backend_required: false,
      code_review_status: 'passed', last_error: null,
      created_at: '2026-10-12T00:00:00.000Z', updated_at: '2026-10-12T01:00:00.000Z',
    },
    {
      id: 'job-2', organization_id: ORGANIZATION_ID, project_id: PROJECT_ID,
      title: 'Fix issue: Navigation overflow', status: 'failed', current_step_name: 'test_suite',
      target_sha: 'b'.repeat(40), frontend_required: true, backend_required: true,
      code_review_status: 'pending', last_error: 'Worker exited 1',
      created_at: '2026-10-11T00:00:00.000Z', updated_at: '2026-10-11T01:00:00.000Z',
    },
    {
      id: 'job-3', organization_id: ORGANIZATION_ID, project_id: PROJECT_ID,
      title: 'Build feature: Realtime alerts', status: 'implementation_pending', current_step_name: 'backend_implementation',
      target_sha: 'c'.repeat(40), frontend_required: false, backend_required: true,
      code_review_status: 'pending', last_error: null,
      created_at: '2026-10-10T00:00:00.000Z', updated_at: '2026-10-10T01:00:00.000Z',
    },
  ];

  await page.route('**/functions/v1/bob-builder-control-room', async (route) => {
    const body = route.request().postDataJSON() as { action?: string; title?: string } | null;
    if (body?.action === 'list') {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          projects: [{ id: PROJECT_ID, organization_id: ORGANIZATION_ID, gitea_owner: 'DonSquires', gitea_repo: 'Field-Compliance-Manager-', name: 'FCM' }],
          jobs,
        }),
      });
      return;
    }
    if (body?.action === 'get') {
      const selected = jobs.find(j => j.id === (body as { job_id?: string }).job_id) || jobs[0];
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          job: selected,
          steps: [
            { id: 'step-1', step_id: 'product_analysis', ordinal_position: 1, builder_mode: 'product_analyst', status: 'completed', attempt_count: 1 },
            { id: 'step-2', step_id: 'ui_design', ordinal_position: 2, builder_mode: 'ux_designer', status: 'completed', attempt_count: 1 },
            { id: 'step-3', step_id: 'frontend_implementation', ordinal_position: 3, builder_mode: 'frontend_engineer', status: selected.status === 'deployed' ? 'completed' : 'running', attempt_count: 1 },
          ],
          artifacts: [], workerRuns: [], approvals: [],
        }),
      });
      return;
    }
    if (body?.action === 'create') {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          job: {
            id: 'job-new', organization_id: ORGANIZATION_ID, project_id: PROJECT_ID,
            title: body.title || 'New prompt job', status: 'intake', current_step_name: null,
            target_sha: 'd'.repeat(40), frontend_required: true, backend_required: false,
            code_review_status: 'pending', last_error: null,
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          },
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ context: null }) });
  });

  await signInAsAdmin(page, '/admin/builder');

  // Verify tabs
  await expect(page.getByRole('button', { name: /All 3/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Issues 0/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Completed 1/ })).toBeVisible();

  // Test pipeline bar
  await page.locator('.builder-list button').filter({ hasText: 'Repair 1 failing main guard test' }).click();
  await expect(page.getByLabel('Autonomous agent pipeline')).toBeVisible();
  await expect(page.getByText('1. Analyst')).toBeVisible();
  if (isMobile) await page.getByLabel('Builder workspace panels').getByRole('button', { name: 'Jobs', exact: true }).click();

  // Filter by search text
  const searchInput = page.getByRole('textbox', { name: 'Filter jobs' });
  await searchInput.fill('Realtime');
  const queueList = page.locator('.builder-list');
  await expect(queueList.getByText('Build feature: Realtime alerts')).toBeVisible();
  await expect(queueList.getByText('Repair 1 failing main guard test')).toHaveCount(0);

  // Clear search
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(queueList.getByText('Repair 1 failing main guard test')).toBeVisible();

  // Scope filter: backend only
  await page.getByRole('combobox', { name: 'Filter by implementation scope' }).selectOption('backend');
  await expect(queueList.getByText('Build feature: Realtime alerts')).toBeVisible();
  await expect(queueList.getByText('Repair 1 failing main guard test')).toHaveCount(0);

  // Reset scope filter
  await page.getByRole('combobox', { name: 'Filter by implementation scope' }).selectOption('all');

  // Open New Job Modal and test Natural Language Prompt Templates
  await page.getByRole('button', { name: 'New job' }).click();
  await expect(page.getByRole('heading', { name: 'Create Builder job' })).toBeVisible();
  await expect(page.getByText('Natural Language Coding:')).toBeVisible();

  // Click a prompt starter
  await page.getByRole('button', { name: '🚀 New Feature' }).click();
  const titleField = page.getByRole('textbox', { name: 'Title' });
  await expect(titleField).toHaveValue('Build feature: [Feature name]');

  // Close modal
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create Builder job' })).toHaveCount(0);

  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});