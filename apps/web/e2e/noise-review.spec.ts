import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin, signInAsOfficer } from './fixtures';

test('admin records a governed Noise Control follow-up', async ({ page }) => {
	const errors = monitorBrowserErrors(page);
	await installSupabaseFixtures(page, { officerModules: ['noise_control'] });
	await signInAsAdmin(page, '/admin/field-ops?area=noise-control');
	await expect(page.getByText('Amplified music')).toBeVisible();
	if ((page.viewportSize()?.width ?? 0) < 980) {
		await expect(page.locator('.noise-assessment-scroll-cue')).toBeHidden();
		await expect(page.locator('.noise-assessment-table .reports-table')).toHaveCSS('display', 'block');
	}
	await expect(page).toHaveScreenshot('noise-oversight-first-viewport.png');
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.getByRole('button', { name: 'Require follow-up' }).click();
	const dialog = page.getByRole('dialog', { name: 'Require follow-up' });
	await expect(dialog.getByRole('button', { name: 'Confirm review' })).toBeDisabled();
	await dialog.getByLabel('Review notes').fill('Return visit required before midnight.');
	await expect(dialog).toHaveScreenshot('noise-review-dialog.png');
	await dialog.getByRole('button', { name: 'Confirm review' }).click();
	await expect(page.getByRole('status')).toContainText('Noise assessment follow_up');
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	expect(errors, errors.join('\n')).toEqual([]);
});

test('admin reviews visible noise-source evidence without changing acoustic or legal authority', async ({ page }) => {
	const errors = monitorBrowserErrors(page);
	await installSupabaseFixtures(page, { officerModules: ['noise_control'] });
	await page.route('**/rest/v1/noise_assessments**', async (route) => route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify([{
			id: 'afafafaf-afaf-4faf-8faf-afafafafafaf',
			organization_id: '40404040-4040-4040-8040-404040404040',
			officer_name: 'Sam Officer',
			decibel_reading: null,
			noise_source: 'Amplified music',
			prior_notice_count: 1,
			action_taken: 'verbal_warning',
			assessed_at: '2026-08-30T08:30:00.000Z',
			review_status: 'open',
			reviewed_at: null,
			review_notes: null,
			follow_up_required: false,
			dispatch_job_id: null,
			end_number: null,
			end_expires_at: null,
			police_present: false,
			assessment_distance_to_complainant_m: null,
			evidence_package_url: null,
			photo_urls: [{ storage_path: 'org/40404040-4040-4040-8040-404040404040/noise-assessments/test/watermarked.jpg' }],
			noise_ai_analysis: {
				status: 'available',
				classification: 'music equipment',
				confidence: 0.84,
				details: { source_type: 'music_equipment', equipment_type: 'Outdoor loudspeaker', estimated_level: 'high_visual_activity' },
				reasoning: 'A loudspeaker and active gathering are visible.',
				provider: 'test',
				model: 'test-vision',
				prompt_version: 'noise_photo_v1',
			},
			noise_ai_review: null,
		}]),
	}));
	await page.route('**/storage/v1/object/sign/scans/**', async (route) => {
		if (route.request().method() === 'POST') {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ signedURL: '/storage/v1/object/sign/scans/noise-evidence.jpg?token=test' }),
			});
			return;
		}
		await route.fulfill({ status: 200, contentType: 'image/png', path: 'node_modules/leaflet/dist/images/marker-icon.png' });
	});
	await page.route('**/rest/v1/rpc/review_noise_photo_classification', async (route) => {
		const payload = JSON.parse(route.request().postData() ?? '{}');
		expect(payload).toMatchObject({
			p_action: 'confirm',
			p_source_candidate: 'music_equipment',
			p_equipment_candidate: 'Outdoor loudspeaker',
			p_level_candidate: 'high_visual_activity',
		});
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
			assessment_id: payload.p_assessment_id,
			action: 'confirm',
			matrix_changed: false,
			legal_action_changed: false,
		}) });
	});
	await signInAsAdmin(page, '/admin/field-ops?area=noise-control');
	await page.getByRole('button', { name: 'Review photo' }).click();
	const dialog = page.getByRole('dialog', { name: 'Review source and equipment' });
	await expect(dialog.getByText('A photo cannot measure noise, set the matrix, determine excessive noise, or authorize enforcement.')).toBeVisible();
	await dialog.getByLabel('Review notes').fill('Visible source and equipment confirmed; acoustic matrix remains the officer decision.');
	await dialog.evaluate((element) => element.scrollTo({ top: 0 }));
	await expect(dialog).toHaveScreenshot('noise-photo-review-dialog.png');
	await dialog.getByRole('button', { name: 'Confirm photo review' }).click();
	await expect(page.getByRole('status')).toContainText('Acoustic matrix and legal action were unchanged');
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	expect(errors, errors.join('\n')).toEqual([]);
});

test('officer noise notification opens the exact supervisor outcome',async({page})=>{const errors=monitorBrowserErrors(page);await installOfficerScheduleFixtures(page);await signInAsOfficer(page,'/officer/noise_control?assessment=afafafaf-afaf-4faf-8faf-afafafafafaf');const assessment=page.locator('#officer-noise-afafafaf-afaf-4faf-8faf-afafafafafaf');await expect(assessment).toHaveClass(/is-context-focus/);await expect(assessment).toContainText('Supervisor review · follow up');await expect(assessment).toContainText('Return visit required before midnight.');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(errors,errors.join('\n')).toEqual([]);});