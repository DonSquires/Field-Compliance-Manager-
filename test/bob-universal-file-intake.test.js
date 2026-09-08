const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const panel = fs.readFileSync(path.join(root, 'apps/web/src/components/BobPanel.tsx'), 'utf8');
const desktop = fs.readFileSync(path.join(root, 'apps/sd-card-bridge/src/main.tsx'), 'utf8');
const registrar = fs.readFileSync(path.join(root, 'supabase/functions/register-desktop-video-import/index.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260908004000_raise_bob_universal_file_intake_limit.sql'), 'utf8');

test('Bob accepts arbitrary file types through private resumable storage up to 128 GiB', () => {
  assert.match(panel, /const MAX_BOB_UPLOAD_BYTES = 128 \* 1024 \* 1024 \* 1024/);
  assert.doesNotMatch(panel, /ACCEPTED_BOB_UPLOADS/);
  assert.match(panel, /new Upload\(pending\.file/);
  assert.match(desktop, /const MAX_BOB_UPLOAD_BYTES = 128 \* 1024 \* 1024 \* 1024/);
  assert.match(desktop, /new TusUpload\(video/);
  assert.match(desktop, /Upload evidence or partition image/);
  assert.match(registrar, /const MAX_ATTACHMENT_BYTES = 128 \* 1024 \* 1024 \* 1024/);
  assert.match(registrar, /purpose: fileType\.startsWith\('video\/'\) \? 'video_intake' : 'document_intake'/);
  assert.match(migration, /file_size_limit = 137438953472/);
  assert.match(migration, /allowed_mime_types = null/);
});
