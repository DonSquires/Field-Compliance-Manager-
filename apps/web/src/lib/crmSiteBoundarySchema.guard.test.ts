/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260831081000_govern_crm_site_boundary_review.sql'), 'utf8');
const visualReviewSql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260831088000_crm_boundary_visual_review.sql'), 'utf8');
const historyFixSql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260831089000_fix_boundary_history_ambiguity.sql'), 'utf8');

describe('governed CRM site boundary review', () => {
  it('lists only sites belonging to manageable CRM accounts', () => {
    expect(sql).toContain('get_crm_site_boundary_queue');
    expect(sql).toContain('public.crm_actor_can_manage_account(o.id)');
    expect(sql).toContain("s.boundary_verification='unverified'");
    expect(sql).toContain('(s.boundary is not null)');
  });

  it('locks and expected-state checks every boundary transition', () => {
    expect(sql).toContain('where s.id=p_site_id for update');
    expect(sql).toContain('v_site.boundary_verification is distinct from p_expected_verification');
    expect(sql).toContain('Site boundary changed since it was opened');
  });

  it('requires valid provisional geometry before verification', () => {
    expect(sql).toContain("p_action='set_provisional'");
    expect(sql).toContain('Boundary radius must be between 5 and 5000 metres');
    expect(sql).toContain('A boundary must be established before verification');
    expect(sql).toContain("public.verify_boundary('client_site',v_site.id)");
  });

  it('audits browser actions and closes direct geometry execution', () => {
    expect(sql).toContain("'crm_site_boundary_'||p_action");
    expect(sql).toContain('revoke all on function public.set_site_geometry');
    expect(sql).toContain('grant execute on function public.set_site_geometry');
    expect(sql).toContain('to service_role');
  });

  it('returns current geometry only through the manageable-account queue', () => {
    expect(visualReviewSql).toContain('boundary_geojson jsonb');
    expect(visualReviewSql).toContain('public.st_asgeojson(s.boundary)::jsonb');
    expect(visualReviewSql).toContain('public.crm_actor_can_manage_account(o.id)');
    expect(visualReviewSql).toContain('revoke all on function public.get_crm_site_boundary_queue()');
  });

  it('qualifies entity lookups that share boundary history output names', () => {
    expect(historyFixSql).toContain('public.location_zones z where z.id=p_entity_id');
    expect(historyFixSql).toContain('public.client_sites s where s.id=p_entity_id');
    expect(historyFixSql).not.toMatch(/where id\s*=\s*p_entity_id/);
  });
});