/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260831091000_crm_activation_handoffs.sql'), 'utf8');

describe('CRM activation handoff workflow', () => {
  it('creates one handoff per activated onboarding ledger and seeds canonical tasks', () => {
    expect(sql).toContain('onboarding_ledger_id uuid not null unique');
    expect(sql).toContain("new.status='activated'");
    for (const task of ['site_briefing', 'first_roster_action', 'reporting_handoff']) expect(sql).toContain(`'${task}'`);
  });

  it('keeps handoff writes behind governed RPCs', () => {
    expect(sql).toContain('revoke all on table public.crm_activation_handoffs,public.crm_activation_handoff_tasks from public,anon,authenticated');
    expect(sql).toContain('manage_crm_activation_handoff_task');
    expect(sql).toContain('v_handoff.version<>p_expected_version');
    expect(sql).toContain('Activation handoff changed since it was opened');
  });

  it('reads site briefing and operational evidence from canonical records', () => {
    for (const evidence of ['s.access_instructions', 's.hs_notes', 'public.roster_work_units', 'public.roster_slots']) expect(sql).toContain(evidence);
    expect(sql).toContain("rs.status in('published','accepted','completed')");
  });

  it('refuses unsupported roster completion and audits every transition', () => {
    expect(sql).toContain('Publish the first post-activation roster action before completing this task');
    expect(sql).toContain("'crm_activation_handoff_task_'||case when p_complete then 'completed' else 'reopened' end");
    expect(sql).toContain("status=case when v_all_complete then 'completed' else 'open' end");
  });
});