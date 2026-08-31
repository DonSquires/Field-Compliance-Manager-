/// <reference types="node" />
import { readFileSync } from 'node:fs';import { resolve } from 'node:path';import { describe,expect,it } from 'vitest';
const sql=readFileSync(resolve(process.cwd(),'../../supabase/migrations/20260831094000_govern_operational_place_management.sql'),'utf8');
describe('governed operational place management',()=>{
  it('authorizes provider-owned and accepted-agreement locations',()=>{expect(sql).toContain('crm_actor_can_manage_location');expect(sql).toContain("sa.invitation_status='accepted'");expect(sql).toContain("sal.status='active'");});
  it('locks and version-checks site, zone, and boundary changes',()=>{expect(sql.match(/for update/g)?.length).toBeGreaterThanOrEqual(4);expect(sql).toContain('Site configuration changed since it was opened');expect(sql).toContain('Zone configuration changed since it was opened');});
  it('records boundary history and audits every command',()=>{expect(sql).toContain('geofence_boundary_history');for(const action of ['crm_site_profile_updated',"'crm_zone_'||p_action",'crm_place_boundary_uploaded',"'crm_zone_closure_'||p_action"])expect(sql).toContain(action);});
  it('validates zone and closure vocabularies with lift provenance',()=>{expect(sql).toContain('Unsupported zone type');expect(sql).toContain('Unsupported zone rule');expect(sql).toContain('Unsupported closure type');expect(sql).toContain('lifted_by=v_actor');expect(sql).toContain('lifted_at=clock_timestamp()');});
  it('exposes commands but no direct table mutation to authenticated users',()=>{expect(sql).toContain('revoke all on function public.crm_actor_can_manage_location');expect(sql).toContain('grant execute on function public.manage_crm_site_profile');expect(sql).not.toMatch(/grant (insert|update|delete).*authenticated/);});
});