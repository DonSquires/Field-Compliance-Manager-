import { describe, expect, it } from 'vitest';
import { areaDraftSync, isStaleAreaDraft, type AreaDraftBase } from './areaDraft';

const base = (extra: Partial<AreaDraftBase> = {}): AreaDraftBase => ({ zoneId: 'a', version: 3, dirty: false, ...extra });

describe('area settings draft', () => {
  it('loads from the server when a different area is selected, even over unsaved edits', () => {
    expect(areaDraftSync(base({ dirty: true }), { id: 'b', configuration_version: 1 })).toBe('reset');
    expect(areaDraftSync(base({ zoneId: null }), { id: 'a', configuration_version: 3 })).toBe('reset');
  });

  it('refreshes a clean form when the area changes on the server', () => {
    expect(areaDraftSync(base(), { id: 'a', configuration_version: 4 })).toBe('reset');
  });

  it('keeps an unsaved draft on its original version when the area changes underneath it, so the save conflicts instead of overwriting', () => {
    const draft = base({ dirty: true });
    const latest = { id: 'a', configuration_version: 4 };
    expect(areaDraftSync(draft, latest)).toBe('keep');
    expect(isStaleAreaDraft(draft, latest)).toBe(true);
  });

  it('leaves a draft alone when nothing changed', () => {
    expect(areaDraftSync(base({ dirty: true }), { id: 'a', configuration_version: 3 })).toBe('keep');
    expect(isStaleAreaDraft(base({ dirty: true }), { id: 'a', configuration_version: 3 })).toBe(false);
    expect(isStaleAreaDraft(base({ dirty: true }), { id: 'b', configuration_version: 4 })).toBe(false);
    expect(isStaleAreaDraft(base({ dirty: true }), null)).toBe(false);
  });
});
