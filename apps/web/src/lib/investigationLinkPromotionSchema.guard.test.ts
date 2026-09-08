import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908102000_document_promotion_proposals.sql'), 'utf8');

describe('investigation link promotion execution boundary', () => {
  it('requires approved proposals, existing investigations, supported entities, and a reason', () => {
    expect(migration).toContain('apply_investigation_link_promotion_proposal');
    expect(migration).toContain("v_proposal.target_type <> 'investigation_link' OR v_proposal.status <> 'approved'");
    expect(migration).toContain('investigations');
    expect(migration).toContain('Investigation link reason is required');
  });

  it('delegates to the canonical investigation link RPC and audits provenance', () => {
    expect(migration).toContain('public.link_investigation_entity');
    expect(migration).toContain('investigation_links');
    expect(migration).toContain('document_version_id');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.apply_investigation_link_promotion_proposal');
  });
});