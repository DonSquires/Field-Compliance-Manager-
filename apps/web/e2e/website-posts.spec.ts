import { expect, test, type Page } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin } from './fixtures';

type Post = Record<string, unknown> & { id: string; version: number; published_content: Record<string, unknown> | null };
const org = '33333333-3333-4333-8333-333333333333';

async function routes(page: Page, options: { lostReceipt?: boolean; conflict?: boolean; denied?: boolean } = {}) {
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Synthetic photo canvas unavailable');
    context.fillStyle = '#224488'; context.fillRect(0, 0, 8, 8);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const posts: Post[] = [];
  const requests: Record<string, unknown>[] = [];
  const receipts = new Map<string, Post>();
  const uploads: Buffer[] = [];
  await page.route('**/rest/v1/rpc/list_website_posts', route => route.fulfill({
    status: options.denied ? 403 : 200, contentType: 'application/json',
    body: JSON.stringify(options.denied ? { code: '42501', message: 'website_posts_access_denied' } : posts),
  }));
  await page.route('**/rest/v1/rpc/manage_website_post', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    if (options.conflict) return route.fulfill({
      status: 409, contentType: 'application/json', body: JSON.stringify({ code: '40001', message: 'website_post_conflict' }),
    });
    const recovered = receipts.get(String(body.p_request_id));
    if (recovered) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(recovered) });
    const current = posts.find(post => post.id === body.p_post_id);
    const post: Post = {
      id: String(body.p_post_id), provider_organization_id: org, slug: `synthetic-update-${body.p_post_id}`,
      title: body.p_title, summary: body.p_summary, body: body.p_body, photo_path: body.p_photo_path,
      photo_alt: body.p_photo_alt, updated_at: '2026-11-02T09:00:00.000Z',
      version: Number(body.p_expected_version) + 1,
      published_content: body.p_action === 'unpublish' ? null : body.p_action === 'publish' ? {
        id: body.p_post_id, slug: `synthetic-update-${body.p_post_id}`, title: body.p_title,
        body: body.p_body, photo_path: body.p_photo_path, photo_alt: body.p_photo_alt,
        published_at: '2026-11-02T09:00:00.000Z', updated_at: '2026-11-02T09:00:00.000Z',
        version: Number(body.p_expected_version) + 1,
      } : current?.published_content ?? null,
    };
    const index = posts.findIndex(row => row.id === post.id);
    if (index >= 0) posts[index] = post; else posts.push(post);
    receipts.set(String(body.p_request_id), post);
    if (options.lostReceipt && requests.length === 1) return route.abort('failed');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(post) });
  });
  await page.route('**/storage/v1/object/website-post-images/**', async route => {
    uploads.push(route.request().postDataBuffer() ?? Buffer.alloc(0));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ Key: 'fixture-photo', Id: 'fixture-id' }) });
  });
  await page.route('**/storage/v1/object/sign/website-post-images/**', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ signedURL: '/object/sign/website-post-images/synthetic.jpg?token=fixture-only' }),
  }));
  await page.route('**/storage/v1/object/sign/website-post-images/synthetic.jpg?token=*', route => route.fulfill({
    contentType: 'image/png', body: png,
  }));
  return { posts, requests, uploads, png };
}

test.beforeEach(async ({ page }) => { await installSupabaseFixtures(page); });

test('Website hub offers statistics and news without an analytics opt-in', async ({ page }) => {
  await routes(page);
  const analyticsCalls: unknown[] = [];
  await page.route('**/rest/v1/rpc/get_website_page_view_summary', route => {
    analyticsCalls.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ total_page_views: 0, daily: [], pages: [], regions: [] }) });
  });
  await signInAsAdmin(page, '/admin/website');
  await expect(page.getByRole('button', { name: 'Open statistics' })).toBeVisible();
  await page.getByRole('button', { name: 'Open statistics' }).click();
  await expect(page.getByRole('heading', { name: 'Website statistics', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Website' }).click();
  await page.getByRole('button', { name: 'Write or manage updates' }).click();
  await expect(page.getByRole('heading', { name: 'Write an update' })).toBeVisible();
  expect(analyticsCalls.length).toBeGreaterThan(0);
});

test('administrator saves, adds a processed photo, publishes, revises privately and unpublishes', async ({ page }) => {
  const state = await routes(page);
  await signInAsAdmin(page, '/admin/website-posts');
  await expect(page.getByLabel('Add photo')).toBeDisabled();
  await page.getByLabel('Title', { exact: true }).fill('Synthetic patrol update');
  await page.getByLabel('Update text', { exact: true }).fill('Public test text.\n\nSecond paragraph.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Private draft saved.' })).toBeVisible();
  await page.getByLabel('Add photo').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: state.png });
  await expect(page.getByRole('status').filter({ hasText: 'Photo uploaded privately.' })).toBeVisible();
  expect(state.uploads).toHaveLength(1);
  expect(state.uploads[0].includes(Buffer.from([0xff, 0xd8])), 'Uploaded pixels were converted to JPEG').toBe(true);
  await page.getByLabel('I confirm this text and photo').check();
  await expect(page.getByRole('button', { name: 'Publish to website' })).toBeDisabled();
  await page.getByLabel('Photo description', { exact: true }).fill('Synthetic vehicle at a test site');
  await page.getByLabel('I confirm this text and photo').check();
  await page.getByRole('button', { name: 'Publish to website' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Published to the website.' })).toBeVisible();
  expect(state.posts[0].published_content?.photo_alt).toBe('Synthetic vehicle at a test site');
  await expect(page.getByRole('link', { name: 'Open public update' })).toHaveAttribute('href', /^https:\/\/www.randmsecurity.com\/blog\/synthetic-update-/);
  await page.getByLabel('Title', { exact: true }).fill('Private revision');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The published version is unchanged.' })).toBeVisible();
  expect(state.posts[0].published_content?.title).toBe('Synthetic patrol update');
  await page.reload();
  await page.getByRole('button', { name: 'Private revision Published' }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Private revision');
  await page.getByRole('button', { name: 'Unpublish', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm unpublish', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Unpublished.' })).toBeVisible();
  expect(state.posts[0].published_content).toBeNull();
  await expect(page.getByRole('link', { name: 'Open public update' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('uncertain save retries the same request without creating a duplicate draft', async ({ page }) => {
  const state = await routes(page, { lostReceipt: true });
  await signInAsAdmin(page, '/admin/website-posts');
  await page.getByLabel('Title', { exact: true }).fill('Retry-safe draft');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('not confirmed');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Private draft saved.' })).toBeVisible();
  expect(state.requests[0].p_request_id).toBe(state.requests[1].p_request_id);
  expect(state.posts).toHaveLength(1);
});

test('stale edits block another write until the saved update is reopened', async ({ page }) => {
  const state = await routes(page, { conflict: true });
  await signInAsAdmin(page, '/admin/website-posts');
  await page.getByLabel('Title', { exact: true }).fill('Conflicting draft');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed elsewhere');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  expect(state.requests).toHaveLength(1);
});

test('server permission denial is not presented as an empty list', async ({ page }) => {
  await routes(page, { denied: true });
  await signInAsAdmin(page, '/admin/website-posts');
  await expect(page.getByRole('status').filter({ hasText: 'Only R&M administrators' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
});
