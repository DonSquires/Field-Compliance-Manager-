import React, { useState } from 'react';
import { supabase } from '../lib/supabase';

interface MemoryExcerpt { id: string; content: string; memory_type: string; created_at: string }

export function BuilderMemoryRecall({ disabled, onUse, onError }: {
  disabled: boolean; onUse: (excerpt: string) => void; onError: (message: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [memories, setMemories] = useState<MemoryExcerpt[]>([]);
  const recall = async () => {
    if (disabled || loading) return;
    setLoading(true);
    setLoaded(false);
    setMemories([]);
    try {
      const { data, error } = await supabase.functions.invoke('bob-self-memory-read', {
        body: { search: search.trim(), limit: 5 },
      });
      if (error) throw error;
      if (data?.ok !== true || !Array.isArray(data.memories)) throw new Error('Bob memory recall returned no valid receipt.');
      const entries: MemoryExcerpt[] = [];
      for (const item of data.memories) {
        if (!item || typeof item.id !== 'string' || typeof item.content !== 'string'
          || typeof item.memory_type !== 'string' || typeof item.created_at !== 'string') {
          throw new Error('Bob memory recall returned an invalid entry.');
        }
        entries.push(item);
      }
      setMemories(entries);
      setLoaded(true);
    } catch (error) {
      onError(`Private memory recall failed: ${error instanceof Error ? error.message : 'request failed'}`);
    } finally { setLoading(false); }
  };
  return <details>
    <summary>Recall Bob&apos;s existing memory (private preview)</summary>
    <p>His diary supports lessons and job continuity, not approved knowledge or a growth score. Recalled entries stay private until you review an excerpt in the summary and approve this packet.</p>
    <label>Memory search<input type="text" maxLength={160} value={search} disabled={disabled || loading} onChange={event => setSearch(event.target.value)} /></label>
    <button type="button" disabled={disabled || loading} onClick={() => void recall()}>{loading ? 'Recalling private memories...' : 'Recall private memories'}</button>
    {loading && <p role="status">Reading Bob&apos;s private diary, not sending it to cloud.</p>}
    {loaded && !memories.length && <p role="status">No matching memories. No prior lesson has been assumed.</p>}
    <ul>{memories.map(memory => <li key={memory.id}>
      <article>
        <small>{memory.memory_type} · {memory.created_at}</small>
        <p>{memory.content.slice(0, 2000)}</p>
        {memory.content.length > 2000 && <small>Preview and selectable excerpt limited to the first 2,000 characters; the full memory has not been included.</small>}
        <button type="button" disabled={disabled || loading} onClick={() => onUse(
          `[Bob diary ${memory.id}, ${memory.created_at}; unverified ${memory.memory_type} excerpt]\n${memory.content.slice(0, 2000)}`
        )}>Use excerpt in reviewed summary</button>
      </article>
    </li>)}</ul>
  </details>;
}
