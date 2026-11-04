const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../supabase/functions/_shared/existing-staff-invitation.mjs');
const id = '11111111-1111-4111-8111-111111111111';
const email = 'officer@example.test';
const user = { id, email, email_confirmed_at: null, last_sign_in_at: null };

test('creates an unconfirmed login at the existing staff UUID, without a password', async () => {
  const { ensureExistingStaffAuth } = await load();
  let payload;
  const result = await ensureExistingStaffAuth({
    getUserById: async () => ({ data: { user: null }, error: { status: 404 } }),
    createUser: async (value) => { payload = value; return { data: { user }, error: null }; },
  }, id, email, { display_name: 'Test officer' });
  assert.equal(result.id, id);
  assert.deepEqual(payload, { id, email, email_confirm: false, user_metadata: { display_name: 'Test officer' } });
});

test('retries reuse the same unconfirmed identity', async () => {
  const { ensureExistingStaffAuth } = await load();
  await ensureExistingStaffAuth({
    getUserById: async () => ({ data: { user }, error: null }),
    createUser: async () => { throw new Error('Must not create a duplicate'); },
  }, id, email, {});
});

test('does not provision after a lookup outage', async () => {
  const { ensureExistingStaffAuth } = await load();
  await assert.rejects(ensureExistingStaffAuth({
    getUserById: async () => ({ data: { user: null }, error: { status: 503 } }),
    createUser: async () => { throw new Error('Must not provision'); },
  }, id, email, {}), /could not be checked/);
});

test('rejects mismatched and already claimed identities', async () => {
  const { ensureExistingStaffAuth } = await load();
  for (const candidate of [
    { ...user, id: 'another-id' }, { ...user, email: 'someone@example.test' },
    { ...user, last_sign_in_at: '2026-01-01' }, { ...user, email_confirmed_at: '2026-01-01' },
  ]) {
    await assert.rejects(ensureExistingStaffAuth({
      getUserById: async () => ({ data: { user: candidate }, error: null }),
    }, id, email, {}), /did not match|already claimed/);
  }
});
