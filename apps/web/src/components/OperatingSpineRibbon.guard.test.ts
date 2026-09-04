import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/OperatingSpineRibbon.tsx'), 'utf8');

describe('operating spine ribbon', () => {
  it('follows the enterprise operating chain without inventing status data', () => {
    for (const label of ['Organisation', 'Agreement', 'Place', 'Staff', 'Roster', 'Dispatch', 'Evidence', 'Finance', 'Reports']) {
      expect(source).toContain(`label: '${label}'`);
    }
    expect(source).toContain("page: 'relationships'");
    expect(source).toContain("page: 'locations'");
    expect(source).toContain("page: 'people-hr'");
    expect(source).toContain("page: 'field-ops'");
    expect(source).not.toContain("from('");
    expect(source).not.toContain('.rpc(');
  });
});
