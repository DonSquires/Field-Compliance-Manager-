// Apply checked-in migrations to the live project through the Management API, each in its own
// transaction, and record each in supabase_migrations.schema_migrations. Owner-authorized runs only.
//   FIELD_COMPLIANCE_CODESPACE=<sbp_ PAT> node scripts/apply-migrations-live.mjs <migration.sql>...
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'dotczcyyzgabmtmnglqj';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? process.env.FIELD_COMPLIANCE_CODESPACE;
if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN or FIELD_COMPLIANCE_CODESPACE is required');

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : [];
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

for (const file of process.argv.slice(2)) {
  const base = path.basename(file, '.sql');
  const [version, ...rest] = base.split('_');
  const name = rest.join('_');
  if (!/^\d{14}$/.test(version)) throw new Error(`not a timestamped migration: ${file}`);
  const recorded = await sql(`select version, name from supabase_migrations.schema_migrations where version = ${lit(version)}`);
  if (recorded.length) {
    // The ledger is keyed on version alone. A different file recorded under this version means two
    // authors picked the same timestamp; skipping here would silently leave this migration unapplied.
    if (recorded[0].name !== name) {
      throw new Error(`version ${version} is already in the ledger as "${recorded[0].name}" — rename ${base} to a free version (see scripts/check-migration-versions.js) before applying`);
    }
    console.log(`skip ${base}: already in ledger`);
    continue;
  }
  const body = fs.readFileSync(file, 'utf8');
  console.log(`apply ${base} (${body.length} bytes)`);
  // One transaction per migration: a failing statement leaves nothing half-applied.
  await sql(`BEGIN;\n${body}\nCOMMIT;`);
  await sql(`insert into supabase_migrations.schema_migrations (version, name, statements) values (${lit(version)}, ${lit(name)}, array[${lit(body)}])`);
  console.log(`recorded ${version} ${name}`);
}
const tip = await sql('select max(version) as tip from supabase_migrations.schema_migrations');
console.log('ledger tip:', tip[0].tip);
