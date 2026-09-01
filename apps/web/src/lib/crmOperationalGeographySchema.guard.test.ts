/// <reference types="node" />
import { readFileSync } from 'node:fs';import { resolve } from 'node:path';import { describe,expect,it } from 'vitest';
const sql=readFileSync(resolve(process.cwd(),'../../supabase/migrations/20260831093000_crm_operational_geography.sql'),'utf8');
describe('CRM operational geography',()=>{
  it('requires an active CRM administrator',()=>{expect(sql).toContain('not public.is_admin_for_org(v_provider)');expect(sql).toContain('Active CRM administrator required');});
  it('includes only provider-owned or accepted operational agreement places',()=>{expect(sql).toContain("sa.provider_organization_id=v_provider and sa.invitation_status='accepted' and sa.agreement_type='operational'");expect(sql).toContain("sal.status='active'");});
  it('returns canonical locations, sites, and zones with geometry',()=>{for(const entity of ["'locations'","'sites'","'zones'",'st_asgeojson(s.boundary)','st_asgeojson(z.boundary)'])expect(sql).toContain(entity);});
  it('exposes only the governed RPC to authenticated users',()=>{expect(sql).toContain('revoke all on function public.get_crm_operational_geography() from public,anon,authenticated');expect(sql).toContain('grant execute on function public.get_crm_operational_geography() to authenticated,service_role');});
});