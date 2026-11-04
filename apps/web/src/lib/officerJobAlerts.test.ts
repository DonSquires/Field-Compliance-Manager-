import { describe, expect, it } from 'vitest';
import { SEEN_JOBS_STORAGE_KEY, markJobsSeen, readSeenJobIds, unseenJobIds } from './officerJobAlerts';

function memoryStore() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, data };
}

describe('officer job alert seen-ids', () => {
  it('alerts only for jobs not already seen on this device', () => {
    const store = memoryStore();
    expect(unseenJobIds(['a', 'b'], store)).toEqual(['a', 'b']);
    markJobsSeen(['a'], store);
    expect(unseenJobIds(['a', 'b'], store)).toEqual(['b']);
    markJobsSeen(['b', 'a'], store);
    expect(unseenJobIds(['a', 'b'], store)).toEqual([]);
    expect(readSeenJobIds(store)).toEqual(['a', 'b']);
  });

  it('survives corrupt storage and caps history', () => {
    const store = memoryStore();
    store.setItem(SEEN_JOBS_STORAGE_KEY, '{not json');
    expect(readSeenJobIds(store)).toEqual([]);
    markJobsSeen(Array.from({ length: 250 }, (_, index) => `job-${index}`), store);
    const seen = readSeenJobIds(store);
    expect(seen).toHaveLength(200);
    expect(seen.at(-1)).toBe('job-249');
  });
});
