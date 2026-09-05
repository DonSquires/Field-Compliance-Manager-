const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260905003700_quote_proposal_service_scopes.sql'),
  'utf8',
);

test('accepted proposal scopes activate bounded services but never generate roster slots', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.quote_proposal_service_scopes/);
  assert.match(migration, /quote_proposal_service_scopes_place_xor/);
  assert.match(migration, /Proposal scope requires a selected quote module/);
  assert.match(migration, /Proposal scope requires exactly one Site or Zone/);
  assert.match(migration, /Active Site does not belong to this quote client/);
  assert.match(migration, /Active Zone does not belong to this quote client/);
  assert.match(migration, /if new\.status = 'accepted' and new\.service_agreement_id is not null and old\.status is distinct from 'accepted' then/);
  assert.match(migration, /insert into public\.service_agreement_locations/);
  assert.match(migration, /insert into public\.site_services/);
  assert.doesNotMatch(migration, /insert into public\.roster_slots/);
  assert.doesNotMatch(migration, /insert into public\.shifts/);
});