import { readFileSync } from 'node:fs';

if (!process.argv.includes('--rollback-only')) throw new Error('Pass --rollback-only; synthetic records must not persist.');
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required for this owner-authorised rollback probe.');
const migration = readFileSync(new URL('../supabase/migrations/20261019120000_builder_autopilot_child_lineage.sql', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('../test/fixtures/builder-autopilot-child.sql', import.meta.url), 'utf8');
const response = await fetch('https://api.supabase.com/v1/projects/dotczcyyzgabmtmnglqj/database/query', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `BEGIN;\n${process.argv.includes('--deployed') ? '' : migration}\n${fixture}\nROLLBACK;` }),
});
if (!response.ok) throw new Error(`Builder child probe failed (${response.status}): ${(await response.text()).slice(0, 1200)}`);
console.log('PASS: continuation is atomic, linked, idempotent and service-only; release policy is inherited. Synthetic records rolled back.');
