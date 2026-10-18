import { readFileSync } from 'node:fs';

if (!process.argv.includes('--rollback-only')) throw new Error('Pass --rollback-only; synthetic records must not persist.');
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required for this owner-authorised rollback probe.');
const migration = readFileSync(new URL('../supabase/migrations/20261019100000_safety_risk_review_lifecycle.sql', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('../test/fixtures/safety-risk-lifecycle.sql', import.meta.url), 'utf8');
const query = `BEGIN;\n${process.argv.includes('--deployed') ? '' : migration}\n${fixture}\nROLLBACK;`;
const result = await fetch('https://api.supabase.com/v1/projects/dotczcyyzgabmtmnglqj/database/query', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
});
if (!result.ok) throw new Error(`Safety lifecycle rollback probe failed (${result.status}): ${(await result.text()).slice(0, 1500)}`);
console.log('PASS: officer signed assessment/retry/scope, unsafe review, H&S report review, supervisor incident link, owner/control validation, review closure and reminders. All synthetic records rolled back.');
