import { expect, test, type Page } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin } from './fixtures';

const ORG = '33333333-3333-4333-8333-333333333333';
const FIRST = 'abababab-abab-4bab-8bab-abababababab';
const SECOND = 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
const vehicles = [
  { id: FIRST, plate_number: 'RJ198', make: 'Toyota', model: 'Hiace', year: 2018, colour: 'White', body_type: 'van', rego_status: 'current', rego_expiry: '2027-05-01', wof_status: 'expired', wof_expiry: '2026-08-01', cof_status: null, cof_expiry: null, homeless_status: 'none' },
  { id: SECOND, plate_number: 'RJ998', make: 'Ford', model: 'Transit', year: 2020, colour: 'Blue', body_type: 'van', rego_status: 'current', rego_expiry: null, wof_status: 'current', wof_expiry: null, cof_status: null, cof_expiry: null, homeless_status: 'none' },
];
const flags = [
  { id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', entity_id: FIRST, flag_type: 'stolen', alert_level: 'high', reason: 'Fixture flag evidence', active: true, raised_at: '2026-08-29T08:00:00Z', raised_by: '11111111-1111-4111-8111-111111111111' },
  { id: 'dededede-dede-4ede-8ede-dededededede', entity_id: SECOND, flag_type: 'site_banned', alert_level: 'medium', reason: 'Fixture site ban evidence', active: true, raised_at: '2026-08-28T08:00:00Z', raised_by: '11111111-1111-4111-8111-111111111111' },
];
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function fixtures(page: Page) {
  await installSupabaseFixtures(page, { officerModules: ['freedom_camping'] });
  await page.route('**/rest/v1/canonical_vehicle_public**', route => route.fulfill(json(vehicles)));
  await page.route('**/rest/v1/entity_flags**', route => {
    const id = new URL(route.request().url()).searchParams.get('entity_id');
    return route.fulfill(json(id?.startsWith('eq.') ? flags.filter(flag => flag.entity_id === id.slice(3)) : flags));
  });
  await page.route('**/rest/v1/canonical_scv_public**', route => route.fulfill(json(null)));
  await page.route('**/rest/v1/person_permits_fieldwork**', route => route.fulfill(json([])));
  await page.route('**/rest/v1/rpc/read_person_permits_fieldwork**', route => route.fulfill(json([])));
  await page.route('**/rest/v1/breach_alerts**', route => route.fulfill(json([])));
  await page.route('**/rest/v1/observations**', route => route.fulfill(json([{ id: 'efefefef-efef-4fef-8fef-efefefefefef', observed_at: '2026-08-29T08:20:00Z', is_compliant: null, compliance_reason: 'Recorded observation evidence', nights_this_zone: 0, zone: { name: 'Fixture Zone' } }])));
  await page.route('**/rest/v1/rpc/get_safety_warnings**', route => route.fulfill(json([])));
  await signInAsAdmin(page, '/admin/field-ops?area=vehicle-search');
}
async function query(page: Page) {
  await page.getByLabel('Plate or wildcard', { exact: true }).fill('rj%9%8');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('button', { name: /RJ198 Toyota Hiace/ })).toBeVisible();
}

async function expectPersistentWorkbench(page: Page) {
  await expect(page.locator('.vehicle-priority-banner')).toHaveCount(0);
  const root = page.locator('.vehicle-workbench');
  const master = page.locator('.vehicle-master');
  const dossier = page.locator('.vehicle-dossier');
  await expect(master).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) > 760) {
    await expect(dossier).toBeVisible();
    const [rootBounds, masterBounds, dossierBounds] = await Promise.all([root.boundingBox(), master.boundingBox(), dossier.boundingBox()]);
    expect(masterBounds!.width).toBe(340);
    expect(dossierBounds!.x).toBeCloseTo(masterBounds!.x + 340, 0);
    expect(dossierBounds!.width).toBeCloseTo(rootBounds!.width - 340, 0);
    expect(dossierBounds!.height).toBeCloseTo(masterBounds!.height, 0);
    expect(dossierBounds!.height).toBeGreaterThan(300);
  } else {
    await expect(page.getByRole('navigation', { name: 'Vehicle workbench panes' })).toBeVisible();
    await expect(dossier).toBeHidden();
  }
}

test('initial, empty and timeout states retain the split queue and full-height dossier', async ({ page }) => {
  await fixtures(page);
  await expect(page.getByText('Enter an exact plate or a wildcard to begin.')).toBeVisible();
  await expectPersistentWorkbench(page);
  let timeout = false;
  await page.route('**/rest/v1/canonical_vehicle_public**', async route => {
    if (timeout) await page.clock.runFor(10_100);
    else await route.fulfill(json([]));
  });
  await page.getByLabel('Plate or wildcard', { exact: true }).fill('NOTFOUND');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No matching vehicles visible in the register. Refine the plate or wildcard.')).toBeVisible();
  await expectPersistentWorkbench(page);
  timeout = true;
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Query timed out' })).toBeVisible();
  await expectPersistentWorkbench(page);
  await expect(page.getByRole('button', { name: 'Retry Query', exact: true })).toBeVisible();
});

test('wildcard returns multiple vehicles, filters fetched flags and loads a selected dossier', async ({ page }) => {
  await fixtures(page);
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/rest/v1/')) requests.push(request.url()); });
  await query(page);
  const resultBounds = await page.getByRole('button', { name: /RJ198 Toyota Hiace/ }).boundingBox();
  expect(resultBounds!.height).toBe(44);
  await expect(page.getByLabel('Plate or wildcard', { exact: true })).toHaveValue('RJ%9%8');
  await expect(page.getByRole('button', { name: /RJ998 Ford Transit/ })).toBeVisible();
  const registry = requests.find(url => url.includes('/canonical_vehicle_public'))!;
  expect(new URL(registry).searchParams.get('plate_number')).toBe('ilike.RJ%9%8');
  expect(new URL(registry).searchParams.get('limit')).toBe('50');
  const flagQuery = requests.find(url => url.includes('/entity_flags'))!;
  expect(new URL(flagQuery).searchParams.get('organization_id')).toBe(`eq.${ORG}`);
  await page.getByRole('button', { name: 'VOI / Stolen', exact: true }).click();
  await expect(page.getByRole('button', { name: /RJ998 Ford Transit/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Site Banned', exact: true }).click();
  await expect(page.getByRole('button', { name: /RJ198 Toyota Hiace/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /RJ998 Ford Transit/ })).toBeVisible();
  await page.getByRole('button', { name: 'Compliance Expired', exact: true }).click();
  await expect(page.getByRole('button', { name: /RJ198 Toyota Hiace/ })).toBeVisible();
  await page.getByRole('button', { name: /RJ198 Toyota Hiace/ }).click();
  await expect(page.getByRole('heading', { name: 'RJ198', exact: true })).toBeFocused();
  await expect(page.getByTestId('vehicle-safety')).toContainText('No active safety warnings returned');
  await expect(page.getByTestId('vehicle-priority-safety')).toHaveCount(0);
  await expect(page.getByTestId('vehicle-active-flags')).toContainText('stolen · high');
  await expect(page.getByText('Recorded observation evidence', { exact: false })).toBeVisible();
  await expect(page.getByText('Certification unavailable.', { exact: false })).toBeVisible();
  const history = requests.find(url => url.includes('/observations') && new URL(url).searchParams.has('or'))!;
  expect(new URL(history).searchParams.get('or')).toContain(`canonical_vehicle_id.eq.${FIRST}`);
  await expect(page.getByRole('heading', { name: 'Chronological evidence' })).toBeVisible();
  expect(requests.some(url => url.includes('/canonical_vehicles?'))).toBe(false);
});

test('failed and timed-out queries stay compact and retry successfully', async ({ page }) => {
  await fixtures(page);
  let mode = 'failed';
  await page.route('**/rest/v1/canonical_vehicle_public**', async route => {
    if (mode === 'failed') await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Registry unavailable' }) });
    else if (mode === 'timeout') await page.clock.runFor(10_100);
    else await route.fulfill(json(vehicles));
  });
  await page.getByLabel('Plate or wildcard', { exact: true }).fill('RJ%9%8');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Registry unavailable' })).toBeVisible();
  mode = 'timeout';
  await page.getByRole('button', { name: 'Retry Query', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Query timed out' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Query timed out' })).toContainText('ms');
  mode = 'success';
  await page.getByRole('button', { name: 'Retry Query', exact: true }).click();
  await expect(page.getByRole('button', { name: /RJ198 Toyota Hiace/ })).toBeVisible();
  await expect(page.locator('.vehicle-search-page .alert-error')).toHaveCount(0);
});

test('unavailable safety and history are not rendered as empty evidence', async ({ page }) => {
  await fixtures(page);
  await page.route('**/rest/v1/rpc/get_safety_warnings**', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Safety access denied' }) }));
  await page.route('**/rest/v1/observations**', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Observation evidence unavailable' }) }));
  await query(page);
  await page.getByRole('button', { name: /RJ198 Toyota Hiace/ }).click();
  await expect(page.getByTestId('vehicle-safety')).toContainText('Safety status unavailable');
  await expect(page.getByTestId('vehicle-safety')).not.toContainText('No active safety warnings');
  await expect(page.getByText('Evidence unavailable. Observation evidence unavailable')).toBeVisible();
  await expect(page.getByText('No observations, breaches or dated permits visible for this vehicle.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry Query', exact: true })).toBeVisible();
});

test('raise and resolve keep governed flag RPCs and server evidence', async ({ page }) => {
  await fixtures(page);
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  await page.route('**/rest/v1/rpc/raise_entity_flag**', async route => {
    writes.push({ method: 'raise', body: JSON.parse(route.request().postData()!) });
    await route.fulfill(json({ ...flags[0], id: 'fafafafa-fafa-4afa-8afa-fafafafafafa' }));
  });
  await page.route('**/rest/v1/rpc/resolve_entity_flag**', async route => {
    writes.push({ method: 'resolve', body: JSON.parse(route.request().postData()!) });
    await route.fulfill(json({ ...flags[0], active: false }));
  });
  await query(page);
  await page.getByRole('button', { name: /RJ198 Toyota Hiace/ }).click();
  await page.getByRole('button', { name: '+ Raise of-interest flag' }).click();
  await page.getByLabel('Reason / details (organisation-private)').fill('Fixture reason for governed flag');
  await page.getByRole('button', { name: 'Confirm & Raise Flag' }).click();
  await expect(page.getByText('Flag raised · audited by the server.')).toBeVisible();
  expect(writes[0].body).toMatchObject({ p_entity_type: 'vehicle', p_entity_id: FIRST, p_flag_type: 'watchlist', p_hazard_class: null });
  expect(writes[0].body.p_client_request_id).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Resolve flag', exact: true }).click();
  await expect(page.getByText('Flag resolved · audited by the server.')).toBeVisible();
  expect(writes[1].body).toMatchObject({ p_flag_id: flags[0].id, p_note: null });
});

test('rapid selection cannot show stale dossier responses', async ({ page }) => {
  await fixtures(page);
  let releaseFirst: (() => void) | undefined;
  const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route('**/rest/v1/observations**', async route => {
    if (route.request().url().includes(FIRST)) {
      await firstResponse;
      await route.fulfill(json([{ id: 'old', observed_at: '2026-08-29T08:20:00Z', compliance_reason: 'Stale first vehicle evidence', zone: null }])).catch(() => {});
    } else await route.fulfill(json([{ id: 'new', observed_at: '2026-08-29T08:20:00Z', compliance_reason: 'Current second vehicle evidence', zone: null }]));
  });
  await query(page);
  await page.getByRole('button', { name: /RJ198 Toyota Hiace/ }).click();
  if (await page.getByRole('navigation', { name: 'Vehicle workbench panes' }).isVisible()) await page.getByRole('button', { name: 'Results', exact: true }).click();
  await page.getByRole('button', { name: /RJ998 Ford Transit/ }).click();
  releaseFirst?.();
  await expect(page.getByText('Current second vehicle evidence', { exact: false })).toBeVisible();
  await expect(page.getByText('Stale first vehicle evidence', { exact: false })).toHaveCount(0);
});

test('safety write denial stays inline and cannot manufacture a successful warning', async ({ page }) => {
  await fixtures(page);
  const writes: Record<string, unknown>[] = [];
  await page.route('**/rest/v1/rpc/raise_entity_flag**', async route => {
    writes.push(JSON.parse(route.request().postData()!));
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Active member authority required' }) });
  });
  await query(page);
  await page.getByRole('button', { name: /RJ198 Toyota Hiace/ }).click();
  await page.getByRole('button', { name: 'Raise a safety warning', exact: true }).click();
  await page.getByLabel('Hazard', { exact: true }).selectOption('weapons');
  await page.getByLabel('Severity', { exact: true }).selectOption('critical');
  await page.getByLabel('Reason / details (organisation-private)').fill('Fixture safety warning source evidence');
  await page.getByRole('button', { name: 'Confirm & Raise Flag' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Flag write failed' })).toContainText('Active member authority required');
  expect(writes[0]).toMatchObject({ p_entity_type: 'vehicle', p_entity_id: FIRST, p_flag_type: 'safety_warning', p_hazard_class: 'weapons', p_alert_level: 'critical' });
  await expect(page.getByText('Flag raised · audited by the server.')).toHaveCount(0);
  await expect(page.getByTestId('vehicle-safety')).toContainText('No active safety warnings returned by the safety service.');
});

test('real critical safety warnings have a top text-and-icon banner with readable red contrast', async ({ page }) => {
  await fixtures(page);
  await page.route('**/rest/v1/rpc/get_safety_warnings**', route => route.fulfill(json([{
    id: 'fafafafa-fafa-4afa-8afa-fafafafafafa', entity_type: 'vehicle', entity_id: FIRST, requested_id: FIRST,
    hazard_class: 'weapons', alert_level: 'critical', raised_at: '2026-08-29T08:00:00Z',
    organization_id: '77777777-7777-4777-8777-777777777777', organization_name: 'Fixture safety organisation',
    contact_email: 'control@example.test', contact_phone: null, is_own_organization: false, reason: null,
  }])));
  await query(page);
  await page.getByRole('button', { name: /RJ198 Toyota Hiace/ }).click();
  const banner = page.getByTestId('vehicle-priority-safety');
  await expect(banner).toContainText('CRITICAL — do not approach; call for support');
  await expect(banner).toContainText('Weapons');
  await expect(banner.locator('.vehicle-priority-icon')).toHaveText('!');
  const computed = await banner.evaluate(node => {
    const style = getComputedStyle(node);
    const luminance = (color: string) => color.match(/\d+/g)!.slice(0, 3).map(Number).map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return { color: style.color, background: style.backgroundColor, contrast: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
  });
  expect(computed.color).toBe('rgb(127, 29, 29)');
  expect(computed.background).toBe('rgb(254, 226, 226)');
  expect(computed.contrast).toBeGreaterThanOrEqual(4.5);
  expect(await banner.evaluate(node => node.closest('header') !== null)).toBe(true);
});

test('mobile master/dossier retains focus and the full-height console does not scroll the window', async ({ page }) => {
  await fixtures(page);
  await query(page);
  await page.getByRole('button', { name: /RJ198 Toyota Hiace/ }).click();
  await expect(page.getByRole('heading', { name: 'RJ198', exact: true })).toBeFocused();
  const tabs = page.getByRole('navigation', { name: 'Vehicle workbench panes' });
  if (await tabs.isVisible()) {
    await tabs.getByRole('button', { name: 'Results', exact: true }).click();
    await expect(page.getByRole('button', { name: /RJ198 Toyota Hiace/ })).toBeFocused();
    await tabs.getByRole('button', { name: 'Dossier', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'RJ198', exact: true })).toBeFocused();
    const bounds = await tabs.getByRole('button', { name: 'Results', exact: true }).boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(1);
  await expect.poll(() => page.locator('.vehicle-dossier').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await page.locator('.vehicle-dossier').evaluate(node => { node.scrollTop = node.scrollHeight; });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
