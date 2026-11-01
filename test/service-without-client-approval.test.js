const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { migrationPath, approvalSpecs, functionBlocks, acceptanceGates, applyApprovalRuling } = require('./fixtures/client-approval-ruling');

const migration = fs.readFileSync(migrationPath, 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const canon = fs.readFileSync(path.join(__dirname, '..', 'docs', 'canon', 'ORG_SERVICE_MODEL.md'), 'utf8');
const specs = approvalSpecs(migration);
const publicSpecs = specs.filter(spec => spec.name.startsWith('public.'));
const { sql: ruled, applied } = applyApprovalRuling(schema, specs);
const bodies = name => functionBlocks(ruled, name).map(block => ruled.slice(block.start, block.end));

test('the owner ruling is recorded in the owning canon document', () => {
  assert.match(canon, /Owner ruling 2026-11-01/);
  assert.match(canon, /client approval is not a condition of service/i);
  assert.match(canon, /invitation_status`? records the client-portal invitation\s+lifecycle only/i);
});

test('the migration is one fail-closed, release-lane-safe statement', () => {
  assert.ok(!migration.includes('\r'), 'LF only');
  assert.doesNotMatch(migration, /^\s*(begin|commit|rollback)\s*;/im);
  assert.doesNotMatch(migration, /^\s*(drop\s+(table|schema|database|column)|truncate\s+table|alter\s+table[^;]*\bdrop\b|delete\s+from\s+\S+\s*;)/im);
  assert.equal((migration.match(/^DO \$migration\$/gm) ?? []).length, 1);
  assert.match(migration, /IF v_count <> v_spec\.expected THEN\s+RAISE EXCEPTION/);
  assert.match(migration, /EXECUTE replace\(v_def, v_anchor, v_replacement\);/);
  assert.deepEqual(specs.map(spec => spec.step), specs.map((_, index) => index + 1));
  const residualTargets = [...migration.matchAll(/^\s+\('([^']+)', (\d+)\),?$/gm)].map(match => match[1]);
  assert.deepEqual(new Set(residualTargets), new Set(specs.map(spec => spec.target)));
});

test('client-side disclosure, invitation lifecycle and duplicate guards are deliberately untouched', () => {
  for (const kept of ['publish_location_event_continuity', 'accept_client_invitation', 'sync_invitation_status',
    'save_service_client', 'ensure_crm_client_agreement', 'prepare_crm_client_invitation', 'resolve_org_invitation',
    'get_crm_onboarding_workspace', 'seed_aam_e2e_dataset']) {
    assert.ok(!specs.some(spec => spec.name.endsWith(`.${kept}`)), kept);
  }
  const [continuity] = bodies('public.publish_location_event_continuity');
  assert.ok(acceptanceGates(continuity).length > 0, 'cross-organisation continuity still needs an accepted portal agreement');
});

test('accepting a quote no longer forges a client-portal acceptance', () => {
  const [acceptQuote] = bodies('public.accept_quote');
  assert.ok(acceptQuote, 'accept_quote is in the catalog');
  assert.doesNotMatch(acceptQuote, /invitation_status/);
  assert.match(acceptQuote, /set agreement_type = 'operational'\s+where id = v_agreement_id;/);
});

test('each catalog body matches the migration anchors exactly, or already holds the rewrite', () => {
  for (const spec of publicSpecs) {
    assert.ok([0, spec.expected].includes(applied.get(spec.step)), `step ${spec.step} ${spec.target}`);
  }
  const pending = publicSpecs.filter(spec => applied.get(spec.step) === spec.expected).length;
  assert.ok(pending === 0 || pending === publicSpecs.length, 'schema.sql is either wholly before or wholly after the migration');
});

test('provider-side service paths no longer require client approval or provider attestation', () => {
  for (const name of new Set(publicSpecs.map(spec => spec.name))) {
    const remaining = bodies(name).flatMap(acceptanceGates);
    if (name === 'public.has_location_access') {
      assert.equal(remaining.length, 1, name);
      const [body] = bodies(name);
      const clientBranch = body.slice(body.indexOf("p_direction = 'client_reads_provider'"));
      assert.match(clientBranch.slice(0, clientBranch.indexOf('))')), /invitation_status = 'accepted'/,
        'only clients reading provider evidence still need an accepted portal agreement');
    } else {
      assert.deepEqual(remaining, [], name);
    }
  }
});

test('messages describe the current agreement rather than client acceptance', () => {
  for (const old of ['No confirmed operational engagement for this client',
    'This client has no confirmed operational engagement with your provider',
    'Accepted operational service agreement not found', 'Accepted operational agreement required before review',
    'Only accepted operational agreements can be configured', 'An accepted operational agreement is required',
    'Client approval or an active finance-share invite is required', 'Client approval or an active reporting-share invite is required']) {
    for (const name of new Set(publicSpecs.map(spec => spec.name))) {
      assert.ok(!bodies(name).some(body => body.includes(old)), `${name}: ${old}`);
    }
  }
});
