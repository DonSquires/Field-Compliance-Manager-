'use strict';

// Bob knowledge-card RAG embeddings. Cards and chat queries must share one model and
// one text shape, or cosine similarity is meaningless. The stored 768-dim vectors were
// verified (cosine 1.0000) against nomic-embed-text over `${title}\n\n${content}` with
// no task prefix, so both the query path and the backfill use exactly that.

const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_DIMENSIONS = 768;
const MAX_EMBED_CHARS = 8000;

function embeddingConfig(env = process.env) {
  return {
    ollamaUrl: String(env.OLLAMA_URL || 'http://ollama:11434').replace(/\/+$/, ''),
    model: env.EMBED_MODEL || DEFAULT_MODEL,
    dimensions: Number(env.EMBED_DIMENSIONS || DEFAULT_DIMENSIONS),
    timeoutMs: Number(env.EMBED_TIMEOUT_MS || 60_000),
  };
}

function cardEmbeddingText(card) {
  return `${String(card.title || '').trim()}\n\n${String(card.content || '').trim()}`.slice(0, MAX_EMBED_CHARS);
}

// pgvector columns must be written as the '[a,b,...]' literal; a JS array is silently rejected.
function toVectorLiteral(vector) {
  return `[${vector.map((value) => Number(value)).join(',')}]`;
}

async function embedText(text, { config = embeddingConfig(), fetchImpl = fetch } = {}) {
  const input = String(text || '').trim().slice(0, MAX_EMBED_CHARS);
  if (!input) throw new Error('embed_text_required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${config.ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, input }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(controller.signal.aborted ? 'embed_timeout' : `embed_unreachable: ${error instanceof Error ? error.message : 'fetch_failed'}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`embed_failed_http_${response.status}`);
  const body = await response.json();
  const embedding = Array.isArray(body?.embeddings) ? body.embeddings[0] : body?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== config.dimensions || !embedding.every(Number.isFinite)) {
    throw new Error(`embed_dimension_mismatch: expected ${config.dimensions}, got ${Array.isArray(embedding) ? embedding.length : 'none'}`);
  }
  return { embedding, model: config.model, dimensions: embedding.length };
}

// Embeds the stalest pending cards. Writes are optimistic on updated_at so a card edited
// mid-run is left pending for the next pass, and embedded_at never trails updated_at
// (otherwise a future-dated updated_at would make the card re-embed forever).
async function backfillCardEmbeddings({ supabase, config = embeddingConfig(), fetchImpl = fetch, limit = 25, now = () => new Date() } = {}) {
  if (!supabase) throw new Error('supabase_service_client_unavailable');
  const { data: pending, error } = await supabase.rpc('bob_cards_needing_embedding', { match_limit: limit });
  if (error) throw new Error(`pending_lookup_failed: ${error.message}`);
  const ids = (pending || []).map((card) => card.id);
  const result = { model: config.model, attempted: ids.length, embedded: 0, skipped_changed: 0, failed: [], remaining: null };
  if (ids.length) {
    const { data: rows, error: rowsError } = await supabase.from('bob_knowledge_cards')
      .select('id,title,content,updated_at').in('id', ids);
    if (rowsError) throw new Error(`card_lookup_failed: ${rowsError.message}`);
    for (const card of rows || []) {
      try {
        const { embedding } = await embedText(cardEmbeddingText(card), { config, fetchImpl });
        const current = now();
        const updatedAt = new Date(card.updated_at);
        const embeddedAt = updatedAt > current ? updatedAt : current;
        const { data: written, error: writeError } = await supabase.from('bob_knowledge_cards')
          .update({ embedding: toVectorLiteral(embedding), embedding_model: config.model, embedded_at: embeddedAt.toISOString() })
          .eq('id', card.id).eq('updated_at', card.updated_at)
          .select('id');
        if (writeError) throw new Error(writeError.message);
        if (written && written.length) result.embedded += 1;
        else result.skipped_changed += 1;
      } catch (cardError) {
        result.failed.push({ id: card.id, error: cardError instanceof Error ? cardError.message : 'embed_failed' });
      }
    }
  }
  const { data: remaining, error: countError } = await supabase.rpc('bob_cards_needing_embedding_count');
  if (!countError) result.remaining = Number(remaining);
  return result;
}

function startCardEmbeddingBackfill({ supabase, intervalMs, limit, log = console, ...deps } = {}) {
  if (!supabase || !(intervalMs > 0)) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const outcome = await backfillCardEmbeddings({ supabase, limit, ...deps });
      if (outcome.attempted || outcome.failed.length) log.log(JSON.stringify({ event: 'bob_card_embedding_backfill', ...outcome }));
    } catch (error) {
      log.error(JSON.stringify({ event: 'bob_card_embedding_backfill_failed', message: error instanceof Error ? error.message : String(error) }));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, Math.min(intervalMs, 60_000));
  const timer = setInterval(tick, intervalMs);
  first.unref?.();
  timer.unref?.();
  return { tick, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { embeddingConfig, cardEmbeddingText, toVectorLiteral, embedText, backfillCardEmbeddings, startCardEmbeddingBackfill };
