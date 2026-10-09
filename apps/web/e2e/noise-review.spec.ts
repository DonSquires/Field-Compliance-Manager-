import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin, signInAsOfficer } from './fixtures';

test('admin records a governed Noise Control follow-up', async ({ page }) => {
	const errors = monitorBrowserErrors(page);
	await installSupabaseFixtures(page, { officerModules: ['noise_control'] });
	await signInAsAdmin(page, '/admin/field-ops?area=noise-control');
	await expect(page.getByText('Amplified music')).toBeVisible();
	const register = page.getByRole('region', { name: 'Noise assessment review register' });
	await expect(page).toHaveScreenshot('noise-oversight-first-viewport.png');
	if ((page.viewportSize()?.width ?? 0) < 980) {
		await expect(page.locator('.noise-assessment-scroll-cue')).toBeVisible();
		const tableSize = await register.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
		expect(tableSize.scrollWidth).toBeGreaterThan(tableSize.clientWidth);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	}
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

test('officer noise notification opens the exact supervisor outcome',async({page})=>{const errors=monitorBrowserErrors(page);await installOfficerScheduleFixtures(page);await signInAsOfficer(page,'/officer/noise_control?assessment=afafafaf-afaf-4faf-8faf-afafafafafaf');const assessment=page.locator('#officer-noise-afafafaf-afaf-4faf-8faf-afafafafafaf');await expect(assessment).toHaveClass(/is-context-focus/);await expect(assessment).toContainText('Supervisor review · follow up');await expect(assessment).toContainText('Return visit required before midnight.');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(errors,errors.join('\n')).toEqual([]);});