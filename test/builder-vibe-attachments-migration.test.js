'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261022140000_builder_vibe_attachments.sql'), 'utf8');

test('Vibe attachments are session-bound and readable only by the owner', () => {
  assert.match(migration, /session_id uuid NOT NULL REFERENCES public\.builder_vibe_sessions\(id\) ON DELETE CASCADE/);
  assert.match(migration, /ALTER TABLE public\.builder_vibe_attachments ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON public\.builder_vibe_attachments FROM anon, authenticated/);
  assert.match(migration, /public\.is_grand_master\(\)[\s\S]*s\.created_by = auth\.uid\(\)/);
  assert.doesNotMatch(migration, /GRANT (?:INSERT|UPDATE|DELETE|ALL) ON public\.builder_vibe_attachments TO authenticated/);
});

test('Vibe attachment RPCs bind private storage paths, file bounds, and message IDs', () => {
  assert.match(migration, /desktop\/' \|\| v_user::text \|\| '\/vibe\/' \|\| p_session_id::text/);
  assert.match(migration, /p_file_size_bytes > 20971520/);
  assert.match(migration, /p_file_size_bytes > 10485760/);
  assert.match(migration, /cardinality\(v_ids\) > 5/);
  assert.match(migration, /a\.id = requested\.id AND a\.session_id = p_session_id AND a\.uploaded_by = v_user/);
});
