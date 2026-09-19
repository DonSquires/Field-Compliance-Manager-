import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CCTV enterprise acceptance: the reviewer's whole path, on the live build, as a human would walk it.
 *
 * Stage A (always): authenticated console + queue render the governed surfaces — custody badges, the Custody
 *   record (read through cctv_evidence_custody), the biometric governance readout, the inference usage/budget
 *   rail, failure explanations, and the receipt verifier's honest answers for bad and unknown ids.
 * Stage B (CCTV_ACCEPTANCE_IMPORT=true): imports one small, already-approved test recording through the real
 *   import page (place -> camera -> file -> start), then confirms it appears as a queued clip in the console.
 * Stage C (CCTV_ACCEPTANCE_WAIT_FOR_INFERENCE=true, implies B): waits for the worker to finish the job, then
 *   issues a report from the queue and verifies its receipt.
 *
 * Credentials: the dedicated grand_master test identity (GRANDMASTER_TEST_EMAIL/PASSWORD). The fixture is fetched
 * in the Node process with the service key (never exposed to the page) from a path the owner has declared test
 * data. Every stage writes screenshots and a JSON evidence line to the report.
 */
const LIVE_URL = process.env.CCTV_ACCEPTANCE_URL || 'https://www.fcmanager.co.nz';
const email = process.env.GRANDMASTER_TEST_EMAIL || '';
const password = process.env.GRANDMASTER_TEST_PASSWORD || '';
const importEnabled = process.env.CCTV_ACCEPTANCE_IMPORT === 'true' || process.env.CCTV_ACCEPTANCE_WAIT_FOR_INFERENCE === 'true';
const waitForInference = process.env.CCTV_ACCEPTANCE_WAIT_FOR_INFERENCE === 'true';
const fixtureBucket = process.env.CCTV_ACCEPTANCE_FIXTURE_BUCKET || 'bob-uploads';
// A 6-second, 695 KB Dahua ch65 .h265 clip from the owner-approved test corpus (complete video_motion job on record).
const fixturePath = process.env.CCTV_ACCEPTANCE_FIXTURE_PATH
  || 'desktop/1b02ab97-8611-40ab-a3a0-b5c74589db58/7bd3d042-899e-4c92-ad0f-fed8cf77c157-FCM-card-p0-d001366-2026-08-23_15-07-25-2026-08-23_15-07-31-ch65.h265';
const inferenceTimeoutMs = Number(process.env.CCTV_ACCEPTANCE_INFERENCE_TIMEOUT_MS || 15 * 60_000);

type Evidence = { consoleErrors: string[]; failedRequests: string[]; httpErrors: string[] };

function monitor(page: Page): Evidence {
  const evidence: Evidence = { consoleErrors: [], failedRequests: [], httpErrors: [] };
  page.on('console', (message) => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => evidence.consoleErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText || '';
    if (errorText !== 'net::ERR_ABORTED') evidence.failedRequests.push(`${request.method()} ${new URL(request.url()).pathname} ${errorText}`);
  });
  page.on('response', (response) => {
    // Expected 4xx from deliberate negative checks (e.g. a verify of a random id returns 200 with found:false, so none here).
    if (response.status() >= 400) evidence.httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  return evidence;
}

async function signIn(page: Page): Promise<void> {
  test.skip(!email || !password, 'GRANDMASTER_TEST_EMAIL / GRANDMASTER_TEST_PASSWORD are required for the live acceptance suite');
  await page.goto(`${LIVE_URL}/admin`, { waitUntil: 'domcontentloaded' });
  const emailInput = page.getByLabel('Email address').or(page.locator('input[type="email"]')).first();
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(email);
    await page.getByLabel('Password').or(page.locator('input[type="password"]')).first().fill(password);
    await page.getByRole('button', { name: /sign.?in|login/i }).first().click();
  }
  await expect(page.locator('nav').first()).toBeVisible({ timeout: 20_000 });
  const dismiss = page.getByRole('button', { name: 'Not now', exact: true });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

function log(stage: string, detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ stage, at: new Date().toISOString(), ...detail }));
}

async function downloadFixture(): Promise<string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  test.skip(!url || !key, 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required in the Node process to fetch the approved fixture');
  const response = await fetch(`${url}/storage/v1/object/${fixtureBucket}/${fixturePath}`, { headers: { apikey: key as string, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`fixture download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), 'fcm-cctv-acceptance-'));
  const fileName = `ACCEPTANCE-${fixturePath.split('/').pop()}`;
  const local = join(dir, fileName);
  writeFileSync(local, bytes);
  log('fixture', { bytes: bytes.length, fileName });
  return local;
}

test.describe.configure({ mode: 'serial' });

test.describe('CCTV enterprise acceptance', () => {
  test('A1 · console shows custody, governance and reliability surfaces for a real organisation', async ({ page }) => {
    const evidence = monitor(page);
    await signIn(page);
    await page.goto(`${LIVE_URL}/admin/field-ops?area=cctv-console`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.cctv-console')).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'test-results/cctv-acceptance-console.png', fullPage: true });

    const cameraCount = await page.locator('.cctv-console__camera').count();
    const hasRecordings = await page.locator('.cctv-clip').count().catch(() => 0);
    const badges = await page.locator('.cctv-clip__custody').allInnerTexts().catch(() => [] as string[]);
    log('A1', { cameraCount, hasRecordings, badgeSample: badges.slice(0, 5) });

    // Biometric governance readout reads through the governed RPC and states purpose + retention.
    const governanceToggle = page.getByRole('button', { name: 'Biometric data held by this organisation' });
    if (await governanceToggle.isVisible().catch(() => false)) {
      await governanceToggle.click();
      const panel = page.locator('#cctv-biometric-governance');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('Templates are never shown or downloadable');
      await expect(panel.locator('dd').first()).toBeVisible({ timeout: 15_000 });
      log('A1.governance', { text: (await panel.innerText()).slice(0, 600) });
    }

    // Custody record for the active recording, when footage exists.
    if (hasRecordings > 0) {
      await page.locator('.cctv-clip__main').first().click();
      const custody = page.getByRole('button', { name: 'Custody record' });
      await expect(custody).toBeEnabled({ timeout: 10_000 });
      await custody.click();
      const record = page.locator('.cctv-console__custody');
      await expect(record).toBeVisible();
      await expect(record).toContainText(/Integrity hash|Seal|Last integrity check/);
      await expect(record.locator('dd').first()).toBeVisible({ timeout: 15_000 });
      log('A1.custody', { text: (await record.innerText()).slice(0, 800) });
      await page.screenshot({ path: 'test-results/cctv-acceptance-custody.png', fullPage: true });
    }

    expect(page.locator('.cctv-console .page-error')).toHaveCount(0);
    expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
    expect(evidence.failedRequests, evidence.failedRequests.join('\n')).toEqual([]);
  });

  test('A2 · queue explains failures, shows inference use against budget, and the verifier answers honestly', async ({ page }) => {
    const evidence = monitor(page);
    await signIn(page);
    await page.goto(`${LIVE_URL}/admin/field-ops?area=cctv-review`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.cctv-review-page')).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');

    const usage = page.getByLabel('Inference usage and budget');
    await expect(usage).toBeVisible({ timeout: 20_000 });
    await expect(usage).toContainText(/frames/);
    log('A2.usage', { text: (await usage.innerText()).slice(0, 400) });

    await page.getByRole('button', { name: /^Failed\s*\d*$/ }).click();
    await page.waitForTimeout(1500);
    const failureRows = page.locator('.cctv-job-failure');
    const failedCount = await failureRows.count();
    if (failedCount > 0) {
      const summary = page.locator('.cctv-failure-summary');
      await expect(summary).toBeVisible();
      await expect(summary).toContainText(/where a retry should help/);
      await failureRows.first().locator('summary').click();
      await expect(failureRows.first()).toContainText('Next step:');
      log('A2.failures', { failedCount, summary: await summary.innerText(), first: (await failureRows.first().innerText()).slice(0, 500) });
    } else {
      log('A2.failures', { failedCount: 0 });
    }
    await page.screenshot({ path: 'test-results/cctv-acceptance-queue.png', fullPage: true });

    // The verifier: a malformed id is refused locally; an unknown id is "not found", never an error.
    await page.getByRole('button', { name: /^Complete\s*\d*$/ }).click();
    await expect(page.locator('.cctv-job-row').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('.cctv-job-row-main').first().click();
    const verify = page.getByLabel('Verify a printed report');
    await expect(verify).toBeVisible({ timeout: 20_000 });
    await verify.getByLabel('Receipt id').fill('not-a-receipt');
    await verify.getByRole('button', { name: /Verify receipt/ }).click();
    await expect(verify.locator('[role="status"]')).toContainText('Enter the receipt id printed on the report');
    await verify.getByLabel('Receipt id').fill('00000000-0000-4000-8000-000000000000');
    await verify.getByRole('button', { name: /Verify receipt/ }).click();
    await expect(verify.locator('[role="status"]')).toContainText('No receipt with that id exists', { timeout: 15_000 });

    expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
    expect(evidence.failedRequests, evidence.failedRequests.join('\n')).toEqual([]);
  });

  test('B · a reviewer imports an approved test recording and sees it queued in the console', async ({ page }) => {
    test.skip(!importEnabled, 'Set CCTV_ACCEPTANCE_IMPORT=true to exercise the live import path (creates a test import in the organisation)');
    test.setTimeout(5 * 60_000);
    const evidence = monitor(page);
    const fixture = await downloadFixture();
    await signIn(page);
    await page.goto(`${LIVE_URL}/admin/field-ops?area=cctv-import`, { waitUntil: 'domcontentloaded' });
    const places = page.getByRole('listbox', { name: 'Places' });
    await expect(places).toBeVisible({ timeout: 20_000 });
    const firstPlace = places.getByRole('option').first();
    await expect(firstPlace).toBeVisible({ timeout: 20_000 });
    await firstPlace.click();
    const label = `ACCEPTANCE ${new Date().toISOString().slice(0, 16)}`;
    await page.getByLabel('Camera label').fill(label);
    await page.getByLabel('Notes').fill('Automated acceptance run on approved test footage. Safe to purge.');
    await page.locator('input[type="file"][accept]').setInputFiles(fixture);
    await expect(page.locator('.cctv-import-selection-status')).toContainText('1 video file', { timeout: 15_000 });
    await page.screenshot({ path: 'test-results/cctv-acceptance-import-ready.png', fullPage: true });
    await page.getByRole('button', { name: 'Start import' }).click();
    await expect(page.getByRole('button', { name: 'Review this import' })).toBeVisible({ timeout: 4 * 60_000 });
    await page.screenshot({ path: 'test-results/cctv-acceptance-import-done.png', fullPage: true });
    await page.getByRole('button', { name: 'Review this import' }).click();
    await expect(page.locator('.cctv-console')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.cctv-clip').first()).toBeVisible({ timeout: 30_000 });
    const status = await page.locator('.cctv-clip__status').first().innerText();
    const custody = await page.locator('.cctv-clip__custody').first().innerText();
    log('B', { label, status, custody, url: page.url() });
    expect(['Queued', 'Analysing', 'Processing', 'Complete', 'Analysed'].some((word) => status.toLowerCase().includes(word.toLowerCase())), status).toBe(true);
    process.env.CCTV_ACCEPTANCE_IMPORT_URL = page.url();
    process.env.CCTV_ACCEPTANCE_LABEL = label;
    expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
  });

  test('C · the worker finishes, the recording is hashed and verified, a report is issued and its receipt verifies', async ({ page }) => {
    test.skip(!waitForInference, 'Set CCTV_ACCEPTANCE_WAIT_FOR_INFERENCE=true to wait for live inference (GPU time) and issue a report');
    test.setTimeout(inferenceTimeoutMs + 5 * 60_000);
    const consoleUrl = process.env.CCTV_ACCEPTANCE_IMPORT_URL;
    test.skip(!consoleUrl, 'Stage B did not record an import URL');
    const evidence = monitor(page);
    await signIn(page);
    await page.goto(consoleUrl as string, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.cctv-clip').first()).toBeVisible({ timeout: 30_000 });

    const deadline = Date.now() + inferenceTimeoutMs;
    let status = '';
    while (Date.now() < deadline) {
      status = (await page.locator('.cctv-clip__status').first().innerText()).toLowerCase();
      if (/complete|analysed|failed|inconclusive|review/.test(status)) break;
      await page.waitForTimeout(10_000);
    }
    const custody = await page.locator('.cctv-clip__custody').first().innerText();
    log('C.worker', { status, custody });
    expect(status, `job did not finish in time: ${status}`).toMatch(/complete|analysed|review/);
    // The worker hashed the source on its first pass; the badge must not say "No hash yet" any more.
    expect(custody).not.toContain('No hash yet');
    await page.locator('.cctv-clip__main').first().click();
    await page.getByRole('button', { name: 'Custody record' }).click();
    const record = page.locator('.cctv-console__custody');
    await expect(record.locator('dd').first()).toBeVisible({ timeout: 15_000 });
    log('C.custody', { text: (await record.innerText()).slice(0, 800) });
    await page.screenshot({ path: 'test-results/cctv-acceptance-complete.png', fullPage: true });

    // Issue a report from the queue for this recording and verify its receipt.
    await page.goto(`${LIVE_URL}/admin/field-ops?area=cctv-review`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.cctv-review-page')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /^Complete\s*\d*$/ }).click();
    await expect(page.locator('.cctv-job-row').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('.cctv-job-row-main').first().click();
    const popup = page.waitForEvent('popup', { timeout: 60_000 }).catch(() => null);
    const draft = page.getByRole('button', { name: 'Print draft report' });
    await expect(draft).toBeVisible({ timeout: 20_000 });
    await draft.click();
    const reportWindow = await popup;
    const receiptPanel = page.getByLabel('CCTV report receipt');
    await expect(receiptPanel).toBeVisible({ timeout: 60_000 });
    const receiptText = await receiptPanel.innerText();
    const receiptId = receiptText.match(/Receipt ID: ([0-9a-f-]{36})/)?.[1];
    const sha = receiptText.match(/SHA-256: ([0-9a-f]{64})/)?.[1];
    log('C.receipt', { receiptId, sha, popupOpened: Boolean(reportWindow) });
    expect(receiptId, receiptText).toBeTruthy();
    if (reportWindow) {
      const printed = await reportWindow.locator('body').innerText().catch(() => '');
      expect(printed).toContain('Report receipt');
      expect(printed).toContain(receiptId as string);
      await reportWindow.close().catch(() => undefined);
    }
    const verify = page.getByLabel('Verify a printed report');
    await verify.getByLabel('Receipt id').fill(receiptId as string);
    await verify.getByLabel('Report hash').fill(sha ?? '');
    await verify.getByRole('button', { name: /Verify receipt/ }).click();
    await expect(verify.locator('[role="status"]')).toContainText(/The page matches receipt/, { timeout: 15_000 });
    await page.screenshot({ path: 'test-results/cctv-acceptance-verified.png', fullPage: true });
    expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
  });
});
