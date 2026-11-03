const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20261104150000_report_redact_identified_persons.sql');
const previous = read('supabase/migrations/20261104130000_report_cctv_card_reviews.sql');

const functionBody = (sql, name) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  return sql.slice(open, sql.indexOf('$function$', open));
};
const builder = functionBody(migration, 'build_agreement_activity_report');

test('report title, comments and action notes pass through the person redaction', () => {
  for (const [key, field] of [['ti', 'title'], ['n', 'note'], ['ac', 'action']]) {
    assert.ok(builder.includes(`'${key}', public.report_redact_identified_persons(n.${field}),`), key);
  }
  const redact = functionBody(migration, 'report_redact_identified_persons');
  assert.match(redact, /'R & M have identified a person relating to this\.'/);
  assert.match(redact, /d\\\.\?\\s\?o\\\.\?\\s\?b/);
  assert.match(redact, /\(\?:image\|footage\|photo\|video\)/);
  assert.match(migration, /function public\.report_redact_identified_persons\(p_text text\)\nreturns text\nlanguage sql\nimmutable/);
});

test('every photo source withholds NZTA screenshots and identity documents', () => {
  const photoRefs = builder.slice(builder.indexOf('photo_refs as materialized'), builder.indexOf('photo_ranked as'));
  assert.doesNotMatch(photoRefs, /nzta/i);
  assert.equal(photoRefs.split(`not public.report_photo_name_withheld(i.metadata ->> 'original_name')`).length - 1, 4);
  assert.ok(photoRefs.includes('not public.report_photo_name_withheld(s.storage_path)'));
  assert.ok(photoRefs.includes('where not public.report_photo_name_withheld(r.path)'));
  const withheld = functionBody(migration, 'report_photo_name_withheld');
  assert.match(withheld, /nzta/);
  assert.match(withheld, /dl_\?back/);
  assert.match(withheld, /passport/);
});

test('helpers are not exposed to API roles and the builder keeps its grants', () => {
  assert.match(migration, /revoke all on function public\.report_redact_identified_persons\(text\) from public, anon, authenticated;/);
  assert.match(migration, /revoke all on function public\.report_photo_name_withheld\(text\) from public, anon, authenticated;/);
  assert.match(migration, /revoke all on function public\.build_agreement_activity_report\(uuid, timestamptz, timestamptz, integer\) from public, anon, authenticated, service_role;/);
  assert.match(migration, /grant execute on function public\.build_agreement_activity_report\(uuid, timestamptz, timestamptz, integer\) to postgres;/);
});

test('only the redaction and photo guards differ from the previous builder', () => {
  const strip = (text) => text
    .replace(/public\.report_redact_identified_persons\((n\.\w+)\)/g, '$1')
    .replace(/coalesce\(i\.metadata ->> 'original_name', ''\) !~\* '\(\^\|\[\^a-z0-9\]\)nzta\(\[\^a-z0-9\]\|\$\)'/g, 'GUARD_ORIG')
    .replace(/not public\.report_photo_name_withheld\(i\.metadata ->> 'original_name'\)/g, 'GUARD_ORIG')
    .replace(/s\.storage_path !~\* '\(\^\|\[\^a-z0-9\]\)nzta\(\[\^a-z0-9\]\|\$\)'/g, 'GUARD_PATH')
    .replace(/not public\.report_photo_name_withheld\(s\.storage_path\)/g, 'GUARD_PATH')
    .replace(/\n\twhere not public\.report_photo_name_withheld\(r\.path\)/g, '');
  assert.equal(strip(builder), strip(functionBody(previous, 'build_agreement_activity_report')));
});
