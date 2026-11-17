import { expect, test } from '@playwright/test';
import { ADMIN_ID, installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const JOB_ID = '91919191-9191-4919-8919-919191919191';
const PROJECT_ID = '92929292-9292-4929-8929-929292929292';
const ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333';

test('Builder chat dock focuses its visible composer when opened', async ({ page, isMobile }) => {
  const errors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
  await page.route('**/functions/v1/bob-builder-control-room', async route => {
    const { action } = route.request().postDataJSON() as { action: string };
    const response = action === 'list' ? { projects: [], jobs: [] } : { context: null };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  await signInAsAdmin(page, '/admin/builder');
  await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();

  if (isMobile) {
    await page.getByRole('button', { name: 'Bob Builder', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Hide Builder chat' }).click();
    await page.getByRole('button', { name: 'Builder chat' }).click();
  }

  const composer = page.locator('#bchat-input');
  await expect(page.locator('.builder-agent-dock')).toBeVisible();
  await expect(composer).toBeVisible();
  expect(errors).toEqual([]);
  await expect(composer).toBeFocused();
  await expect(composer).toBeInViewport();
});

test('opening a chat with history keeps the composer visible in the stacked layout', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Stacked layout is between mobile and wide desktop.');
  await page.setViewportSize({ width: 1100, height: 800 });
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
  await page.route('**/rest/v1/builder_chat_threads*', route => route.fulfill({ json: [{ id: 'thread-1' }] }));
  await page.route('**/rest/v1/builder_chat_messages*', route => route.fulfill({ json: Array.from({ length: 10 }, (_, index) => ({
    id: `message-${index}`, thread_id: 'thread-1', seq: index, role: 'bob', kind: 'message',
    content: `History message ${index}`, payload: {}, status: 'done', created_at: '2026-10-26T12:00:00Z',
  })) }));
  await page.route('**/functions/v1/bob-builder-control-room', route => route.fulfill({ json: { projects: [], jobs: [], context: null } }));
  await signInAsAdmin(page, '/admin/builder');
  await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Hide Builder chat' }).click();
  await page.getByRole('button', { name: 'Builder chat' }).click();

  const composer = page.getByLabel('Message Bob Builder');
  await expect(page.getByText('History message 9')).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(composer).toBeInViewport({ ratio: 1 });
});

test('loading chat history cannot take focus from the create-job dialog', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The header toggle is a desktop interaction.');
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
  await page.route('**/rest/v1/builder_chat_threads*', route => route.fulfill({ json: [{ id: 'thread-1' }] }));
  let releaseHistory!: () => void;
  const historyReady = new Promise<void>(resolve => { releaseHistory = resolve; });
  await page.route('**/rest/v1/builder_chat_messages*', async route => {
    await historyReady;
    await route.fulfill({ json: [] });
  });
  await page.route('**/functions/v1/bob-builder-control-room', route => route.fulfill({ json: { projects: [], jobs: [], context: null } }));
  await signInAsAdmin(page, '/admin/builder');
  await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Hide Builder chat' }).click();
  await page.getByRole('button', { name: 'Builder chat' }).click();
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Builder job' });
  const title = dialog.getByLabel('Title', { exact: true });
  await title.focus();
  releaseHistory();
  await expect(page.getByLabel('Message Bob Builder')).toBeEnabled();
  await expect(title).toBeFocused();
  await dialog.getByRole('button', { name: 'Close create job dialog' }).click();
  await expect(page.getByRole('button', { name: 'New job', exact: true })).toBeFocused();
});

test('loading chat history cannot take focus from another control', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The header toggle is a desktop interaction.');
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
  await page.route('**/rest/v1/builder_chat_threads*', route => route.fulfill({ json: [{ id: 'thread-1' }] }));
  let releaseHistory!: () => void;
  const historyReady = new Promise<void>(resolve => { releaseHistory = resolve; });
  await page.route('**/rest/v1/builder_chat_messages*', async route => {
    await historyReady;
    await route.fulfill({ json: [] });
  });
  await page.route('**/functions/v1/bob-builder-control-room', route => route.fulfill({ json: { projects: [], jobs: [], context: null } }));
  await signInAsAdmin(page, '/admin/builder');
  await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Hide Builder chat' }).click();
  await page.getByRole('button', { name: 'Builder chat' }).click();
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  await refresh.focus();
  releaseHistory();
  await expect(page.getByLabel('Message Bob Builder')).toBeEnabled();
  await expect(refresh).toBeFocused();
});

test('incomplete acceptance stays a same-job correction gate after reload, never finished-code approval', async ({ page, isMobile }) => {
  const errors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
  const mutations: string[] = [];
  const job = {
    id: JOB_ID, organization_id: ORGANIZATION_ID, project_id: PROJECT_ID, title: 'Partial-success correction',
    status: 'security_review', target_sha: 'a'.repeat(40), frontend_required: true, backend_required: true,
    code_review_mode: 'human', code_review_status: 'pending', autopilot_state: 'blocked',
    created_at: '2026-10-26T12:00:00Z', updated_at: '2026-10-26T12:00:00Z',
  };
  await page.route('**/functions/v1/bob-builder-control-room', async route => {
    const body = route.request().postDataJSON() as { action: string };
    if (!['list', 'get', 'context_snapshot'].includes(body.action)) mutations.push(body.action);
    const response = body.action === 'list'
      ? { projects: [{ id: PROJECT_ID, organization_id: ORGANIZATION_ID, name: 'FCM' }], jobs: [job] }
      : body.action === 'get' ? { job, steps: [{ id: 'test', step_id: 'test_suite', ordinal_position: 5,
        builder_mode: 'qa_security_reviewer', status: 'completed', attempt_count: 1,
        input_context: { implementation_acceptance: { report: { version: 1, passed: false,
          requirements: [{ requirement_id: 'DR-1', status: 'blocked' }],
          blockers: ['DR-1: saved-diary/final-answer-failure workflow is not demonstrated.'] } } } }],
        artifacts: [{ id: 'patch', artifact_type: 'code_implementation', status: 'final', checksum: 'b'.repeat(64) }],
        workerRuns: [], modelRuns: [], events: [], approvals: [{ id: 'review', approval_type: 'implementation_review',
          status: 'pending', triggered_at_status: 'security_review', requested_target_sha: job.target_sha, reviewed_artifact_ids: ['patch'] }]
      } : { context: null };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  await signInAsAdmin(page, '/admin/builder');
  for (let round = 0; round < 2; round++) {
    await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();
    if (isMobile) await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.locator('.builder-list button').filter({ hasText: job.title }).click();
    await expect(page.getByRole('alert', { name: 'Acceptance corrections required' })).toContainText('DR-1');
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    await expect(page.getByText(/Ask Builder Chat for corrections on this same job/)).toBeVisible();
    await expect(page.getByText('Is the finished code acceptable?')).toHaveCount(0);
    await page.getByRole('textbox', { name: /Note for Bob/ }).fill('Keep this same job and correct the missing workflow.');
    await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (round === 0) await page.reload();
  }
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test('owner re-verifies the exact saved patch on the same job only after a second confirmation', async ({ page, isMobile }) => {
  const errors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
  const targetSha = 'c'.repeat(40);
  const stepId = '93939393-9393-4939-8939-939393939393';
  const patchId = '94949494-9494-4949-8949-949494949494';
  const receipt = '95959595-9595-4959-8959-959595959595';
  let retried = false;
  const job = () => ({
    id: JOB_ID, organization_id: ORGANIZATION_ID, project_id: PROJECT_ID, title: 'Saved patch verifier recovery',
    status: retried ? 'implementation_pending' : 'failed', target_sha: targetSha, frontend_required: true,
    backend_required: true, code_review_mode: 'human', code_review_status: 'pending', autopilot_requested_by: ADMIN_ID,
    autopilot_state: retried ? 'driving' : 'blocked', created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T01:02:03.456789+00:00',
  });
  const step = (id: string, step_id: string, builder_mode: string, ordinal_position: number, status: string) =>
    ({ id, step_id, builder_mode, ordinal_position, status, attempt_count: status === 'pending' ? 0 : 1 });
  const rpcBodies: unknown[] = [];
  const actions: string[] = [];
  await page.route('**/rest/v1/rpc/builder_retry_failed_frontend_patch', async route => {
    rpcBodies.push(route.request().postDataJSON());
    retried = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(receipt) });
  });
  await page.route('**/functions/v1/bob-builder-control-room', async route => {
    const body = route.request().postDataJSON() as { action: string; job_id?: string; max_actions?: number };
    if (!['list', 'get', 'context_snapshot'].includes(body.action)) actions.push(`${body.action}:${body.job_id}:${body.max_actions}`);
    const frontend = {
      ...step(stepId, 'frontend_implementation', 'frontend_engineer', 3, retried ? 'pending' : 'failed'),
      retryable: retried, input_context: { patch_artifact_id: patchId, target_sha: targetSha },
      error: retried ? 'Verifier recovery pending: owner-confirmed saved patch verification'
        : 'Verifier recovery paused after two infrastructure or attribution failures; patch preserved; browser attribution unavailable',
    };
    const response = body.action === 'list'
      ? { projects: [{ id: PROJECT_ID, organization_id: ORGANIZATION_ID, name: 'FCM' }], jobs: [job()] }
      : body.action === 'get' ? {
        job: job(),
        steps: [
          step('s1', 'product_analysis', 'product_analyst', 1, 'completed'), step('s2', 'ui_design', 'ux_designer', 2, 'completed'),
          frontend, step('s4', 'backend_implementation', 'backend_engineer', 4, 'pending'),
          step('s5', 'test_suite', 'qa_security_reviewer', 5, 'pending'), step('s6', 'security_review', 'qa_security_reviewer', 6, 'pending'),
          step('s7', 'code_review', 'code_reviewer', 7, 'pending'), step('s8', 'release_prep', 'release_manager', 8, 'pending'),
        ],
        artifacts: [{ id: patchId, step_id: stepId, artifact_type: 'code_implementation', status: 'final', checksum: 'd'.repeat(64) }],
        workerRuns: [{ id: 'run-1', step_id: stepId, profile: 'frontend-verify', status: 'failed', exit_code: 1, target_sha: targetSha, patch_artifact_id: patchId }],
        modelRuns: [], events: [], approvals: [],
      } : body.action === 'run' ? { accepted: true, already_running: false } : { context: null };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });

  await signInAsAdmin(page, '/admin/builder');
  await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();
  if (isMobile) await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.locator('.builder-list button').filter({ hasText: 'Saved patch verifier recovery' }).click();
  const handoff = page.getByRole('region', { name: 'Owner-confirmed saved-patch handoff' });
  await expect(handoff).toContainText('d'.repeat(16));
  await expect(handoff).toContainText('c'.repeat(12));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  await handoff.getByRole('button', { name: 'Review same-job retry', exact: true }).click();
  const confirm = handoff.getByRole('group', { name: 'Confirm saved-patch retry' });
  await expect(confirm).toContainText('No pull request, merge, or deployment is created.');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(rpcBodies).toEqual([]);

  await handoff.getByRole('button', { name: 'Review same-job retry', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await confirm.getByRole('button', { name: 'Confirm handoff and retry verification', exact: true }).click();
  await expect(page.getByText(`Saved-patch handoff recorded (${receipt})`)).toBeVisible();
  await expect(page.getByText(/nothing is approved or published/)).toBeVisible();
  await expect(handoff).toHaveCount(0);

  expect(rpcBodies).toEqual([{
    p_job_id: JOB_ID, p_step_id: stepId, p_patch_artifact_id: patchId,
    p_target_sha: targetSha, p_job_updated_at: '2026-11-02T01:02:03.456789+00:00',
  }]);
  expect(actions).toEqual([`run:${JOB_ID}:8`]);
  expect(errors).toEqual([]);
});

test('a superseded attempt opens its failed successor without implying that either is running', async ({ page, isMobile }) => {
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
  await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();
  if (isMobile) await page.getByRole('button', { name: 'Jobs', exact: true }).click();
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

test('Builder renders a partial historical job without crashing on missing labels', async ({ page, isMobile }) => {
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
  await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();
  if (isMobile) await page.getByRole('button', { name: 'Jobs', exact: true }).click();
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
  await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();
  if (isMobile) await page.getByLabel('Builder workspace panels').getByRole('button', { name: 'Jobs', exact: true }).click();

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