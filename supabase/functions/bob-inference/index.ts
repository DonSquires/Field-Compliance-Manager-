/**
 * bob-inference — Bob API proxy Edge Function
 *
 * Source of truth: docs/STAGING.md Phase 1
 *
 * ROLE: Thin authenticated proxy between the Conductor and Render apps/api.
 *
 * This Edge Function exists for one reason: to keep the API URL and
 * token server-side. The browser never sees them. The Conductor calls
 * this function with a shared secret (X-Bob-Secret). This function calls
 * Render apps/api Bob routes and returns the reply or extraction result.
 *
 * Input (from Conductor only — not the browser):
 *   Header: X-Bob-Secret: <BOB_INFERENCE_SECRET>
 *   Body:   { system_prompt, message, history }
 *           { action: 'extract_service_agreement', attachment_id }
 *
 * Output:
 *   { reply } or { extraction_payload } on success
 *   { error } on failure
 *
 * Env secrets required:
 *   BOB_INFERENCE_SECRET  — shared secret with Conductor
 *   API_URL               — apps/api base URL (no trailing slash)
 *   API_TOKEN             — apps/api auth token
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
const BOB_INFERENCE_SECRET = Deno.env.get('BOB_INFERENCE_SECRET') ?? '';
const API_URL = Deno.env.get('API_URL') ?? Deno.env.get('RAILWAY_API_URL') ?? '';
const API_TOKEN = Deno.env.get('API_TOKEN') ?? Deno.env.get('RAILWAY_API_TOKEN') ?? '';
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    status: 200
  });
  const json = (body, status = 200)=>new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  try {
    // ── Verify shared secret from Conductor ───────────────────────────────────
    // This endpoint is internal — not called by the browser directly.
    const secret = req.headers.get('X-Bob-Secret') ?? '';
    if (!BOB_INFERENCE_SECRET || secret !== BOB_INFERENCE_SECRET) {
      console.warn('[bob-inference] rejected: invalid or missing X-Bob-Secret');
      return json({
        error: 'Forbidden'
      }, 403);
    }
    const body = await req.json();
    if (!API_URL || !API_TOKEN) {
      console.error('[bob-inference] API_URL or API_TOKEN not configured');
      return json({
        error: 'Inference service not configured'
      }, 503);
    }
    const action = body.action ?? 'chat';
    // v2 contract: pass through request_id for correlation
    const requestId = body.request_id;
    console.log(`[bob-inference] action=${action} has_attachment=${Boolean(body.attachment_id)} has_query=${Boolean(body.query)} has_message=${Boolean(body.message?.trim())} request_id=${requestId ?? 'none'}`);
    const endpoint = action === 'extract_service_agreement' ? '/api/bob/extract/service-agreement' : action === 'extract_credential' ? '/api/bob/extract/credential' : action === 'extract_freedom_camping_bylaw' ? '/api/bob/extract/freedom-camping-bylaw' : action === 'understand_document' ? '/api/bob/document/understand' : action === 'understand_documents_batch' ? '/api/bob/documents/understand-batch' : action === 'retrieve_knowledge' ? '/api/bob/knowledge/retrieve' : action === 'describe_image' ? '/api/bob/vision/describe' : action === 'ocr_image' ? '/api/bob/media/ocr-image' : action === 'transcribe_media' ? '/api/bob/media/transcribe' : action === 'sample_video_frames' ? '/api/bob/media/sample-frames' : action === 'plan_import_mapping' ? '/api/bob/import/plan-mapping' : action === 'plan' ? '/api/bob/plan' : action === 'embed' ? '/api/bob/embed' : '/api/bob/chat';
    if (action === 'chat' && !body.message?.trim()) return json({
      error: 'message is required'
    }, 400);
    if ((action === 'extract_service_agreement' || action === 'extract_credential' || action === 'extract_freedom_camping_bylaw' || action === 'understand_document' || action === 'describe_image' || action === 'ocr_image' || action === 'transcribe_media' || action === 'sample_video_frames') && !body.attachment_id?.trim()) return json({
      error: 'attachment_id is required'
    }, 400);
    if (action === 'retrieve_knowledge' && !body.query?.trim()) return json({
      error: 'query is required'
    }, 400);
    if (action === 'plan_import_mapping' && !Array.isArray(body.headers)) return json({
      error: 'headers is required'
    }, 400);
    if (action === 'plan' && !body.message?.trim() && !body.attachment) return json({
      error: 'message or attachment is required'
    }, 400);
    if (action === 'embed' && !body.text?.trim()) return json({
      error: 'text is required'
    }, 400);
    // ── Call apps/api ─────────────────────────────────────────────────────────
    const callStartMs = Date.now();
    console.log(`[bob-inference] endpoint=${endpoint}`);
    // v2 contract: build the action-specific payload, then inject request_id
    // into ALL payloads for end-to-end correlation (not just plan).
    const actionPayload = action === 'retrieve_knowledge' ? {
      query: body.query,
      limit: body.limit ?? 3
    } : action === 'plan_import_mapping' ? {
      headers: body.headers,
      sample_rows: body.sample_rows ?? [],
      candidate_tables: body.candidate_tables ?? [],
      file_name: body.file_name ?? 'uploaded-file',
      known_aliases: body.known_aliases ?? {}
    } : action === 'plan' ? {
      message: body.message ?? '',
      attachment: body.attachment ?? null,
      tools: body.tools ?? [],
      persona: body.persona,
      platform_context: body.platform_context,
      knowledge: body.knowledge,
      history: body.history ?? [],
      pending: body.pending ?? null,
      task_state: body.task_state ?? undefined,
      memory_context: body.memory_context ?? undefined
    } : action === 'embed' ? {
      text: body.text ?? ''
    } : action === 'ocr_image' || action === 'transcribe_media' || action === 'sample_video_frames' ? {
      ...body
    } : action === 'understand_documents_batch' ? {
      conversation_id: body.conversation_id,
      attachment_ids: body.attachment_ids ?? undefined,
      question: body.question ?? ''
    } : action === 'understand_document' || action === 'describe_image' ? {
      attachment_id: body.attachment_id,
      question: body.question ?? ''
    } : action === 'extract_service_agreement' || action === 'extract_credential' || action === 'extract_freedom_camping_bylaw' ? {
      attachment_id: body.attachment_id
    } : {
      system_prompt: body.system_prompt,
      message: body.message,
      history: body.history ?? []
    };
    // Inject request_id into every forwarded payload for end-to-end correlation.
    if (requestId) {
      actionPayload.request_id = requestId;
    }
    const apiRes = await fetch(`${API_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`
      },
      body: JSON.stringify(actionPayload)
    });
    // P2 FIX: p-latency observability by function version + action.
    // Log wall-clock latency for every call so p95/p99 can be computed from
    // structured logs. Includes the action and build version for slicing.
    const callLatencyMs = Date.now() - callStartMs;
    const BUILD_VERSION = 'bob-inference-v2.1';
    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error(`[bob-inference] API error ${apiRes.status}: ${errText.slice(0, 300)} latency_ms=${callLatencyMs} action=${action} version=${BUILD_VERSION} request_id=${requestId ?? 'none'}`);
      return json({
        error: `API returned ${apiRes.status}`
      }, 502);
    }
    const data = await apiRes.json();
    console.log(`[bob-inference] api_ok=true has_reply=${Boolean(data.reply)} has_cards=${Boolean(data.cards?.length)} has_answer=${Boolean(data.answer)} route_selected=${data.route_selected ?? 'none'} latency_ms=${callLatencyMs} action=${action} version=${BUILD_VERSION} request_id=${requestId ?? 'none'}`);
    if (action === 'retrieve_knowledge') return json({
      cards: data.cards ?? []
    });
    if (action === 'plan_import_mapping') return json(data);
    if (action === 'plan') return json(data);
    if (action === 'embed') return json(data);
    if (action === 'ocr_image' || action === 'transcribe_media' || action === 'sample_video_frames') return json(data);
    if (action === 'describe_image') return json({
      vision: data
    });
    if (action === 'understand_document') return json({
      document_understanding: data
    });
    if (action === 'understand_documents_batch') return json(data);
    if (action === 'extract_service_agreement' || action === 'extract_credential' || action === 'extract_freedom_camping_bylaw') return json(data);
    if (!data.reply) {
      console.error('[bob-inference] API returned no reply:', JSON.stringify(data).slice(0, 200));
      return json({
        error: 'Empty reply from inference service'
      }, 502);
    }
    return json({
      reply: data.reply
    });
  } catch (err) {
    console.error('[bob-inference] unexpected error:', err);
    return json({
      error: 'Internal error in inference proxy'
    }, 500);
  }
});
