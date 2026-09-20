const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260920040000_agreement_delivery_responses.sql'), 'utf8');
const lib = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/lib/serviceDelivery.ts'), 'utf8');
const portal = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/ClientPortalPage.tsx'), 'utf8');
const crmPanel = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/components/CrmAgreementDeliveryPanel.tsx'), 'utf8');

test('responses under the agreement are counted from the alarm when one is recorded, otherwise from the job, and never name officers', () => {
  assert.match(migration, /left join public\.alarm_events e on e\.dispatch_job_id = j\.id/);
  assert.match(migration, /coalesce\(e\.received_at, j\.created_at\) as raised_at/);
  assert.match(migration, /where j\.service_agreement_id = v_agreement\.id/);
  assert.match(migration, /and j\.organization_id = any\(v_providers\)/);
  assert.match(migration, /and j\.status <> 'cancelled'/);
  assert.match(migration, /'within_target', \(select count\(\*\) from jobs where on_scene_at is not null and sla_minutes is not null and on_scene_at <= raised_at \+ make_interval\(mins => sla_minutes\)\)/);
  assert.match(migration, /'median_minutes_to_scene', \(select round\(percentile_cont\(0\.5\) within group/);
  assert.match(migration, /'by_type', \(select coalesce\(jsonb_object_agg\(job_type, n\), '\{\}'::jsonb\) from typed\)/);
  assert.match(migration, /'responses', v_responses/);
  assert.doesNotMatch(migration, /assigned_officer_id|display_name|officer_user_id/);
  // the assembler stays internal; auth remains on get_agreement_service_delivery
  assert.doesNotMatch(migration, /grant execute on function public\.agreement_service_delivery/);
});

test('the client and the provider read the same response sentence', () => {
  assert.match(lib, /responses\?: DeliveryResponses/);
  assert.match(lib, /export const responseWords = /);
  assert.match(lib, /No alarms or incidents were raised under this agreement in this period\./);
  assert.match(lib, /inside the response target/);
  assert.match(lib, /from the alarm or call/);
  assert.match(portal, /responseWords\(delivery\)/);
  assert.match(crmPanel, /responseWords\(summary\)/);
});
