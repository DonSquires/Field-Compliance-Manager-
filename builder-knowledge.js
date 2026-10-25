'use strict';

const crypto = require('node:crypto');

const KNOWLEDGE_CONTRACT = Object.freeze({
  properties: { query: { type: 'string', minLength: 2, maxLength: 1000 }, limit: { type: 'integer', minimum: 1, maximum: 6 } },
  required: ['query'],
});
const COLUMNS = 'id,key,title,content,source,updated_at';
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'what', 'have', 'please', 'should', 'could', 'would', 'your', 'about']);
const termsFor = query => [...new Set(query.toLowerCase().match(/[a-z0-9_]{3,}/g) || [])].filter(term => !STOPWORDS.has(term)).slice(0, 12);

function createKnowledgeTool({ supabase, embed, now = () => new Date().toISOString() }) {
  return async (args = {}) => {
    const { query, limit = 4 } = args;
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 1000
      || !Number.isInteger(limit) || limit < 1 || limit > 6
      || Object.keys(args).some(key => !['query', 'limit'].includes(key))) {
      return { error: 'Use query (2-1000 characters) and optional limit (integer 1-6). Organization scope cannot be supplied.', code: 'INVALID_INPUT' };
    }
    if (!supabase) return { error: 'Canonical knowledge storage is not configured.', code: 'KNOWLEDGE_UNAVAILABLE' };
    const terms = termsFor(query);
    let rows;
    let path = 'keyword';
    let degradation = embed ? null : 'private_embedding_not_configured';
    let scores = new Map();
    if (embed) {
      try {
        const { embedding } = await embed(query.trim());
        if (!Array.isArray(embedding) || embedding.length !== 768 || !embedding.every(Number.isFinite)) throw new Error('invalid embedding');
        const match = await supabase.rpc('bob_match_knowledge', {
          query_embedding: `[${embedding.join(',')}]`, match_count: limit, scope_org_id: null,
        }).abortSignal(AbortSignal.timeout(15_000));
        if (match.error) throw new Error('matching failed');
        const matches = Array.isArray(match.data) ? match.data : [];
        const ids = matches.filter(row => typeof row.id === 'string').map(row => row.id);
        if (ids.length) {
          const result = await supabase.from('bob_knowledge_cards').select(COLUMNS)
            .is('organization_id', null).eq('is_active', true).in('id', ids).limit(limit).abortSignal(AbortSignal.timeout(15_000));
          if (result.error) throw new Error('provenance failed');
          scores = new Map(matches.map(row => [row.id, row.similarity]));
          rows = (result.data || []).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
          path = 'vector';
        } else degradation = 'no_vector_matches';
      } catch {
        degradation = 'private_embedding_or_vector_read_failed';
      }
    }
    if (!rows) {
      if (!terms.length) return { error: 'Use at least one specific keyword of three or more letters for knowledge discovery.', code: 'QUERY_TOO_BROAD', degradation };
      const filters = terms.flatMap(term => ['key', 'title', 'content'].map(field => `${field}.ilike.*${term}*`)).join(',');
      try {
        const result = await supabase.from('bob_knowledge_cards').select(COLUMNS)
          .is('organization_id', null).eq('is_active', true).or(filters).order('key').limit(40).abortSignal(AbortSignal.timeout(15_000));
        if (result.error) throw new Error('knowledge query failed');
        const score = row => terms.reduce((sum, term) => sum + (String(row.title).toLowerCase().includes(term) ? 4 : 0)
          + (String(row.key).toLowerCase().includes(term) ? 3 : 0) + (String(row.content).toLowerCase().includes(term) ? 1 : 0), 0);
        rows = (result.data || []).sort((a, b) => score(b) - score(a) || String(a.key).localeCompare(String(b.key))).slice(0, limit);
      } catch {
        return { error: 'Canonical knowledge retrieval failed; no knowledge is claimed loaded.', code: 'KNOWLEDGE_READ_FAILED', degradation };
      }
    }
    let budget = 8000;
    const cards = rows.map(row => {
      const content = String(row.content || '');
      const excerpt = content.slice(0, Math.min(2500, budget));
      budget -= excerpt.length;
      return {
        id: row.id, key: row.key, title: row.title, source: row.source, updated_at: row.updated_at,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        content: excerpt, truncated: excerpt.length < content.length,
        ...(scores.has(row.id) ? { similarity: scores.get(row.id) } : {}),
      };
    });
    return { cards, retrieval: { path, degradation, scope: 'active_platform_canonical_only', observed_at: now(), candidate_cap: path === 'keyword' ? 40 : limit },
      limitation: 'Canonical guidance, not live evidence. Similarity/keyword matches do not prove relevance; verify source and schema before acting. Experience notes and tenant cards are excluded.' };
  };
}

module.exports = { createKnowledgeTool, KNOWLEDGE_CONTRACT };
