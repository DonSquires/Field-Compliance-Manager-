import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'supabase', 'functions', 'generate-notice', 'index.ts'),
  'utf8',
);

test('preview returns before issued notice writes', () => {
  const preview = source.indexOf("if (operation === 'preview')");
  const noticeWrite = source.indexOf("from('notices_to_vacate').insert");
  assert.ok(preview > 0);
  assert.ok(noticeWrite > preview);
  assert.match(source, /preview: true/);
});

test('formal issue requires exact profile-name authorization', () => {
  assert.match(source, /typedName !== profile\.display_name\.trim\(\)/);
  assert.match(source, /Typed name must exactly match the signed-in profile name/);
  assert.match(source, /action: 'notice_print_authorized'/);
  assert.match(source, /typed_name_match: true/);
  assert.match(source, /print_request_id/);
  assert.match(source, /notice_print_authorizations/);
  assert.match(source, /existingAuthorization\.status === 'completed'/);
});

test('officer notice generation requires persisted direct authority', () => {
  assert.match(source, /observation\.officer_id !== user\.id/);
  assert.match(source, /alert\.requested_by !== user\.id/);
  assert.match(source, /alert\.request_disposition !== 'direct'/);
});

test('issued-record and artifact failures are not success-shaped', () => {
  assert.match(source, /throw new Error\(ntvErr\?\.message/);
  assert.match(source, /throw new Error\(infErr\?\.message/);
  assert.match(source, /throw new Error\(htmlUploadErr\?\.message/);
  assert.match(source, /Print authorization receipt was not recorded/);
});

test('organisation authority uses the governed operating-organisation helper', () => {
  assert.match(source, /userSupabase\.rpc\('is_enforcement_operator_for_org'/);
  assert.doesNotMatch(source, /profile\.organization_id !== alert\.organization_id/);
});
