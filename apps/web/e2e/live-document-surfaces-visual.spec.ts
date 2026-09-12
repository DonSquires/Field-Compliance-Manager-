import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const LIVE_URL = 'https://www.fcmanager.co.nz';
const email = process.env.GRANDMASTER_TEST_EMAIL || '';
const password = process.env.GRANDMASTER_TEST_PASSWORD || '';

type BrowserEvidence = { consoleErrors: string[]; requestErrors: string[]; httpErrors: string[] };

function monitor(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = { consoleErrors: [], requestErrors: [], httpErrors: [] };
  page.on('console', (message) => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => evidence.consoleErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || '';
    if (failure !== 'net::ERR_ABORTED') evidence.requestErrors.push(`${request.method()} ${request.url()} ${failure}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) evidence.httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  return evidence;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${LIVE_URL}/admin`, { waitUntil: 'domcontentloaded' });
  const emailInput = page.locator('input[type="email"]').first();
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole('button', { name: /sign.?in|login/i }).first().click();
  }
  await expect(page.locator('nav').first()).toBeVisible({ timeout: 30_000 });
  const dismiss = page.getByRole('button', { name: /not now/i }).first();
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

async function createSyntheticWebm(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    if (!context || typeof MediaRecorder === 'undefined') throw new Error('Synthetic video recording is unavailable in this browser.');
    const stream = canvas.captureStream(10);
    const chunks: BlobPart[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.start();
    for (let frame = 0; frame < 10; frame += 1) {
      context.fillStyle = '#123b35';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#c7f1df';
      context.font = '20px sans-serif';
      context.fillText('FCM SYNTHETIC CCTV TEST', 28, 82);
      context.font = '12px sans-serif';
      context.fillText(`Frame ${frame + 1}`, 28, 112);
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: 'video/webm' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  });
}

async function seedSyntheticCctv(page: Page): Promise<{ fileName: string; storagePath: string }> {
  let supabaseUrl = '';
  let anonKey = '';
  page.on('request', (request) => {
    if (!anonKey && request.url().includes('/rest/v1/')) {
      anonKey = request.headers().apikey ?? '';
      supabaseUrl = new URL(request.url()).origin;
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const auth = await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('sb-')) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? 'null');
        const session = value?.currentSession ?? value;
        if (session?.access_token && session?.user?.id) return { accessToken: session.access_token, refreshToken: session.refresh_token, userId: session.user.id };
      } catch { /* Ignore unrelated local storage entries. */ }
    }
    return null;
  });
  if (!auth || !supabaseUrl || !anonKey) throw new Error('Live Supabase client configuration was not observable for synthetic CCTV seeding.');
  const client = createClient(supabaseUrl, anonKey);
  const { error: sessionError } = await client.auth.setSession({ access_token: auth.accessToken, refresh_token: auth.refreshToken });
  if (sessionError) throw sessionError;
  const fileName = `FCM-SYNTHETIC-AGENTIC-${Date.now()}.webm`;
  const attachmentId = crypto.randomUUID();
  const storagePath = `desktop/${auth.userId}/${attachmentId}-${fileName}`;
  const bytes = Buffer.from(await createSyntheticWebm(page), 'base64');
  const { error: uploadError } = await client.storage.from('bob-uploads').upload(storagePath, bytes, { contentType: 'video/webm', upsert: false });
  if (uploadError) throw uploadError;
  const { error: registerError } = await client.functions.invoke('register-desktop-video-import', {
    body: {
      attachment_id: attachmentId,
      storage_path: storagePath,
      file_name: fileName,
      file_type: 'video/webm',
      file_size_bytes: bytes.length,
      desktop_review_batch: { batch_id: `FCM-SYNTHETIC-${Date.now()}`, clip_index: 1, clip_total: 1, channel: 1, start_time: '00:00:00', end_time: '00:00:01', fragment_count: 1, source_bytes: bytes.length, cache_sha256: 'synthetic-test' },
    },
  });
  if (registerError) {
    await client.storage.from('bob-uploads').remove([storagePath]);
    throw registerError;
  }
  return { fileName, storagePath };
}

async function seedSyntheticBreach(page: Page): Promise<{ recordId: string }> {
  let supabaseUrl = '';
  let anonKey = '';
  page.on('request', (request) => {
    if (!anonKey && request.url().includes('/rest/v1/')) {
      anonKey = request.headers().apikey ?? '';
      supabaseUrl = new URL(request.url()).origin;
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const auth = await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('sb-')) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? 'null');
        const session = value?.currentSession ?? value;
        if (session?.access_token) return { accessToken: session.access_token };
      } catch { /* Ignore unrelated local storage entries. */ }
    }
    return null;
  });
  if (!auth || !supabaseUrl || !anonKey) throw new Error('Live Supabase client configuration was not observable for synthetic breach seeding.');
  const response = await page.request.post(`${supabaseUrl}/functions/v1/seed-synthetic-breach`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
    data: { marker: 'FCM-SYNTHETIC-AGENTIC', action: 'seed' },
  });
  const body = await response.json();
  if (!response.ok() || !body.record_id) throw new Error(body.error ?? `Synthetic breach seed failed (${response.status()})`);
  return { recordId: body.record_id };
}

async function cleanupSyntheticBreach(page: Page, recordId: string, action: 'cleanup' | 'cleanup_all' = 'cleanup'): Promise<void> {
  let supabaseUrl = '';
  let anonKey = '';
  page.on('request', (request) => {
    if (!anonKey && request.url().includes('/rest/v1/')) {
      anonKey = request.headers().apikey ?? '';
      supabaseUrl = new URL(request.url()).origin;
    }
  });
  await page.goto(`${LIVE_URL}/admin/files`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const auth = await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('sb-')) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? 'null');
        const session = value?.currentSession ?? value;
        if (session?.access_token) return { accessToken: session.access_token };
      } catch { /* Ignore unrelated local storage entries. */ }
    }
    return null;
  });
  if (!auth || !supabaseUrl || !anonKey) throw new Error('Authenticated Supabase configuration was unavailable for synthetic breach cleanup.');
  const response = await page.request.post(`${supabaseUrl}/functions/v1/seed-synthetic-breach`, { headers: { apikey: anonKey, Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' }, data: { marker: 'FCM-SYNTHETIC-AGENTIC', action, record_id: action === 'cleanup' ? recordId : undefined } });
  const result = { ok: response.ok(), body: await response.json() };
  if (!result.ok) throw new Error(result.body.error ?? 'Synthetic breach cleanup failed');
}

async function cleanupAllSyntheticBreaches(page: Page): Promise<void> {
  await cleanupSyntheticBreach(page, '', 'cleanup_all');
}

const surfaces = [
  { name: 'document-studio', path: '/admin/document-studio', marker: /Bob document studio/i, ready: /Document setup/i },
  { name: 'files', path: '/admin/files', marker: /File system/i, ready: /Permitted records|Files waiting registration/i },
  { name: 'locations', path: '/admin/locations', marker: /Locations/i, ready: /All Locations/i },
  { name: 'breach-review', path: '/admin/field-ops?area=breach-review', marker: /Breach Review|Compliance Breach/i, ready: /No breach records|Select Enforcement Action|Breach alert/i },
  { name: 'cctv-review', path: '/admin/field-ops?area=cctv-review', marker: /CCTV/i, ready: /Recent camera work|Select evidence/i },
] as const;

test.describe('production document workflow visual audit', () => {
  test.skip(!email || !password, 'Requires live test credentials in GRANDMASTER_TEST_EMAIL and GRANDMASTER_TEST_PASSWORD.');
  test.setTimeout(90_000);

  for (const surface of surfaces) {
    test(`${surface.name} renders without browser or horizontal layout errors`, async ({ page }, testInfo) => {
      const evidence = monitor(page);
      await signIn(page);
      await page.goto(`${LIVE_URL}${surface.path}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('body')).toContainText(surface.marker, { timeout: 30_000 });
      await expect(page.locator('body')).toContainText(surface.ready, { timeout: 30_000 });
      const dismiss = page.getByRole('button', { name: 'Not now', exact: true });
      if (await dismiss.isVisible({ timeout: 2_000 }).catch(() => false)) await dismiss.click();
      await expect(page.getByText(/Module configuration.*loading/i).first()).not.toBeVisible({ timeout: 10_000 });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.screenshot({ path: testInfo.outputPath(`${surface.name}.png`), fullPage: true });
      const layout = await page.evaluate(() => ({
        url: window.location.href,
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyText: document.body.innerText.slice(0, 1200),
      }));
      console.log(JSON.stringify({ surface: surface.name, layout, evidence }));
      expect(layout.scrollWidth, `${surface.name} overflows horizontally`).toBeLessThanOrEqual(layout.viewport + 1);
      expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
      expect(evidence.requestErrors, evidence.requestErrors.join('\n')).toEqual([]);
      expect(evidence.httpErrors, evidence.httpErrors.join('\n')).toEqual([]);
    });
  }

  test('locations opens a site-scoped Bob safety-plan draft', async ({ page }) => {
    const evidence = monitor(page);
    await signIn(page);
    await page.goto(`${LIVE_URL}/admin/locations`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/All Locations/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Bob: Draft safety plan' }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Bob: Draft safety plan' }).first().click();
    await expect(page).toHaveURL(/\/admin\/document-studio\?sourceType=site&sourceId=[0-9a-f-]+&auto=1$/i, { timeout: 30_000 });
    await expect(page.getByRole('status', { name: 'Source context for document' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('status', { name: 'Source context for document' })).toContainText(/SITE/i);
    await expect(page.getByLabel('Document type')).toHaveValue('site_safety_plan');
    await expect(page.getByText('Bob prepared this draft from source context and submitted it for human review.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.goto(`${LIVE_URL}/admin/approvals`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Approvals and activity' })).toBeVisible({ timeout: 30_000 });
    const documentQueue = page.getByRole('region', { name: 'Bob document review queue' });
    await expect(documentQueue).toBeVisible({ timeout: 30_000 });
    await expect(documentQueue.getByText('Site Safety Plan', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(documentQueue.getByText(/Conversation-only until approved/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(documentQueue.getByRole('button', { name: 'Review document' }).first()).toBeVisible();
    expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
    expect(evidence.requestErrors, evidence.requestErrors.join('\n')).toEqual([]);
    expect(evidence.httpErrors, evidence.httpErrors.join('\n')).toEqual([]);
  });

  test('actioned breach opens an enforcement-scoped Bob draft', async ({ page }) => {
    const evidence = monitor(page);
    await signIn(page);
    await cleanupAllSyntheticBreaches(page);
    const synthetic = await seedSyntheticBreach(page);
    try {
      await page.goto(`${LIVE_URL}/admin/field-ops?area=breach-review`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(/Compliance Breach Review/i)).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Actioned', exact: true }).click();
      const draftButton = page.getByRole('button', { name: '✨ Bob: Draft document', exact: true }).first();
      await expect(draftButton).toBeVisible({ timeout: 30_000 });
      await draftButton.click();
      await expect(page).toHaveURL(new RegExp(`/admin/document-studio\\?sourceType=(notice|breach)&sourceId=${synthetic.recordId}&auto=1$`, 'i'), { timeout: 30_000 });
      await expect(page.getByLabel('Document type')).toHaveValue(/letter|incident_report/);
      await expect(page.getByText('Needs review', { exact: true })).toBeVisible({ timeout: 30_000 });
      expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
      expect(evidence.requestErrors, evidence.requestErrors.join('\n')).toEqual([]);
      expect(evidence.httpErrors, evidence.httpErrors.join('\n')).toEqual([]);
    } finally {
      await cleanupSyntheticBreach(page, synthetic.recordId);
    }
  });

  test('synthetic CCTV evidence opens an evidence-scoped Bob incident report', async ({ page }) => {
    const evidence = monitor(page);
    await signIn(page);
    const synthetic = await seedSyntheticCctv(page);
    await page.goto(`${LIVE_URL}/admin/field-ops?area=cctv-review`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.cctv-review-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Desktop batch FCM-SYNT/i).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Bob: Draft incident report', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Bob: Draft incident report', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/document-studio\?sourceType=cctv&sourceId=[0-9a-f-]+&auto=1$/i, { timeout: 30_000 });
    await expect(page.getByLabel('Document type')).toHaveValue('incident_report');
    await expect(page.getByRole('textbox', { name: 'Document content' })).toContainText('FCM-SYNTHETIC-AGENTIC');
    await expect(page.getByText('Needs review', { exact: true })).toBeVisible();
    expect(page.url()).toContain('sourceType=cctv');
    expect(synthetic.fileName).toContain('FCM-SYNTHETIC-AGENTIC');
    expect(evidence.consoleErrors.filter((message) => !message.includes('Failed to load resource: the server responded with a status of 400')), evidence.consoleErrors.join('\n')).toEqual([]);
    expect(evidence.requestErrors, evidence.requestErrors.join('\n')).toEqual([]);
    expect(evidence.httpErrors, evidence.httpErrors.join('\n')).toEqual([]);
  });

});
