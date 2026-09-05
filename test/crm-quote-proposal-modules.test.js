const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260905003500_quote_proposal_modules.sql'),
  'utf8',
);

test('quote proposal modules remain draft commercial intent until acceptance', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.quote_proposal_modules/);
  assert.match(migration, /module_key text NOT NULL REFERENCES public\.module_catalog\(module_key\)/);
  assert.match(migration, /if v_quote\.status <> 'draft' then raise exception 'Proposal modules can only be changed on a draft quote'/);
  assert.match(migration, /Active module catalog entry required/);
  assert.match(migration, /Active provider billing rate rule required for this module/);
  assert.match(migration, /if new\.status = 'accepted' and new\.service_agreement_id is not null and old\.status is distinct from 'accepted' then/);
  assert.match(migration, /insert into public\.service_agreement_modules/);
  assert.match(migration, /AFTER UPDATE OF status ON public\.quotes/);
  assert.doesNotMatch(migration.slice(0, migration.indexOf('CREATE OR REPLACE FUNCTION public.activate_quote_proposal_modules')), /service_agreement_modules/);
});