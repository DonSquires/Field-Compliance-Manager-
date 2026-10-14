import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OperationalContinuityPage.tsx'), 'utf8');
const access = readFileSync(resolve(process.cwd(), 'src/lib/fieldOpsAreaAccess.ts'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');
const hardening = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261014183450_harden_operational_continuity_acknowledgement.sql'),
  'utf8',
);

describe('operational continuity workspace', () => {
  it('is a shared Field Operations area rather than a module-specific branch', () => {
    expect(access).toContain("'operational-continuity'");
    expect(access).not.toMatch(/'operational-continuity':\s*\{\s*anyOf:/);
  });

  it('loads the time-bounded incoming queue, immutable receipts, and recent source events', () => {
    expect(source).toContain("from('operational_continuity_items').select(itemSelect)");
    expect(source).toContain(".eq('operational_status', 'active').gte('expires_at', now)");
    expect(source).toContain('source_location_event_id,client_site_id,zone_id,module_key');
    expect(source).toContain("from('operational_continuity_receipts').select(");
    expect(source).toContain("from('location_events').select(");
  });

  it('publishes only a safe projection with a replay-stable request id', () => {
    expect(source).toContain("supabase.rpc('publish_location_event_continuity'");
    expect(source).toContain('p_client_request_id: publishRequestId');
    expect(source).toContain('p_safe_summary: publishForm.safeSummary.trim()');
    expect(source).toContain('The client request ID is retained across retries.');
    expect(source).not.toMatch(/from\('operational_continuity_items'\)[\s\S]{0,300}\.(insert|update|upsert)\(/);
  });

  it('acknowledges through the hardened authority and filters continuation choices by exact place and module', () => {
    expect(source).toContain("supabase.rpc('acknowledge_operational_continuity_item'");
    expect(source).toContain('event.moduleKey === selectedItem.moduleKey');
    expect(source).toContain('event.clientSiteId === selectedItem.clientSiteId');
    expect(source).toContain('event.zoneId === selectedItem.zoneId');
    expect(source).not.toMatch(/from\('operational_continuity_receipts'\)[\s\S]{0,300}\.(insert|update|upsert)\(/);
  });
});

describe('continuity acknowledgement authority', () => {
  it('rejects inactive or expired handoffs before writing a receipt', () => {
    for (const definition of [hardening, schema]) {
      expect(definition).toContain("v_item.operational_status <> 'active'");
      expect(definition).toContain('v_item.expires_at < clock_timestamp()');
      expect(definition).toContain("'Continuity item is no longer active'");
    }
  });

  it('requires a continuation event owned by the recipient at the same place and module', () => {
    for (const definition of [hardening, schema]) {
      expect(definition).toContain('continuation.organization_id = v_item.recipient_organization_id');
      expect(definition).toContain('continuation.module_key IS NOT DISTINCT FROM v_item.module_key');
      expect(definition).toContain('continuation.client_site_id = v_item.client_site_id');
      expect(definition).toContain('continuation.zone_id = v_item.zone_id');
      expect(definition).toContain('continuation.occurred_at >= v_item.source_occurred_at');
    }
  });
});
