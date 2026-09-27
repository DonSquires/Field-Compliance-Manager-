import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page, { officerModules: ['cctv'] });
});

test('full screen contains only the complete video review pane', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'CCTV full screen is a desktop review workflow.');
  const browserErrors = monitorBrowserErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      value(this: HTMLElement) {
        (window as typeof window & { __cctvFullscreenTarget?: string }).__cctvFullscreenTarget = this.className;
        return Promise.resolve();
      },
    });
  });
  await signInAsAdmin(page, '/admin/field-ops?area=cctv-console');

  const reviewPane = page.getByRole('main', { name: 'Video review pane' });
  await expect(reviewPane).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Cameras and recordings' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Entities seen' })).toBeVisible();

  await page.getByRole('button', { name: 'Full screen' }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __cctvFullscreenTarget?: string }).__cctvFullscreenTarget)).toContain('cctv-console__stage');
  await expect(reviewPane.getByRole('toolbar', { name: 'Playback controls' })).toBeVisible();
  await expect(reviewPane.locator('.cctv-console__timeline-empty')).toBeVisible();
  await expect(reviewPane.locator('.cctv-console__cameras, .cctv-console__entities')).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('popout contains the camera wall and entity review without the camera browser', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'The popout is a second-monitor desktop surface.');
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/field-ops?area=cctv-console&popout=1');

  await expect(page.locator('.cctv-console.is-popout')).toBeVisible();
  await expect(page.getByRole('main', { name: 'Video review pane' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Entities seen' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Cameras and recordings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import footage' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Job queue & exports' })).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
