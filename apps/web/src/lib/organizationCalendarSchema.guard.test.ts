import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830134000_organization_calendar_settings.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('organization calendar settings', () => {
  it('stores only governed NZ regional configuration', () => {
    expect(sql).toContain("country_code text not null default 'NZ'");
    expect(sql).toContain("region_code in('AUK','BOP','CAN','CIT','GIS','HKB','MBH','MWT','NSN','NTL','OTA','STL','TAS','TKI','WKO','WGN','WTC')");
  });

  it('authorizes and audits region changes through an RPC', () => {
    expect(sql).toContain('public.is_admin_for_org(p_organization_id)');
    expect(sql).toContain("'organization_calendar_region_set'");
    expect(sql).toContain('on conflict(organization_id) do update');
  });

  it('keeps direct writes server-owned', () => {
    expect(sql).toContain('grant select on public.organization_calendar_settings to authenticated');
    expect(sql).not.toContain('grant insert on public.organization_calendar_settings to authenticated');
    expect(schema).toMatch(/CREATE TABLE (IF NOT EXISTS )?"public"\."organization_calendar_settings"/);
    expect(schema).toMatch(/CREATE (OR REPLACE )?FUNCTION "public"\."set_organization_calendar_region"/);
  });
});