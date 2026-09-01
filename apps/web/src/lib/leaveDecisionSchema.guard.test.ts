import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901006000_leave_decision_return.sql'), 'utf8');

describe('leave decision return', () => {
  it('returns the governed decision personally to the requesting officer', () => {
    expect(sql).toContain("p_category=>'leave_decision'");
    expect(sql).toContain('p_recipient_user_id=>v_officer_user_id');
    expect(sql).toContain("'leave_request_id',v_leave.id");
    expect(sql).toContain("'leave_decision:'||v_leave.id::text||':'||v_leave.status");
  });

  it('retains expected-state locking and anonymous denial', () => {
    expect(sql).toContain('v_leave.status<>p_expected_status');
    expect(sql).toContain('from public,anon;');
  });
});