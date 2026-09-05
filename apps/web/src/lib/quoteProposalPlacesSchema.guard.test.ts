import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(import.meta.dirname, '../../../../supabase/migrations/20260905006900_quote_proposal_places.sql'), 'utf8');

describe('draft proposal places', () => {
  it('keeps proposed Sites and Zones outside the live operational place tables', () => {
    expect(migration).toContain('CREATE TABLE public.quote_proposal_places');
    expect(migration).toContain("place_kind IN ('site','zone')");
    expect(migration).toContain("resolution IN ('create_new','use_existing')");
    expect(migration).toContain('proposed_geometry jsonb');
  });

  it('requires a draft quote, selected module, and quote-client candidate before capture', () => {
    expect(migration).toContain("v_quote.status<>'draft'");
    expect(migration).toContain('Proposed place requires a selected quote module');
    expect(migration).toContain('Proposed place candidate does not belong to the quote client');
  });

  it('converts only accepted proposals into scoped live places and services', () => {
    expect(migration).toContain("new.status='accepted'");
    expect(migration).toContain('INSERT INTO public.service_agreement_locations');
    expect(migration).toContain('INSERT INTO public.site_services');
    expect(migration).toContain('Proposed Site requires duplicate resolution before acceptance');
    expect(migration).toContain('Proposed Zone requires duplicate resolution before acceptance');
  });
});