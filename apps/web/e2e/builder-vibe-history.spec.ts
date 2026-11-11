import { expect, test, type WebSocketRoute } from '@playwright/test';
import { ADMIN_ID, installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test('owner can page through long Vibe histories on desktop and mobile', async ({ page }) => {
  test.setTimeout(60_000);
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));

  const sessions = Array.from({ length: 105 }, (_, index) => {
    const number = index + 1;
    return {
      id: `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`,
      human_reference: `VB-${number}`, created_by: ADMIN_ID,
      title: `Session ${String(number).padStart(3, '0')}`, status: 'open', branch: null,
      base_sha: null, head_sha: null, changed_files: [], preview_requested: false,
      preview_status: 'off', preview_detail: null, pr_url: null,
      last_activity_at: '2026-11-10T00:00:00.000Z', updated_at: '2026-11-10T00:00:00.000Z',
    };
  });
  const activeSession = sessions[104].id;
  const messages = Array.from({ length: 705 }, (_, index) => {
    const seq = index + 1;
    return {
      id: `10000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`,
      seq, session_id: activeSession, role: 'bob', kind: 'message', content: `Message ${seq}`,
      payload: {}, status: 'done', created_at: '2026-11-10T00:00:00.000Z',
    };
  });
  await page.route('**/rest/v1/builder_vibe_sessions*', async route => {
    const url = new URL(route.request().url());
    const cursor = /id\.lt\.([0-9a-f-]+)/.exec(url.searchParams.get('or') ?? '')?.[1];
    const limit = Number(url.searchParams.get('limit'));
    const result = sessions.filter(row => !cursor || row.id < cursor).sort((a, b) => b.id.localeCompare(a.id)).slice(0, limit);
    await route.fulfill({ json: result });
  });
  await page.route('**/rest/v1/builder_vibe_messages*', async route => {
    const url = new URL(route.request().url());
    const cursor = Number((url.searchParams.get('seq') ?? '').replace('lt.', '')) || Infinity;
    const limit = Number(url.searchParams.get('limit'));
    const sessionId = (url.searchParams.get('session_id') ?? '').replace('eq.', '');
    const result = messages.filter(row => row.session_id === sessionId && row.seq < cursor).sort((a, b) => b.seq - a.seq).slice(0, limit);
    await route.fulfill({ json: result });
  });

  await signInAsAdmin(page, '/admin/builder');
  await expect(page.getByText('Message 705', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Reference: VB-105', { exact: true })).toBeVisible();
  await expect(page.getByText('Message 1', { exact: true })).toHaveCount(0);

  const loadEarlier = page.getByRole('button', { name: 'Load earlier messages' });
  const visibleAnchor = page.getByText('Message 606', { exact: true });
  await loadEarlier.scrollIntoViewIfNeeded();
  const anchorTop = await visibleAnchor.evaluate(element => element.getBoundingClientRect().top);
  await loadEarlier.click();
  await expect(page.getByText('Message 506', { exact: true })).toBeAttached();
  await expect.poll(async () => Math.abs(await visibleAnchor.evaluate(element => element.getBoundingClientRect().top) - anchorTop)).toBeLessThan(3);

  for (const first of [406, 306, 206, 106, 6, 1]) {
    await page.getByRole('button', { name: 'Load earlier messages' }).click();
    await expect(page.getByText(`Message ${first}`, { exact: true })).toBeAttached();
  }
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
  await expect(page.getByText('Message 705', { exact: true })).toHaveCount(1);

  await page.getByRole('button', { name: 'Load older sessions' }).click();
  await expect(page.getByText('Session 006', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Load older sessions' }).click();
  await expect(page.getByText('Session 001', { exact: true })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Load older sessions' })).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('owner can find and rename a closed Vibe session by its reference', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));

  const open = {
    id: '00000000-0000-4000-8000-000000000001', human_reference: 'VB-1', created_by: ADMIN_ID,
    title: 'Current session', status: 'open', branch: null, base_sha: null, head_sha: null,
    changed_files: [], preview_requested: false, preview_status: 'off', preview_detail: null, pr_url: null,
    last_activity_at: '2026-11-10T00:00:00.000Z', updated_at: '2026-11-10T00:00:00.000Z',
  };
  let closed = {
    ...open, id: '00000000-0000-4000-8000-000000000202', human_reference: 'VB-202',
    title: 'Old report investigation', status: 'closed', last_activity_at: '2026-11-01T00:00:00.000Z',
  };
  await page.route('**/rest/v1/builder_vibe_sessions*', route => {
    const url = new URL(route.request().url());
    const status = url.searchParams.get('status');
    const reference = url.searchParams.get('human_reference');
    const title = url.searchParams.get('title');
    let rows = [open, closed];
    if (status === 'eq.closed') rows = rows.filter(row => row.status === 'closed');
    if (status === 'neq.closed') rows = rows.filter(row => row.status !== 'closed');
    if (reference) rows = rows.filter(row => new RegExp(reference.slice('imatch.'.length), 'i').test(row.human_reference));
    if (title) rows = rows.filter(row => new RegExp(title.slice('imatch.'.length), 'i').test(row.title));
    return route.fulfill({ json: rows });
  });
  await page.route('**/rest/v1/builder_vibe_messages*', route => {
    const sessionId = new URL(route.request().url()).searchParams.get('session_id');
    const messages = sessionId === `eq.${closed.id}` ? [{
      id: '10000000-0000-4000-8000-000000000202', seq: 1, session_id: closed.id,
      role: 'owner', kind: 'message', content: 'Investigate missing report photos',
      payload: {}, status: 'done', created_at: '2026-11-01T00:00:00.000Z',
    }] : [];
    return route.fulfill({ json: messages });
  });
  await page.route('**/rest/v1/rpc/builder_vibe_rename_session', route => {
    const body = route.request().postDataJSON() as { p_session_id: string; p_expected_title: string; p_title: string };
    if (body.p_session_id !== closed.id || body.p_expected_title !== closed.title || body.p_title !== 'Report photo follow-up') {
      return route.fulfill({ status: 400, json: { message: 'Unexpected rename request' } });
    }
    closed = { ...closed, title: body.p_title, updated_at: '2026-11-11T00:00:00.123456Z' };
    return route.fulfill({ json: closed });
  });

  await signInAsAdmin(page, '/admin/builder');
  await expect(page.getByText('Reference: VB-1', { exact: true })).toBeVisible();
  await page.getByLabel('Search Vibe sessions').fill('VB-20');
  await page.getByRole('button', { name: 'Search all Vibe sessions' }).click();
  const searchResults = page.getByRole('region', { name: 'Vibe session search results' });
  await searchResults.getByRole('button', { name: /VB-202.*Old report investigation/ }).click();
  await expect(page.getByText('Reference: VB-202', { exact: true })).toBeVisible();
  await expect(page.getByText('Investigate missing report photos', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'Edit session name' }).click();
  await page.getByLabel('Session name', { exact: true }).fill('Report photo follow-up');
  await page.getByRole('button', { name: 'Save session name' }).click();
  await expect(page.getByText('Name saved for VB-202.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Report photo follow-up', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show closed sessions' }).click();
  await expect(page.getByRole('region', { name: 'Closed Vibe sessions' })
    .getByRole('button', { name: /VB-202.*Report photo follow-up/ })).toBeVisible();

  await page.reload();
  await page.getByLabel('Search Vibe sessions').fill('Report photo follow-up');
  await page.getByRole('button', { name: 'Search all Vibe sessions' }).click();
  await expect(page.getByRole('region', { name: 'Vibe session search results' })
    .getByRole('button', { name: /VB-202.*Report photo follow-up/ })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('session-page errors remain visible while the mobile preview is open', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'The preview hides the conversation on mobile.');
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
  const sessions = Array.from({ length: 51 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
    title: `Session ${index + 1}`, status: 'open', branch: null, base_sha: null, head_sha: null,
    changed_files: [], preview_requested: false, preview_status: 'off', preview_detail: null, pr_url: null,
    last_activity_at: '2026-11-10T00:00:00.000Z',
  }));
  await page.route('**/rest/v1/builder_vibe_sessions*', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('or')) {
      await route.fulfill({ status: 400, json: { message: 'Older sessions temporarily unavailable' } });
      return;
    }
    await route.fulfill({ json: sessions.slice().reverse() });
  });
  await page.route('**/rest/v1/builder_vibe_messages*', route => route.fulfill({ json: [] }));

  await signInAsAdmin(page, '/admin/builder');
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Load older sessions' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Older sessions temporarily unavailable' })).toBeInViewport({ ratio: 0.5 });
});

test('conversation-page errors remain visible after opening mobile preview', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'The preview hides the conversation on mobile.');
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
  const sessionId = '00000000-0000-4000-8000-000000000033';
  const active = {
    id: sessionId, title: 'Preview session', status: 'open', branch: null, base_sha: null, head_sha: null,
    changed_files: [], preview_requested: false, preview_status: 'off', preview_detail: null, pr_url: null,
    last_activity_at: '2026-11-10T00:00:00.000Z',
  };
  const messages = Array.from({ length: 101 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
    seq: index + 1, session_id: sessionId, role: 'bob', kind: 'message', content: `Message ${index + 1}`,
    payload: {}, status: 'done', created_at: '2026-11-10T00:00:00.000Z',
  }));
  let releaseOlder!: () => void;
  const pending = new Promise<void>(resolve => { releaseOlder = resolve; });
  let requested = false;
  await page.route('**/rest/v1/builder_vibe_sessions*', route => route.fulfill({ json: [active] }));
  await page.route('**/rest/v1/builder_vibe_messages*', async route => {
    if (new URL(route.request().url()).searchParams.has('seq')) {
      requested = true;
      await pending;
      await route.fulfill({ status: 400, json: { message: 'Older conversation unavailable' } });
      return;
    }
    await route.fulfill({ json: messages.slice().reverse() });
  });

  await signInAsAdmin(page, '/admin/builder');
  await page.getByRole('button', { name: 'Load earlier messages' }).click();
  await expect.poll(() => requested).toBe(true);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  releaseOlder();
  await expect(page.getByRole('alert').filter({ hasText: 'Older conversation unavailable' })).toBeInViewport({ ratio: 0.5 });
});

test('live messages respect the reading position on desktop and mobile', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await page.route('**/rest/v1/rpc/is_grand_master', route => route.fulfill({ json: true }));
  const sessionId = '00000000-0000-4000-8000-000000000033';
  const sessions = Array.from({ length: 51 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
    title: index === 50 ? 'Live session' : `Other session ${index + 1}`, status: 'open', branch: null, base_sha: null, head_sha: null,
    changed_files: [], preview_requested: false, preview_status: 'off', preview_detail: null, pr_url: null,
    last_activity_at: '2026-11-10T00:00:00.000Z',
  })).reverse();
  const message = (seq: number, content: string) => ({
    id: `10000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`,
    seq, session_id: sessionId, role: 'bob', kind: 'message', content,
    payload: {}, status: 'done', created_at: '2026-11-10T00:00:00.000Z',
  });
  const messages = Array.from({ length: 101 }, (_, index) => message(index + 1, `Message ${index + 1}`));
  let failSessionRefresh = false;
  await page.route('**/rest/v1/builder_vibe_sessions*', route => {
    if (failSessionRefresh) {
      failSessionRefresh = false;
      return route.fulfill({ status: 400, json: { message: 'Background session refresh failed' } });
    }
    const url = new URL(route.request().url());
    const closed = url.searchParams.get('status') === 'eq.closed';
    return route.fulfill({ json: sessions.filter(row => closed ? row.status === 'closed' : row.status !== 'closed') });
  });
  await page.route('**/rest/v1/builder_vibe_messages*', route => {
    const url = new URL(route.request().url());
    const filters = url.searchParams.getAll('seq');
    const requestedSession = (url.searchParams.get('session_id') ?? '').replace('eq.', '');
    const filtered = messages.filter(row => row.session_id === requestedSession && filters.every(filter => {
      const [operator, value] = filter.split('.');
      const seq = Number(value);
      if (operator === 'lt') return row.seq < seq;
      if (operator === 'lte') return row.seq <= seq;
      if (operator === 'gt') return row.seq > seq;
      if (operator === 'gte') return row.seq >= seq;
      throw new Error(`Unexpected sequence filter: ${filter}`);
    }));
    const ascending = (url.searchParams.get('order') ?? '').includes('seq.asc');
    const limit = Number(url.searchParams.get('limit'));
    return route.fulfill({ json: filtered.sort((a, b) => ascending ? a.seq - b.seq : b.seq - a.seq).slice(0, limit) });
  });

  let liveChannel: { socket: WebSocketRoute; topic: string; joinRef: string | null; id: number } | undefined;
  let sessionsChannel: typeof liveChannel;
  await page.routeWebSocket('**/realtime/v1/websocket*', socket => {
    socket.onMessage(raw => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(raw.toString()) as [
        string | null, string | null, string, string,
        { config?: { postgres_changes?: Array<{ event: string; schema: string; table: string; filter?: string }> } },
      ];
      if (event === 'phx_join') {
        const changes = (payload.config?.postgres_changes ?? []).map((filter, index) => ({ ...filter, id: index + 1 }));
        socket.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: changes } }]));
        if (topic === `realtime:builder-vibe-${sessionId}`) liveChannel = { socket, topic, joinRef, id: changes[0].id };
        if (topic === 'realtime:builder-vibe-sessions') sessionsChannel = { socket, topic, joinRef, id: changes[0].id };
      } else if (event === 'heartbeat') {
        socket.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]));
      }
    });
  });
  const insertLive = (seq: number) => {
    if (!liveChannel) throw new Error('Vibe message channel did not subscribe');
    const row = message(seq, `Live ${seq}`);
    messages.push(row);
    liveChannel.socket.send(JSON.stringify([liveChannel.joinRef, null, liveChannel.topic, 'postgres_changes', {
      ids: [liveChannel.id],
      data: { schema: 'public', table: 'builder_vibe_messages', commit_timestamp: '2026-11-10T00:00:00.000Z',
        type: 'INSERT', columns: [], record: row, old_record: {}, errors: null },
    }]));
  };

  await signInAsAdmin(page, '/admin/builder');
  await expect(page.getByText('Message 101', { exact: true })).toBeAttached();
  await expect.poll(() => Boolean(liveChannel)).toBe(true);
  await page.getByRole('button', { name: 'Load earlier messages' }).scrollIntoViewIfNeeded();
  const anchor = page.getByText('Message 2', { exact: true });
  const anchorTop = await anchor.evaluate(element => element.getBoundingClientRect().top);
  insertLive(102);
  await expect(page.getByText('Live 102', { exact: true })).toBeAttached();
  await expect.poll(async () => Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - anchorTop)).toBeLessThan(3);

  let nextSeq = 103;
  if (testInfo.project.name === 'desktop-chromium') {
    if (!liveChannel) throw new Error('Vibe message channel did not subscribe');
    liveChannel.socket.send(JSON.stringify([liveChannel.joinRef, null, liveChannel.topic, 'phx_error', {}]));
    const reload = page.getByRole('button', { name: 'Reload conversation' });
    await expect(reload).toBeVisible();
    messages.push(...Array.from({ length: 150 }, (_, index) => message(index + 103, `Offline ${index + 103}`)));
    await reload.click();
    await expect(page.getByText('Offline 252', { exact: true })).toBeAttached();
    await expect(page.getByText('Offline 103', { exact: true })).toBeAttached();
    await expect.poll(async () => Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - anchorTop)).toBeLessThan(3);
    nextSeq = 253;
  }

  if (testInfo.project.name === 'mobile-chromium') {
    const reading = page.getByText('Message 60', { exact: true });
    await reading.scrollIntoViewIfNeeded();
    const readingTop = await reading.evaluate(element => element.getBoundingClientRect().top);
    if (!sessionsChannel) throw new Error('Vibe session channel did not subscribe');
    failSessionRefresh = true;
    sessionsChannel.socket.send(JSON.stringify([sessionsChannel.joinRef, null, sessionsChannel.topic, 'postgres_changes', {
      ids: [sessionsChannel.id],
      data: { schema: 'public', table: 'builder_vibe_sessions', commit_timestamp: '2026-11-10T00:00:00.000Z',
        type: 'UPDATE', columns: [], record: sessions[0], old_record: {}, errors: null },
    }]));
    await expect(page.getByRole('alert').filter({ hasText: 'Background session refresh failed' })).toBeInViewport();
    await expect.poll(async () => Math.abs(await reading.evaluate(element => element.getBoundingClientRect().top) - readingTop)).toBeLessThan(3);
    await page.getByRole('button', { name: 'Dismiss session error' }).click();
    const expectedError = 'Failed to load resource: the server responded with a status of 400 (Bad Request)';
    await expect.poll(() => browserErrors.filter(error => error === expectedError).length).toBe(1);
    browserErrors.splice(browserErrors.indexOf(expectedError), 1);
  }

  await page.getByText(nextSeq === 253 ? 'Offline 252' : 'Live 102', { exact: true }).scrollIntoViewIfNeeded();
  await page.locator('.vibe-composer').scrollIntoViewIfNeeded();
  insertLive(nextSeq);
  await expect(page.getByText(`Live ${nextSeq}`, { exact: true })).toBeInViewport();

  if (testInfo.project.name === 'mobile-chromium') {
    await page.getByRole('textbox', { name: 'Tell Bob what to build' }).evaluate(element => { element.style.height = '260px'; });
    await page.getByText(`Live ${nextSeq}`, { exact: true }).evaluate(element => element.scrollIntoView({ block: 'end' }));
    await expect(page.getByText(`Live ${nextSeq}`, { exact: true })).toBeInViewport();
    insertLive(nextSeq + 1);
    await expect(page.getByText(`Live ${nextSeq + 1}`, { exact: true })).toBeInViewport();

    await page.setViewportSize({ width: 412, height: 400 });
    await page.getByLabel('Attach screenshots or documents').setInputFiles(Array.from({ length: 5 }, (_, index) => ({
      name: `photo-${index}.png`, mimeType: 'image/png', buffer: Buffer.from('image'),
    })));
    await page.locator('.vibe-composer').evaluate(element => element.scrollIntoView({ block: 'end' }));
    const composerInput = page.getByRole('textbox', { name: 'Tell Bob what to build' });
    await expect(composerInput).toBeInViewport({ ratio: 0.4 });
    await expect.poll(() => page.locator('.vibe-thread > div:last-child').evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(0);
    const inputTop = await composerInput.evaluate(element => element.getBoundingClientRect().top);
    insertLive(nextSeq + 2);
    await expect(page.getByText(`Live ${nextSeq + 2}`, { exact: true })).toBeAttached();
    await expect.poll(async () => Math.abs(await composerInput.evaluate(element => element.getBoundingClientRect().top) - inputTop)).toBeLessThan(3);
    await page.setViewportSize({ width: 412, height: 915 });
    for (let index = 0; index < 5; index += 1) await page.getByRole('button', { name: `Remove photo-${index}.png` }).click();
  }

  const removed = page.getByText('Message 101', { exact: true });
  await expect(removed).toHaveCount(1);
  messages.splice(messages.findIndex(row => row.seq === 101), 1);
  const refresh = page.getByRole('button', { name: 'Refresh conversation' });
  await refresh.scrollIntoViewIfNeeded();
  await expect(refresh).toBeInViewport();
  await refresh.click();
  await expect(removed).toHaveCount(0);

  await page.getByRole('textbox', { name: 'Tell Bob what to build' }).fill('Draft to recover after closing');
  if (!sessionsChannel) throw new Error('Vibe session channel did not subscribe');
  sessions[0] = { ...sessions[0], status: 'closed' };
  sessionsChannel.socket.send(JSON.stringify([sessionsChannel.joinRef, null, sessionsChannel.topic, 'postgres_changes', {
    ids: [sessionsChannel.id],
    data: { schema: 'public', table: 'builder_vibe_sessions', commit_timestamp: '2026-11-10T00:00:00.000Z',
      type: 'UPDATE', columns: [], record: sessions[0], old_record: {}, errors: null },
  }]));
  const review = page.getByRole('button', { name: 'Review unsent work' });
  await expect(review).toBeInViewport();
  await review.click();
  await expect(page.getByRole('region', { name: 'Unsent drafts' })).toBeInViewport();
  await expect(page.getByRole('textbox', { name: 'Unsent draft for Live session' })).toHaveValue('Draft to recover after closing');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
