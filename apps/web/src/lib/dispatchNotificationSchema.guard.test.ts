import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901004000_personal_dispatch_delivery.sql'), 'utf8');

describe('personal dispatch delivery', () => {
  it('derives the assigned officer from governed resource or shift ownership', () => {
    expect(sql).toContain('dr.assigned_officer_id');
    expect(sql).toContain('s.officer_user_id');
    expect(sql).toContain('p_recipient_user_id=>v_officer');
    expect(sql).toContain("'dispatch_job_id',new.id");
  });

  it('does not broadcast assigned dispatch work to the officer role', () => {
    expect(sql).not.toContain("p_recipient_role=>'officer'");
  });
});