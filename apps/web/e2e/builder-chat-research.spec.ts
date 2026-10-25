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
  await input.fill('Explain the Docker Compose wording in this synthetic public document.');
  await expect(approval).not.toBeChecked();
  await approval.check();
  await send.click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({
    p_thread_id: THREAD, p_content: 'Explain the Docker Compose wording in this synthetic public document.',
    p_allow_cloud: true, p_web_search: false, p_purpose: 'pm',
    p_evidence_summary: 'Synthetic report: the owner wants a bounded Compose explanation, not a code change.',
    p_files: [expect.objectContaining({ file_name: 'public-fixture.txt', extracted_text: text })],
  });
  expect(submissions[0]).not.toHaveProperty('p_context');
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toContain(`/builder-chat/${THREAD}/`);
  await expect(input).toHaveValue('');
  await expect(approval).not.toBeChecked();
  expect(errors).toEqual([]);
});
