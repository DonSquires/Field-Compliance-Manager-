import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901018000_review_face_and_person_records.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('review_face_observation / review_person_record schema', () => {
  it('locks the row and authorises only org admins', () => {
    expect(migration).toContain('for update');
    expect(migration).toContain('is_admin_for_org(v_observation.organization_id)');
    expect(migration).toContain('is_admin_for_org(v_record.organization_id)');
    expect(migration).toContain('Not authorised to review this face observation');
    expect(migration).toContain('Not authorised to review this person record');
  });

  it('only accepts verified or rejected as a decision', () => {
    expect(migration).toContain("if p_decision not in ('verified', 'rejected') then");
    expect(migration).toContain('Invalid review decision');
  });

  it('can create a new person_record to link a verified face observation, since person_records has no direct INSERT policy', () => {
    expect(migration).toContain('insert into person_records (organization_id, display_name, review_state)');
    expect(migration).toContain('A person_record_id or a new person display name is required to verify a face observation');
  });

  it('audits every review decision', () => {
    expect(migration).toContain("'face_observation_reviewed'");
    expect(migration).toContain("'person_record_reviewed'");
  });

  it('is granted to authenticated callers and present in the generated schema dump', () => {
    expect(migration).toContain('grant execute on function public.review_face_observation(uuid, text, uuid, text, text) to authenticated, service_role');
    expect(migration).toContain('grant execute on function public.review_person_record(uuid, text, text) to authenticated, service_role');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."review_face_observation"');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."review_person_record"');
  });
});
