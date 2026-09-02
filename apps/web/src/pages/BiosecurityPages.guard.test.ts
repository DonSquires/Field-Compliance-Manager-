/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const officer = readFileSync(resolve(process.cwd(), 'src/pages/OfficerBiosecurityPage.tsx'), 'utf8');
const oversight = readFileSync(resolve(process.cwd(), 'src/pages/BiosecurityOversightPage.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260902000000_canonicalize_biosecurity_assessments.sql'), 'utf8');

describe('canonical biosecurity assessment workflow', () => {
  it('writes operational evidence and both canonical officer links', () => {
    for (const field of ['officer_user_id', 'officer_id', 'officer_name', 'species_name', 'species_confirmed', 'density_estimate', 'action_taken', 'location_name', 'site_id', 'protected_land_address', 'protected_land_site_id', 'notice_number', 'mpi_referral_number', 'follow_up_required', 'notes']) {
      expect(officer).toContain(`${field}:`);
    }
    expect(officer).not.toMatch(/\n\s+action:/);
    expect(officer).not.toMatch(/\n\s+photo_url:/);
  });

  it('reads the operational evidence in officer and oversight views', () => {
    for (const field of ['species_confirmed', 'density_estimate', 'action_taken', 'location_name', 'notice_number', 'mpi_referral_number', 'follow_up_required', 'notes']) {
      expect(officer).toContain(field);
      expect(oversight).toContain(field);
    }
  });

  it('reattaches legacy rows to canonical action and officer fields', () => {
    expect(migration).toContain('set action_taken=action');
    expect(migration).toContain('set officer_user_id=officer_id');
    expect(migration).toContain("action in('no_action','advisory_notice','notice_of_direction','infringement_notice','mpi_referral')");
  });
});