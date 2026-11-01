import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const THREAD = '22222222-2222-4222-8222-222222222222';

test('owner reviews a synthetic evidence summary/document and approves a fixed-model cloud PM packet', async ({ page, isMobile }) => {
  const errors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/builder_chat_threads*', route => route.fulfill({ json: [{ id: THREAD }] }));
  await page.route('**/rest/v1/builder_chat_messages*', route => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
  const submissions: Record<string, unknown>[] = [];
  await page.route('**/rest/v1/rpc/builder_chat_send_pm', async route => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({ json: '44444444-4444-4444-8444-444444444444' });
  });

  const uploads: string[] = [];
  await page.route('**/storage/v1/object/bob-uploads/**', async route => {
    uploads.push(route.request().url());
    await route.fulfill({ json: { Key: 'synthetic', Id: 'synthetic' } });
  });
  const text = 'Synthetic public fixture: Docker Compose configures services.';
  let memoryReads = 0;
  await page.route('**/functions/v1/bob-self-memory-read', route => {
    memoryReads++;
    return route.fulfill({ json: { ok: true, memories: [{ id: 'synthetic-memory', content: 'Synthetic lesson: Atlas guides investigation, not factual conclusions.', memory_type: 'reflection', created_at: '2026-10-25' }] } });
  });
  const { createHash } = await import('node:crypto');
  await page.route('**/functions/v1/bob-extract-document', route => route.fulfill({
    json: { checksum: createHash('sha256').update(text).digest('hex'), text, has_text: true },
  }));
  await signInAsAdmin(page, '/admin/builder');
  await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();
  if (isMobile) await page.getByRole('button', { name: 'Bob Builder', exact: true }).click();
  const chat = page.getByRole('region', { name: 'Bob Builder chat', exact: true });
  await expect(chat.getByLabel('Purpose and model')).toHaveValue('pm');
  const input = chat.getByLabel('Message Bob Builder');
  await input.fill('Explain this synthetic public document.');
  await chat.getByLabel('Research attachments').setInputFiles({ name: 'public-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
  await chat.getByLabel(/Human-reviewed non-sensitive evidence summary/).fill('Synthetic report: the owner wants a bounded Compose explanation, not a code change.');
  const send = chat.getByRole('button', { name: 'Send approved PM message' });
  expect(await chat.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(send).toBeDisabled();
  const approval = chat.getByLabel(/I reviewed this question/);
  await approval.check();
  expect(memoryReads).toBe(0);
  await chat.getByText("Recall Bob's existing memory (private preview)").click();
  await chat.getByRole('button', { name: 'Recall private memories', exact: true }).click();
  await expect(chat.getByText('Synthetic lesson: Atlas guides investigation, not factual conclusions.')).toBeVisible();
  expect(submissions).toHaveLength(0);
  await chat.getByRole('button', { name: 'Use excerpt in reviewed summary' }).click();
  await expect(approval).not.toBeChecked();
  await approval.check();
  await input.fill('Explain the Docker Compose wording in this synthetic public document.');
  await expect(approval).not.toBeChecked();
  await approval.check();
  await send.click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({
    p_thread_id: THREAD, p_content: 'Explain the Docker Compose wording in this synthetic public document.',
    p_allow_cloud: true, p_web_search: false, p_purpose: 'pm',
    p_evidence_summary: expect.stringContaining('unverified reflection excerpt'),
    p_files: [expect.objectContaining({ file_name: 'public-fixture.txt', extracted_text: text })],
  });
  expect(submissions[0]).not.toHaveProperty('p_context');
  expect(memoryReads).toBe(1);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toContain(`/builder-chat/${THREAD}/`);
  await expect(input).toHaveValue('');
  await expect(approval).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('PM investigation card requires owner confirmation and retains a persisted job receipt after reload', async ({ page, isMobile }) => {
    const errors = monitorBrowserErrors(page);
    await installSupabaseFixtures(page, { adminRole: 'grand_master' });
    const jobId = '55555555-5555-4555-8555-555555555555';
    const proposalId = '66666666-6666-4666-8666-666666666666';
    const proposal = {
      title: 'Investigate: Partial-success feedback',
      task_description: 'INVESTIGATION HANDOFF - not a source-verified repair plan. Inspect the reported partial-success feedback and safe retries using synthetic fixtures.',
      frontend_required: true, backend_required: true, handoff_kind: 'investigation', source_message_id: 'owner-report',
    };
    let accepted = false;
    const effects: string[] = [];
    await page.route('**/rest/v1/builder_chat_threads*', route => route.fulfill({ json: [{ id: THREAD }] }));
    await page.route('**/rest/v1/builder_chat_messages*', route => route.fulfill({ json: [{
      id: proposalId, seq: 1, thread_id: THREAD, role: 'bob', kind: 'proposal', status: 'done',
      content: proposal.title, created_at: '2026-10-25T00:00:00Z',
      payload: { proposal, ...(accepted ? { job_id: jobId } : {}) },
    }] }));
    await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
    await page.route('**/rest/v1/rpc/builder_chat_reserve_proposal', route => {
      effects.push('reserve');
      expect(route.request().postDataJSON().p_message_id).toBe(proposalId);
      return route.fulfill({ json: true });
    });
    await page.route('**/rest/v1/rpc/builder_chat_record_job', route => {
      effects.push('record');
      expect(route.request().postDataJSON()).toEqual({ p_message_id: proposalId, p_job_id: jobId });
      accepted = true;
      return route.fulfill({ json: null });
    });
    await page.route('**/functions/v1/bob-builder-control-room', route => {
      const body = route.request().postDataJSON();
      if (body.action === 'create') {
        effects.push('create');
        expect(body).toMatchObject({
          task_description: proposal.task_description, frontend_required: true, backend_required: true,
          requested_action: 'prepare_change', target_environment: 'development', target_sha: 'main',
        });
        return route.fulfill({ json: { job: { id: jobId } } });
      }
      if (body.action === 'list') return route.fulfill({ json: { projects: [{
        id: 'test-project', organization_id: 'test-org', name: 'FCM fixture',
      }], jobs: [] } });
      return route.fulfill({ json: { job: null, steps: [], approvals: [], artifacts: [], events: [] } });
    });
    const open = async () => {
      await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();
      if (isMobile) await page.getByRole('button', { name: 'Bob Builder', exact: true }).click();
      return page.getByRole('region', { name: 'Bob Builder chat', exact: true });
    };
    await signInAsAdmin(page, '/admin/builder');
    const chat = await open();
    await expect(chat.getByText(/Investigation handoff · Bob Builder/)).toBeVisible();
    await expect(chat.getByText(/Reported issue, not a verified repair plan/)).toBeVisible();
    expect(effects).toEqual([]);
    expect(await chat.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await chat.getByRole('button', { name: 'Create job', exact: true }).click();
    await expect.poll(() => effects).toEqual(['reserve', 'create', 'record']);
    await page.reload();
    const restored = await open();
    await expect(restored.getByText(`Receipt: ${jobId}`, { exact: true })).toBeVisible();
    await expect(restored.getByRole('button', { name: 'Create job', exact: true })).toHaveCount(0);
    expect(await restored.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(effects).toEqual(['reserve', 'create', 'record']);
    expect(errors).toEqual([]);
});

for (const kind of ['specification', 'implementation', 'recovery']) test(`existing-job ${kind} need confirmation, never create another job and survive reload`, async ({ page, isMobile }) => {
  const implementation = kind === 'implementation';
  const recovery = kind === 'recovery';
  const errors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  const cardId = '77777777-7777-4777-8777-777777777777';
  const receipt = '88888888-8888-4888-8888-888888888888';
  let confirmed = 0;
  await page.route('**/rest/v1/builder_chat_threads*', route => route.fulfill({ json: [{ id: THREAD }] }));
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
  await page.route('**/rest/v1/builder_chat_messages*', route => route.fulfill({ json: [{
    id: 'review-message', seq: 1, thread_id: THREAD, role: 'owner', kind: 'message', status: 'done',
    content: 'Please revise the current specification.', created_at: '2026-10-26T00:00:00Z', payload: {},
  }, {
    id: cardId, seq: 2, thread_id: THREAD, role: 'bob', kind: 'proposal', status: 'done',
    content: 'Please revise the current specification.', created_at: '2026-10-26T00:00:00Z',
    payload: { message_id: 'review-message', revision: { ...(kind !== 'specification' ? { kind } : {}), job_id: 'existing-job', feedback: 'Check the reported current workflow and distinguish hypotheses from evidence before implementation.' },
      ...(confirmed ? { revision_receipt: receipt } : {}) },
  }] }));
  await page.route(`**/rest/v1/rpc/${recovery ? 'builder_chat_recover_implementation' : implementation ? 'builder_chat_request_code_changes' : 'builder_chat_request_spec_revision'}`, route => {
    expect(route.request().postDataJSON()).toEqual({ p_message_id: cardId });
    confirmed++;
    return route.fulfill({ json: receipt });
  });
  await page.route('**/functions/v1/bob-builder-control-room', route => {
    expect(route.request().postDataJSON().action).not.toBe('create');
    return route.fulfill({ json: { projects: [], jobs: [] } });
  });
  const open = async () => {
    await page.getByRole('button', { name: 'Jobs & approvals', exact: true }).click();
    if (isMobile) await page.getByRole('button', { name: 'Bob Builder', exact: true }).click();
    return page.getByRole('region', { name: 'Bob Builder chat', exact: true });
  };
  await signInAsAdmin(page, '/admin/builder');
  const chat = await open();
  await expect(chat.getByText(recovery ? 'Recover failed implementation on the same job' : implementation ? 'Correct implementation before a fresh human review' : 'Revise specification before implementation')).toBeVisible();
  expect(confirmed).toBe(0);
  await expect(chat.getByRole('button', { name: 'Create job', exact: true })).toHaveCount(0);
  const confirmLabel = recovery ? 'Resume failed implementation' : implementation ? 'Request implementation changes' : 'Request specification revision';
  await chat.getByRole('button', { name: confirmLabel, exact: true }).click();
  await expect(chat.getByText(`Revision requested · Receipt: ${receipt}`)).toBeVisible();
  await page.reload();
  const restored = await open();
  await expect(restored.getByText(`Revision requested · Receipt: ${receipt}`)).toBeVisible();
  await expect(restored.getByRole('button', { name: confirmLabel, exact: true })).toHaveCount(0);
  expect(await restored.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(confirmed).toBe(1);
  expect(errors).toEqual([]);
});
