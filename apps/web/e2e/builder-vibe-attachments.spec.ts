import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const SESSION_ID = '91919191-9191-4919-8919-919191919191';

for (const allowCloud of [false, true]) {
  test(`Vibe records attachment cloud opt-in ${allowCloud} and resets it for the next message`, async ({ page }) => {
    const browserErrors = monitorBrowserErrors(page);
    await installSupabaseFixtures(page, { adminRole: 'grand_master' });
    const messages: Array<Record<string, unknown>> = [];
    let attachment: Record<string, unknown> | null = null;
    await page.route('**/storage/v1/object/bob-uploads/**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ Key: 'fixture-upload' }),
    }));
    await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({
      status: 200, contentType: 'application/json', body: 'true',
    }));
    await page.route('**/rest/v1/builder_vibe_sessions*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{
        id: SESSION_ID, title: 'Bob Test public layout', status: 'open',
        changed_files: [], preview_requested: false, preview_status: 'off',
        last_activity_at: '2026-10-25T00:00:00Z',
      }]),
    }));
    await page.route('**/rest/v1/builder_vibe_messages*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(messages),
    }));
    await page.route('**/rest/v1/rpc/builder_vibe_attachment_register', async route => {
      const body = route.request().postDataJSON() as { p_attachment_id: string; p_file_name: string; p_file_type: string };
      attachment = { id: body.p_attachment_id, file_name: body.p_file_name, file_type: body.p_file_type };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.p_attachment_id) });
    });
    await page.route('**/rest/v1/rpc/builder_vibe_send_with_attachments_opt_in', async route => {
      const body = route.request().postDataJSON() as {
        p_session_id: string; p_content: string; p_allow_ollama_cloud: boolean; p_attachment_ids: string[];
      };
      expect(body.p_session_id).toBe(SESSION_ID);
      expect(body.p_allow_ollama_cloud).toBe(allowCloud);
      expect(body.p_attachment_ids).toEqual([attachment?.id]);
      messages.push({
        id: '92929292-9292-4929-8929-929292929292', seq: 1, session_id: SESSION_ID,
        role: 'owner', kind: 'message', content: body.p_content, status: 'queued',
        created_at: '2026-10-25T00:00:00Z',
        payload: { attachments: [attachment], external_attachment_consent: body.p_allow_ollama_cloud },
      });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(messages[0].id) });
    });

    await signInAsAdmin(page, '/admin/builder');
    const fileInput = page.getByLabel('Attach screenshots or documents');
    await fileInput.setInputFiles({
      name: 'Bob Test public-layout.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'),
    });
    const consent = page.getByRole('checkbox', { name: /Allow this message/ });
    await expect(consent).not.toBeChecked();
    if (allowCloud) await consent.check();
    await page.getByRole('textbox', { name: 'Tell Bob what to build' }).fill('Bob Test inspect this public layout.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(consent).toHaveCount(0);

    await page.reload();
    await expect(page.getByText(allowCloud
      ? 'Attachment context: Ollama Cloud permitted for this message; raw files stay private.'
      : 'Attachment context: local models only.', { exact: true })).toBeVisible();
    await fileInput.setInputFiles({ name: 'Bob Test another-layout.png', mimeType: 'image/png', buffer: Buffer.from('fixture') });
    await expect(consent).not.toBeChecked();
    await expect(page.locator('.vibe-composer')).toBeInViewport();
    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  });
}
