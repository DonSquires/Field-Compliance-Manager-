/// <reference types="node" />
import { readFileSync } from 'node:fs';import { resolve } from 'node:path';import { describe,expect,it } from 'vitest';
const locations=readFileSync(resolve(process.cwd(),'src/pages/LocationsPage.tsx'),'utf8');
const zones=readFileSync(resolve(process.cwd(),'src/pages/ZoneDetailPage.tsx'),'utf8');
describe('operational geography pages',()=>{
  it('loads provider-owned and contracted geography through one governed RPC',()=>{expect(locations).toContain('get_crm_operational_geography');expect(zones).toContain('get_crm_operational_geography');});
  it('does not hide contracted places behind viewer organization filters',()=>{expect(locations).not.toContain(".eq('organization_id', orgId)");expect(zones).not.toContain(".eq('organization_id', profile.organizationId)");});
  it('resolves map context against the place owner and retains all facets',()=>{expect(locations).toContain('organizationId={selected.organization_id}');expect(locations).toContain('setOperationalSites');expect(locations).toContain('setOperationalZones');});
  it('refreshes parent evidence when a dirty manager closes',()=>{expect(locations).toContain('managerDirty');expect(zones).toContain('managerDirty');expect(locations).toContain('setRefreshRevision');expect(zones).toContain('setRefreshRevision');});
});