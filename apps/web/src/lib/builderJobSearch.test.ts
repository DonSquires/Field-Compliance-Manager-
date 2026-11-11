import { describe, expect, it } from 'vitest';
import { jobMatchesSearch } from './builderJobSearch';

const child = { id: 'f6df4b84-03f1-4ad2-adfb-7d7fd9d32704', title: 'Follow-up: Org setting page, persistant map', status: 'implementation_pending', workspace_branch: 'bob/job-a7c916f5b98047f7ac47', branch_name: 'bob/job-a7c916f5b98047f7ac47', target_sha: '6f570b760ff3bae5140d3a22ba22c4fd4544d67d' };
const root = { id: 'a7c916f5-b980-47f7-ac47-9989b8f19e21', title: 'Org setting page, persistant map', status: 'failed', branch_name: 'main' };

describe('jobMatchesSearch', () => {
  it('finds a job by its persistent human reference, case-insensitively', () => {
    const referenced = { ...root, human_reference: 'BB-123' };
    expect(jobMatchesSearch(referenced, 'bb-123')).toBe(true);
    expect(jobMatchesSearch(referenced, 'BB-124')).toBe(false);
  });

  it('finds a job by short, full and dash-less id', () => {
    expect(jobMatchesSearch(root, 'a7c916f5')).toBe(true);
    expect(jobMatchesSearch(root, 'A7C916F5-B980-47F7-AC47-9989B8F19E21')).toBe(true);
    expect(jobMatchesSearch(root, 'a7c916f5b98047f7ac47')).toBe(true);
    expect(jobMatchesSearch(root, 'bob/job-a7c916f5b98047f7ac47')).toBe(true);
  });

  it('finds the rerun child by its workspace branch suffix', () => {
    expect(jobMatchesSearch(child, 'a7c916f5b98047f7ac47')).toBe(true);
    expect(jobMatchesSearch(child, '6f570b7')).toBe(true);
  });

  it('does not treat a short hex fragment as an id prefix match elsewhere in the id', () => {
    expect(jobMatchesSearch(root, '47f7ac')).toBe(false);
    expect(jobMatchesSearch(root, 'e147a021')).toBe(false);
    expect(jobMatchesSearch(root, 'persistant')).toBe(true);
  });
});
