const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

test('Git preserves live catalog SQL literal bytes on Linux and Windows line-ending settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-schema-integrity-'));
  const attributes = fs.readFileSync(path.resolve(__dirname, '../.gitattributes'), 'utf8');
  const sql = Buffer.from("CREATE TABLE example (value text CHECK (value !~ '[\r\n]'));\n");
  const git = (args, input) => execFileSync('git', args, { cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '-q']);
    fs.writeFileSync(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
    const raw = git(['hash-object', '--stdin'], sql);
    assert.notEqual(git(['hash-object', '--path=supabase/schema.sql', '--stdin'], sql), raw, 'the old attributes corrupt a literal CRLF');
    fs.writeFileSync(path.join(root, '.gitattributes'), attributes);
    fs.mkdirSync(path.join(root, 'supabase'));
    for (const autocrlf of ['false', 'true']) {
      git(['config', 'core.autocrlf', autocrlf]);
      assert.equal(git(['hash-object', '--path=supabase/schema.sql', '--stdin'], sql), raw);
      const file = path.join(root, 'supabase/schema.sql');
      fs.writeFileSync(file, sql);
      git(['add', 'supabase/schema.sql']);
      const staged = execFileSync('git', ['show', ':supabase/schema.sql'], { cwd: root });
      assert.deepEqual(staged, sql);
      fs.unlinkSync(file);
      git(['checkout-index', '--', 'supabase/schema.sql']);
      assert.deepEqual(fs.readFileSync(file), sql);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
