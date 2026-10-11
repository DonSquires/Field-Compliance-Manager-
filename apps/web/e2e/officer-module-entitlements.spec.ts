import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('officer module directory requires both a direct grant and organisation entitlement', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await signInAsOfficer(page, '/officer/modules');

  await expect(page.getByRole('heading', { name: 'Enabled modules' })).toBeVisible();
  await expect(page.getByText('No enabled field modules are available.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Welfare' })).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('enabled module cards keep actions in bounds and expose standalone routes only when supported', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { officerModules: ['patrol', 'freedom_camping', 'biosecurity', 'parking', 'smoke_control'] });
  await signInAsOfficer(page, '/officer/modules');

  const cards = page.locator('.officer-module-card');
  await expect(cards).toHaveCount(5);
  const layout = await cards.evaluateAll((elements) => elements.map((card) => {
    const cardBounds = card.getBoundingClientRect();
    const actions = Array.from(card.querySelectorAll('button')).map((button) => {
      const bounds = button.getBoundingClientRect();
      const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return {
        label: button.textContent?.trim(),
        contained: bounds.left >= cardBounds.left - 1 && bounds.right <= cardBounds.right + 1,
        receivesPointer: Boolean(target && button.contains(target)),
      };
    });
    return { label: card.querySelector('strong')?.textContent, actions };
  }));
  expect(layout.flatMap((card) => card.actions).every((action) => action.contained && action.receivesPointer)).toBe(true);

  const patrolCard = cards.filter({ hasText: 'Patrol' }).first();
  await expect(patrolCard.getByRole('button', { name: 'Open standalone app' })).toHaveCount(0);
  const campingCard = cards.filter({ hasText: 'Freedom Camping' });
  const standaloneButton = campingCard.getByRole('button', { name: 'Open standalone app' });
  await standaloneButton.click();
  await expect(page).toHaveURL(/\/modules\/freedom_camping$/);
  await expect(page.getByText('Standalone module')).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});