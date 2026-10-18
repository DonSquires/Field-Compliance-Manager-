import { readFileSync } from 'node:fs';

if (!process.argv.includes('--rollback-only')) throw new Error('Pass --rollback-only; synthetic records must not persist.');
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required for this owner-authorised rollback probe.');
const migration = readFileSync(new URL('../supabase/migrations/20261019110000_dedupe_main_health_repairs.sql', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('../test/fixtures/main-health-repair-dedupe.sql', import.meta.url), 'utf8');
const response = await fetch('https://api.supabase.com/v1/projects/dotczcyyzgabmtmnglqj/database/query', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `BEGIN;\n${process.argv.includes('--deployed') ? '' : migration}\n${fixture}\nROLLBACK;` }),
});
if (!response.ok) throw new Error(`Main-health dedupe probe failed (${response.status}): ${(await response.text()).slice(0, 1200)}`);
console.log('PASS: same failing file set reuses the active root repair across SHAs; a different set or a failed repair opens a new job. Synthetic records rolled back.');
