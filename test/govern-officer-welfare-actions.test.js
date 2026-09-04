const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const checkinMigrationPath = path.resolve(__dirname, '../supabase/migrations/20260904240000_govern_officer_welfare_actions.sql');
const alertsMigrationPath = path.resolve(__dirname, '../supabase/migrations/20260904250000_govern_officer_welfare_alerts.sql');

test('officer welfare check-in/SOS migration revokes direct writes and binds the actor from auth.uid()', () => {
  const migration = fs.readFileSync(checkinMigrationPath, 'utf8');

  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON public\.welfare_checks FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON public\.officer_welfare_settings FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE INSERT ON public\.welfare_alerts FROM PUBLIC, anon, authenticated/);

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.record_officer_welfare_checkin/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.raise_officer_sos/);

  // Both RPCs must derive the actor and organization from auth.uid(), never from client input.
  assert.match(migration, /v_actor uuid:=auth\.uid\(\)/g);
  assert.match(migration, /select organization_id into v_org from public\.user_profiles where id=v_actor and deactivated_at is null/);

  // Idempotency: every governed write requires and dedupes on p_client_request_id.
  assert.match(migration, /if v_actor is null or p_client_request_id is null then raise exception/g);
  assert.match(migration, /client_request_id=p_client_request_id/g);

  // Audit trail on every write.
  assert.match(migration, /insert into public\.audit_log\(organization_id,actor_user_id,action,target_table,target_id,metadata\) values\(v_org,v_actor,'officer_welfare_checkin'/);
  assert.match(migration, /insert into public\.audit_log\(organization_id,actor_user_id,action,target_table,target_id,metadata\) values\(v_org,v_actor,'officer_sos_raised'/);

  assert.match(migration, /REVOKE ALL ON FUNCTION public\.record_officer_welfare_checkin\(uuid,double precision,double precision,uuid,text\) FROM PUBLIC,anon,authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.record_officer_welfare_checkin\(uuid,double precision,double precision,uuid,text\) TO authenticated,service_role/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.raise_officer_sos\(uuid,double precision,double precision,uuid,text\) FROM PUBLIC,anon,authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.raise_officer_sos\(uuid,double precision,double precision,uuid,text\) TO authenticated,service_role/);
});

test('officer welfare alerts migration adds a generic, governed alert-raising RPC for man-down/inactivity/gps-lost signals', () => {
  const migration = fs.readFileSync(alertsMigrationPath, 'utf8');

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.raise_officer_welfare_alert/);
  assert.match(migration, /p_alert_type not in \('sos','man_down','inactivity','gps_lost','missed'\) then raise exception/);
  assert.match(migration, /v_actor uuid:=auth\.uid\(\)/);
  assert.match(migration, /if v_actor is null or p_client_request_id is null then raise exception/);
  assert.match(migration, /client_request_id=p_client_request_id/);
  assert.match(migration, /insert into public\.audit_log\(organization_id,actor_user_id,action,target_table,target_id,metadata\) values\(v_org,v_actor,'officer_welfare_alert_raised'/);

  assert.match(migration, /REVOKE ALL ON FUNCTION public\.raise_officer_welfare_alert\(uuid,text,double precision,double precision,uuid,text\) FROM PUBLIC,anon,authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.raise_officer_welfare_alert\(uuid,text,double precision,double precision,uuid,text\) TO authenticated,service_role/);
});

test('mobile officer safety client calls the governed RPCs instead of writing tables directly', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../apps/mobile/src/lib/officerSafety.ts'), 'utf8');

  assert.doesNotMatch(source, /from\('welfare_checks'\)/);
  assert.doesNotMatch(source, /from\('officer_welfare_settings'\)/);
  assert.doesNotMatch(source, /from\('welfare_alerts'\)/);
  assert.match(source, /supabase\.rpc\('record_officer_welfare_checkin'/);
  assert.match(source, /supabase\.rpc\('raise_officer_sos'/);
  assert.match(source, /p_client_request_id: crypto\.randomUUID\(\)/);
});

test('web officer safety hook calls the governed RPCs instead of writing welfare tables directly', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/hooks/useOfficerSafety.ts'), 'utf8');

  assert.doesNotMatch(source, /from\('welfare_checks'\)\.insert/);
  assert.doesNotMatch(source, /from\('officer_welfare_settings'\)\.upsert/);
  assert.doesNotMatch(source, /from\('welfare_alerts'\)\s*\n?\s*\.insert/);
  assert.match(source, /supabase\.rpc\('record_officer_welfare_checkin'/);
  assert.match(source, /supabase\.rpc\('raise_officer_welfare_alert'/);
  assert.match(source, /p_client_request_id: crypto\.randomUUID\(\)/g);
});
