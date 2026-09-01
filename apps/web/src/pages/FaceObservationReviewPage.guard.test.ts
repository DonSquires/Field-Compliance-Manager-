import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/FaceObservationReviewPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const fieldOps = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');

describe('FaceObservationReviewPage', () => {
  it('reviews face_observations and person_records through the audited RPCs, not direct table writes', () => {
    expect(source).toContain("supabase.rpc('review_face_observation'");
    expect(source).toContain("supabase.rpc('review_person_record'");
    expect(source).not.toContain("from('face_observations').update(");
    expect(source).not.toContain("from('person_records').update(");
  });

  it('only lists records still awaiting manual review', () => {
    expect(source).toContain("eq('review_state', 'manual_review_required')");
    expect(source).toContain("in('review_state', ['draft', 'manual_review_required'])");
  });
});

describe('Face review admin routing', () => {
  it('is wired as a field-ops sub-area reachable from the operations landing grid', () => {
    expect(shell).toContain("'face-review'");
    expect(shell).toContain("case 'face-review':");
    expect(shell).toContain('<FaceObservationReviewPage />');
    expect(fieldOps).toContain("area: 'face-review'");
  });
});
