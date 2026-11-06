const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('isolated Postgres service delivery auth, attribution, privacy and provenance', {
  skip: process.env.BOB_TEST_POSTGRES !== '1' && process.env.FCM_REPORT_DB_TEST !== '1',
  timeout: 120000,
}, () => {
  const name = `fcm-report-service-test-${process.pid}`;
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
    docker(['exec', name, 'createdb', '-U', 'postgres', '-T', 'template0', 'fcm_report_fixture']);
    const [before, after] = fs.readFileSync(path.join(__dirname, 'fixtures', 'report-service-delivery-db.sql'), 'utf8').split('-- APPLY MIGRATION HERE');
    const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261106120300_report_service_delivery_summary.sql'), 'utf8');
    try {
      docker(['exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'fcm_report_fixture'], `${before}\n${migration}\n${after}`);
    } catch (error) {
      throw new Error(String(error.stderr || error.message));
    }
  } finally {
    docker(['rm', '-f', name]);
  }
});
