const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const migrations = [
  '20261106120400_officer_records_report_ledger.sql',
  '20261106120500_cost_of_service_summary.sql',
];

test('isolated Postgres officer ledger projection and cost of service', {
  skip: process.env.BOB_TEST_POSTGRES !== '1' && process.env.FCM_REPORT_DB_TEST !== '1',
  timeout: 120000,
}, () => {
  const name = `fcm-officer-ledger-cost-${process.pid}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    docker(['run', '-d', '--name', name, '--network', 'none', '-e', 'POSTGRES_PASSWORD=local-fixture-only',
      'postgis/postgis:17-3.5', 'postgres', '-c', 'listen_addresses=127.0.0.1']);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    if (!ready) throw new Error('Isolated fixture Postgres did not become ready');
    docker(['exec', name, 'createdb', '-U', 'postgres', '-T', 'template0', 'fcm_ledger_fixture']);
    const [before, after] = fs.readFileSync(path.join(__dirname, 'fixtures', 'officer-ledger-cost-db.sql'), 'utf8').split('-- APPLY MIGRATION HERE');
    const sql = migrations.map((file) => fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', file), 'utf8')).join('\n');
    try {
      docker(['exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'fcm_ledger_fixture'], `${before}\n${sql}\n${after}`);
    } catch (error) {
      throw new Error(String(error.stderr || error.message));
    }
  } finally {
    docker(['rm', '-f', name]);
  }
});
