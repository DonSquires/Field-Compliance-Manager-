import { expect, test, type Locator, type Page } from '@playwright/test';
import { installClientPortalFixtures, installSupabaseFixtures, signInAsAdmin, signInAsClient, signInAsOfficer } from './fixtures';

async function expectContrast(target: Locator) {
  await expect(target).toBeVisible();
  await expect.poll(() => target.evaluate((element) => {
    const parse = (value: string) => {
      if (!value.startsWith('rgb')) throw new Error(`Expected an RGB color: ${value}`);
      const channels = value.match(/[\d.]+/g)?.map(Number);
      if (!channels || channels.length < 3) throw new Error(`Invalid color: ${value}`);
      return { rgb: channels.slice(0, 3), alpha: channels[3] ?? 1 };
    };
    const text = parse(getComputedStyle(element).color);
    const layers = [];
    let node: Element | null = element;
    while (node) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') throw new Error('Image backgrounds need a pixel-based contrast check');
      const value = parse(style.backgroundColor);
      layers.push(value);
      if (value.alpha === 1) break;
      node = node.parentElement;
    }
    const backdrop = layers.pop();
    if (!backdrop || backdrop.alpha !== 1) throw new Error('No opaque backdrop found');
    const composite = (front: typeof text, back: number[]) =>
      front.rgb.map((channel, index) => channel * front.alpha + back[index] * (1 - front.alpha));
    let background = backdrop.rgb;
    for (const layer of layers.reverse()) background = composite(layer, background);
    const luminance = (channels: number[]) =>
      channels.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const [light, dark] = [luminance(composite(text, background)), luminance(background)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  })).toBeGreaterThanOrEqual(4.5);
}

async function expectSurfaceInheritance(page: Page, target: Locator, token: string) {
  await expect(target).toBeVisible();
  const original = await page.evaluate((name) => ({
    value: document.documentElement.style.getPropertyValue(name),
    priority: document.documentElement.style.getPropertyPriority(name),
  }), token);
  try {
    await page.evaluate((name) => document.documentElement.style.setProperty(name, 'rgb(20, 40, 60)'), token);
    await expect(target).toHaveCSS('background-color', 'rgb(20, 40, 60)');
  } finally {
    await page.evaluate(({ name, value, priority }) => {
      if (value) document.documentElement.style.setProperty(name, value, priority);
      else document.documentElement.style.removeProperty(name);
    }, { name: token, ...original });
  }
}

async function expectFocusContrast(target: Locator) {
  await target.page().keyboard.press('Tab');
  await target.focus();
  await expect(target).toBeFocused();
  await expect(target).toHaveCSS('outline-style', 'solid');
  const colors = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { foreground: style.outlineColor, background: style.backgroundColor };
  });
  const luminance = (value: string) => {
    const channels = value.match(/[\d.]+/g)?.map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Expected opaque RGB: ${value}`);
    return channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  };
  const [light, dark] = [luminance(colors.foreground), luminance(colors.background)].sort((a, b) => b - a);
  expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(3);
}

test('client panels, metadata and selected periods follow shared tokens', async ({ page }) => {
  await installClientPortalFixtures(page);
  await signInAsClient(page, '/client/delivery');
  await expectSurfaceInheritance(page, page.locator('.client-delivery'), '--color-bg-surface');
  await expectSurfaceInheritance(page, page.locator('.client-status-count').first(), '--color-bg-elevated');
  await expectContrast(page.locator('.client-delivery-note'));
  await expectContrast(page.locator('.tone-danger strong'));
  await expectContrast(page.getByRole('button', { name: 'This month so far' }));
  await page.getByRole('button', { name: 'Last month' }).click();
  await expect(page.getByRole('button', { name: 'Last month' })).toHaveClass(/is-active/);
  await expectContrast(page.getByRole('button', { name: 'Last month' }));
});

test('field lookup buttons remain readable after loading the shared page CSS', async ({ page }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/canonical_vehicle_public**', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      id: 'abababab-abab-4bab-8bab-abababababab',
      plate_number: 'BOBTEST', make: 'Bob Test', model: 'Fixture', year: 2026,
      colour: 'White', body_type: 'van', rego_status: 'current', wof_status: 'expired',
      cof_status: null, homeless_status: 'none',
    }]),
  }));
  await signInAsOfficer(page, '/officer/vehicle_lookup');
  const search = page.getByRole('button', { name: 'Search Plate' });
  await page.getByPlaceholder(/Enter plate number/).fill('Bob Test');
  await expect(search).toBeEnabled();
  await expectContrast(search);
  await expectSurfaceInheritance(page, search, '--color-primary');
  await search.hover();
  await expectContrast(search);
  await expectSurfaceInheritance(page, search, '--color-primary-hover');
  await page.mouse.down();
  try {
    await expectContrast(search);
  } finally {
    await page.mouse.move(0, 0);
    await page.mouse.up();
  }
  await search.click();
  const plate = page.locator('.plate-banner');
  await expectContrast(plate);
  await expectSurfaceInheritance(page, plate, '--color-plate-bg');
  await expectContrast(page.getByText('WOF: EXPIRED'));
});

test('rate-rule pop-out inherits surfaces and readable primary action without a write', async ({ page }) => {
  await installSupabaseFixtures(page);
  await signInAsAdmin(page, '/admin/rate-rules');
  const create = page.getByRole('button', { name: 'New pay or charge rule' });
  await expectFocusContrast(create);
  await create.click();
  const dialog = page.getByRole('dialog', { name: 'New pay or charge rule' });
  await expectSurfaceInheritance(page, dialog, '--color-bg-secondary');
  await expectContrast(dialog.getByRole('button', { name: 'Create rate rule' }));
  await dialog.getByRole('button', { name: /close/i }).click();
  await expect(dialog).toBeHidden();
});

test('priority-action focus and welfare telemetry remain readable', async ({ page }, testInfo) => {
  await installSupabaseFixtures(page);
  await signInAsAdmin(page, '/admin/hub');
  await expectFocusContrast(page.locator('.admin-queue-row.is-next'));
  if (testInfo.project.name === 'mobile-chromium') {
    await page.locator('.admin-mobile-metrics > summary').click();
  }
  await expectContrast(page.locator('.admin-console-pill.is-critical:visible').first());
});

test('location hazard heading stays readable on its shared dark surface', async ({ page }) => {
  await installSupabaseFixtures(page);
  await signInAsAdmin(page, '/admin/locations');
  await expectContrast(page.getByRole('heading', { name: 'Risks officers are briefed on here' }));
  await expectContrast(page.locator('.place-hazard-kicker'));
  await expectSurfaceInheritance(page, page.locator('.place-hazard-register'), '--color-bg-surface');
});

test('Field Operations refresh and mobile selected pane keep readable console actions', async ({ page }, testInfo) => {
  await installSupabaseFixtures(page);
  await signInAsAdmin(page, '/admin/field-ops?area=landing');
  const refresh = page.locator('.field-ops-refresh button');
  await expectContrast(refresh);
  await expectSurfaceInheritance(page, refresh, '--color-bg-elevated');
  if (testInfo.project.name === 'mobile-chromium') {
    const selected = page.locator('.field-ops-pane-switcher [aria-pressed="true"]');
    await expectContrast(selected);
    await expectSurfaceInheritance(page, selected, '--color-bg-elevated');
  }
});
