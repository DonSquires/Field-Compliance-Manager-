const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260919100000_review_timesheet_after_branch_check.sql'), 'utf8');
const page = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/RosterHRPage.tsx'), 'utf8');

test('a branch-checked timesheet can be finally approved or rejected, by someone other than the branch reviewer', () => {
  assert.match(migration, /if v_sheet\.status not in \('submitted', 'branch_checked'\) or p_decision not in \('approved', 'rejected'\) then raise exception 'Unsupported timesheet decision'; end if;/);
  assert.match(migration, /if v_sheet\.status = 'branch_checked' and v_sheet\.branch_reviewed_by = v_actor then raise exception 'Final approval must come from a different reviewer than the branch check'; end if;/);
  // the existing guards stay
  assert.match(migration, /if not public\.is_admin_for_org\(v_sheet\.organization_id\) then raise exception 'Not authorised to review this timesheet'; end if;/);
  assert.match(migration, /v_pay_blocker := public\.timesheet_dispatch_pay_review_blocker\(v_sheet\.id\);/);
  assert.match(migration, /'previous_status', p_expected_status, 'branch_reviewed_by', v_sheet\.branch_reviewed_by/);
});

test('the HR review dialog shows the server\'s answer where the reviewer is looking', () => {
  assert.match(page, /\{error && <p className="hr-review-error" role="alert">\{error\}<\/p>\}<footer><button type="button" className="btn btn-secondary" onClick=\{\(\) => setReview\(null\)\}>Back<\/button>/);
  assert.match(page, /supabase\.rpc\('review_timesheet', \{ p_timesheet_id: review\.id, p_expected_status: currentStatus, p_decision: review\.decision/);
});
