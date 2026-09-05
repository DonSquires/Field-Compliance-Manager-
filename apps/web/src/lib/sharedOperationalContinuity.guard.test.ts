import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20260905002000_shared_operational_continuity.sql'),
  'utf8',
);

describe('shared operational continuity', () => {
  it('requires explicit agreement-location-module policy scope and coverage windows', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.service_agreement_continuity_policies');
    expect(migration).toContain('UNIQUE (service_agreement_location_id, service_agreement_module_id)');
    expect(migration).toContain("continuity_mode IN ('none', 'handoff_only', 'live_read', 'live_read_and_receive')");
    expect(migration).toContain('client_coverage_start time');
    expect(migration).toContain('provider_coverage_start time');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.continuity_party_on_duty');
    expect(migration).toContain("AT TIME ZONE 'Pacific/Auckland'");
  });

  it('projects a safe location event rather than granting cross-tenant source editing', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.operational_continuity_items');
    expect(migration).toContain('source_location_event_id uuid NOT NULL REFERENCES public.location_events');
    expect(migration).toContain('source_organization_id uuid NOT NULL');
    expect(migration).toContain('recipient_organization_id uuid NOT NULL');
    expect(migration).toContain('continuity_item_location_xor');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.publish_location_event_continuity');
    expect(migration).toContain("'No active continuity policy covers this event location and module'");
    expect(migration).toContain("'Provider coverage window is not active'");
    expect(migration).toContain("'Client coverage window is not active'");
    expect(migration).not.toMatch(/update\s+public\.location_events\b/i);
  });

  it('keeps recipient visibility time-bounded and acknowledgements immutable', () => {
    expect(migration).toContain('expires_at >= now()');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.operational_continuity_receipts');
    expect(migration).toContain('UNIQUE (continuity_item_id, recipient_organization_id)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.acknowledge_operational_continuity_item');
    expect(migration).toContain('if found then return v_receipt; end if;');
    expect(migration).not.toMatch(/update\s+public\.operational_continuity_receipts\b/i);
  });

  it('does not expose finance, staff, or unrestricted attachments through the projection contract', () => {
    expect(migration).toContain("share_attachments_mode IN ('none', 'redacted', 'selected_only')");
    expect(migration).not.toMatch(/(payroll|invoice|margin|bank_account|staff_profiles).*operational_continuity_items/i);
  });
});
