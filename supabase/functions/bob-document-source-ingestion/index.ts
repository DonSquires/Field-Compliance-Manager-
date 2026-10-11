import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);

  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await caller.auth.getUser();
  if (authError || !user) return json({ error: 'Unauthorized' }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? 'start');
    const { data: profile, error: profileError } = await caller
      .from('user_profiles')
      .select('id,organization_id,role')
      .eq('id', user.id)
      .single();
    if (profileError || !profile?.organization_id) {
      return json({ error: 'An active organization is required' }, 403);
    }
    if (!['grand_master', 'master', 'admin'].includes(String(profile.role))) {
      return json({ error: 'Admin, master, or grandmaster access is required' }, 403);
    }

    const { data: sources, error: sourceError } = await caller
      .from('document_reference_sources')
      .select('id,label')
      .eq('organization_id', profile.organization_id)
      .eq('source_kind', 'local_folder')
      .eq('approval_status', 'approved')
      .eq('is_active', true)
      .order('created_at');
    if (sourceError) return json({ error: sourceError.message }, 400);
    if (!sources?.length) {
      return json({ error: 'No approved local document source is registered for this organization' }, 404);
    }

    const requestedSourceId = String(body.source_id ?? '').trim();
    const source = requestedSourceId
      ? sources.find((candidate) => candidate.id === requestedSourceId)
      : sources.length === 1
        ? sources[0]
        : null;
    if (!source) {
      return json({
        error: requestedSourceId
          ? 'The requested document source is not available'
          : 'Choose an approved document source',
        sources,
      }, 409);
    }

    if (action === 'cancel') {
      let runId = String(body.run_id ?? '').trim();
      if (!runId) {
        const { data: activeRuns, error: activeRunError } = await caller
          .from('document_source_ingestion_runs')
          .select('id')
          .eq('source_id', source.id)
          .in('status', ['queued', 'running', 'cancel_requested'])
          .order('requested_at', { ascending: false })
          .limit(1);
        if (activeRunError) return json({ error: activeRunError.message }, 400);
        runId = activeRuns?.[0]?.id ?? '';
      }
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId)) {
        return json({ error: 'No active document source run is available to cancel' }, 404);
      }
      const { data: run, error } = await caller.rpc('cancel_document_source_ingestion', {
        p_run_id: runId,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ success: true, action, source, run });
    }

    if (action === 'status') {
      const { data: runs, error } = await caller
        .from('document_source_ingestion_runs')
        .select('id,status,phase,discovered_count,hashed_count,duplicate_count,supported_count,partial_count,gap_count,excluded_count,quarantined_count,failed_count,requested_at,started_at,heartbeat_at,completed_at,error_code,error_detail_redacted')
        .eq('source_id', source.id)
        .order('requested_at', { ascending: false })
        .limit(1);
      if (error) return json({ error: error.message }, 400);
      return json({ success: true, action, source, run: runs?.[0] ?? null });
    }

    if (action !== 'start') return json({ error: 'Unsupported action' }, 400);
    const clientRequestId = String(body.client_request_id ?? crypto.randomUUID());
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(clientRequestId)) {
      return json({ error: 'client_request_id must be a UUID' }, 400);
    }
    const { data: run, error } = await caller.rpc('request_document_source_ingestion', {
      p_source_id: source.id,
      p_client_request_id: clientRequestId,
      p_mode: 'inventory',
    });
    if (error) return json({ error: error.message }, 400);
    return json({ success: true, action, source, run });
  } catch (error) {
    console.error('[bob-document-source-ingestion]', error);
    return json({ error: error instanceof Error ? error.message : 'Document source request failed' }, 500);
  }
});
