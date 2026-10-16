import { readFileSync } from 'node:fs';

if (!process.argv.includes('--rollback-only')) throw new Error('Pass --rollback-only to run synthetic fixtures without persistence.');
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required for the owner-authorised rollback-only test.');
const project = process.env.SUPABASE_PROJECT_REF ?? 'dotczcyyzgabmtmnglqj';
const migration = readFileSync(new URL('../supabase/migrations/20261018100000_safety_briefing_delivery_guards.sql', import.meta.url), 'utf8');
const fixtures = readFileSync(new URL('../test/fixtures/place-hazard-workflow.sql', import.meta.url), 'utf8');
const response = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `BEGIN;\n${migration}\n${fixtures}\nROLLBACK;` }),
});
if (!response.ok) {
  console.error(`Rollback-only safety workflow failed (${response.status}): ${(await response.text()).slice(0, 1200)}`);
  process.exitCode = 1;
} else {
  console.log('PASS: synthetic Bob apply/retry, unscheduled preparation/retry, direct-insert guard, scheduled acknowledgement/retry, start/stop guards, officer report/retry, reviewer notification, stale hash rejection, tenant/place authority, risk assessment, cleared controls and supervisor confirmation. Transaction rolled back; no fixtures persisted.');
}
