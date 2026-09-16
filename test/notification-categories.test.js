const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The live notifications_category_check once lost the categories that 20260901006000..20260906000004
// added (leave_decision, timesheet_decision, breach_decision, debrief_followup, noise_review,
// video_review), so review_timesheet, review_leave_request, manage_breach_alert,
// manage_debrief_followup and manage_noise_assessment_review failed on their notification insert.
// This pins the snapshot: every category a database producer passes to enqueue_notification must be
// accepted by the constraint that guards the table it writes to.
test('every notification category produced in the schema is accepted by notifications_category_check', () => {
  const schema = fs.readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf8');

  const constraint = schema.match(/ADD CONSTRAINT "notifications_category_check" CHECK \(\(?category = ANY \(ARRAY\[([^\]]+)\]\)\)?\)/);
  assert.ok(constraint, 'notifications_category_check should exist in the snapshot');
  const allowed = new Set([...constraint[1].matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]));

  const produced = new Set();
  for (const match of schema.matchAll(/enqueue_notification\(\s*(?:p_organization_id\s*=>\s*)?[^,]+,\s*(?:p_category\s*=>\s*)?'([a-z_]+)'/g)) {
    produced.add(match[1]);
  }
  assert.ok(produced.size >= 8, `expected the schema to produce several categories, saw ${[...produced].join(', ')}`);

  const missing = [...produced].filter((category) => !allowed.has(category));
  assert.deepEqual(missing, [], `categories produced but rejected by the check: ${missing.join(', ')}`);
});

test('the recorded category list is fully present in the snapshot', () => {
  const schema = fs.readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf8');
  for (const category of ['leave_decision', 'timesheet_decision', 'breach_decision', 'debrief_followup', 'noise_review', 'video_review', 'bob_conversation', 'bob_self_memory']) {
    assert.match(schema, new RegExp(`"notifications_category_check" CHECK \\(\\(?category = ANY \\(ARRAY\\[[^\\]]*'${category}'::text`), category);
  }
});
