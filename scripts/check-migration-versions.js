const fs = require('node:fs');
const path = require('node:path');

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'));
const versions = new Map();

for (const file of files) {
  const version = file.split('_', 1)[0];
  const entries = versions.get(version) ?? [];
  entries.push(file);
  versions.set(version, entries);
}

const duplicates = [...versions.entries()].filter(([, entries]) => entries.length > 1);
if (duplicates.length > 0) {
  console.error('Duplicate Supabase migration versions detected:');
  for (const [version, entries] of duplicates) {
    console.error(`  ${version}: ${entries.join(', ')}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} Supabase migrations: all versions are unique.`);
}
