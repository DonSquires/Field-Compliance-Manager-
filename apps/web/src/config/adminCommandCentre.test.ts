import { describe, expect, it } from 'vitest';
import { ADMIN_COMMAND_CENTRE_GROUPS } from './adminCommandCentre';

describe('admin command centre registry', () => {
  it('keeps investigation discovery and review visible to operational roles', () => {
    const evidence = ADMIN_COMMAND_CENTRE_GROUPS.find((group) => group.key === 'evidence');

    expect(evidence).toBeDefined();
    expect(evidence?.allowedRoles).toEqual(expect.arrayContaining(['admin', 'master', 'grand_master', 'officer']));
    expect(evidence?.links).toEqual(expect.arrayContaining([
      ['Observation Search', 'observation-search'],
      ['Investigation Review', 'investigations'],
    ]));
    expect(evidence?.open).toBe('investigations');
  });

  it('does not duplicate shortcut labels within a domain', () => {
    for (const group of ADMIN_COMMAND_CENTRE_GROUPS) {
      const labels = group.links.map(([label]) => label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});
