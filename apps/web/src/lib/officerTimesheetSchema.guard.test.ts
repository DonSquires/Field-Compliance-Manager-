import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const migration=readFileSync(resolve(process.cwd(),'../../supabase/migrations/20260830126000_submit_officer_timesheet.sql'),'utf8');
describe('officer timesheet submission',()=>{
  it('removes broad writes and retains admin-only table writes',()=>{expect(migration).toContain('drop policy if exists timesheets_update');expect(migration).toContain('timesheets_admin_update');});
  it('derives staff identity and creates submitted records only',()=>{expect(migration).toContain('sp.user_id=v_user_id or sp.id=v_user_id');expect(migration).toContain("'submitted'");});
  it('validates period/hours, prevents overlap, deduplicates, and audits',()=>{expect(migration).toContain('Future timesheet periods cannot be submitted');expect(migration).toContain('daterange');expect(migration).toContain('client_event_id=p_client_event_id');expect(migration).toContain("'timesheet_submitted'");});
});