import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const accountId = '40404040-4040-4040-8040-404040404040';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('admin opens one Client Portfolio and follows the account spine', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/crm');

  await expect(page.getByRole('heading', { name: 'Client Portfolios', exact: true })).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search client portfolios' });
  await search.fill('civic');
  await expect(page.locator(`#crm-account-${accountId}`)).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Showing 1 of 2 portfolios');
  await search.fill('no matching account');
  await expect(page.getByText('No client portfolios match this search.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page).toHaveScreenshot('crm-portfolio-register.png');
  const account = page.locator(`#crm-account-${accountId}`);
  await expect(account).toContainText('Civic Events Limited');
  await account.click();

  const portfolio = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await expect(portfolio).toBeVisible();
  await expect(portfolio).toContainText('Commercial, operational, and relationship context');
  await expect(portfolio).toHaveScreenshot('crm-portfolio-overview.png');

  await portfolio.getByRole('button', { name: 'Places 1' }).click();
  await expect(portfolio).toContainText('Civic Events House');
  await expect(portfolio).toContainText('Civic Centre');

  await portfolio.getByRole('button', { name: 'Agreements 0' }).click();
  await expect(portfolio).toContainText('No service agreements linked to this account yet.');

  await portfolio.getByRole('button', { name: 'Contacts 1' }).click();
  await expect(portfolio).toContainText('Mere Wilson');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('portfolio activity remains visible after closing and reopening the workspace', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/crm');
  await page.locator(`#crm-account-${accountId}`).click();

  const portfolio = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await portfolio.getByRole('button', { name: /Activity/ }).click();
  await portfolio.getByRole('button', { name: 'Log activity' }).click();
  await portfolio.getByLabel('Activity type').selectOption('meeting');
  await portfolio.getByLabel('Subject').fill('Portfolio walkthrough');
  await portfolio.getByLabel('Details').fill('Confirmed places, agreement, and contact context.');
  await portfolio.getByLabel('Outcome').fill('Ready for the next operational handoff.');
  await portfolio.getByRole('button', { name: 'Record activity' }).click();
  await expect(portfolio).toContainText('Portfolio walkthrough');

  await portfolio.getByRole('button', { name: 'Close client portfolio' }).click();
  await page.locator(`#crm-account-${accountId}`).click();
  const reopened = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await reopened.getByRole('button', { name: /Activity/ }).click();
  await expect(reopened).toContainText('Portfolio walkthrough');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
