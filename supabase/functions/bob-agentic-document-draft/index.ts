import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function sourceText(record: Record<string, unknown>, fields: string[]) {
  return fields.map((field) => `${field.replaceAll('_', ' ')}: ${String(record[field] ?? '[TO CONFIRM]')}`).join('\n');
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization) return json({ error: 'Unauthorized' }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);

    const body = await request.json().catch(() => ({}));
    const sourceType = String(body.sourceType ?? '').trim().toLowerCase();
    const sourceId = String(body.sourceId ?? '').trim();
    if (!['site', 'cctv', 'breach', 'notice'].includes(sourceType) || !sourceId) return json({ error: 'sourceType and sourceId are required' }, 422);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile, error: profileError } = await admin.from('user_profiles').select('organization_id,role').eq('id', user.id).single();
    if (profileError || !profile?.organization_id) return json({ error: 'Organization context is unavailable' }, 403);
    if (!['grand_master', 'master', 'admin', 'admin_officer'].includes(profile.role)) return json({ error: 'Administrator access is required' }, 403);

    let title = '';
    let documentType = '';
    let heading = '';
    let facts = '';
    let referenceMetadata: Array<Record<string, unknown>> = [];
    if (sourceType === 'site') {
      const { data: geography, error: geographyError } = await caller.rpc('get_crm_operational_geography');
      if (geographyError) return json({ error: `Site context could not be authorised: ${geographyError.message}` }, 403);
      const authorizedSite = ((geography as { sites?: Array<{ id: string }> } | null)?.sites ?? []).find((site) => site.id === sourceId);
      if (!authorizedSite) return json({ error: 'Site context is not available through an active operational relationship' }, 404);
      const { data: site } = await admin.from('client_sites').select('id,organization_id,client_organization_id,name,address,site_type,site_brief,hs_notes,access_instructions').eq('id', authorizedSite.id).maybeSingle();
      if (!site) return json({ error: 'Authorized site context could not be loaded' }, 404);
      title = `Site Safety Plan - ${site.name}`;
      documentType = 'site_safety_plan';
      heading = 'Site safety plan';
      facts = sourceText(site, ['name', 'address', 'site_type', 'site_brief', 'hs_notes', 'access_instructions']);
      referenceMetadata = [{ source_type: 'client_site', source_id: site.id, title: site.name }];
    } else if (sourceType === 'cctv') {
      const { data: evidence } = await admin.from('evidence_items').select('id,organization_id,evidence_kind,storage_path,captured_at,metadata').eq('id', sourceId).eq('organization_id', profile.organization_id).maybeSingle();
      if (!evidence) return json({ error: 'CCTV evidence context not found in your organisation' }, 404);
      title = 'CCTV Incident Report';
      documentType = 'incident_report';
      heading = 'CCTV incident report';
      facts = sourceText({ ...evidence, metadata: JSON.stringify(evidence.metadata ?? {}) }, ['evidence_kind', 'captured_at', 'storage_path', 'metadata']);
      referenceMetadata = [{ source_type: 'evidence_item', source_id: evidence.id, title: 'CCTV evidence' }];
    } else {
      const { data: alert } = await admin.from('breach_alerts').select('id,organization_id,breach_type,created_at,notes,zone_id,action_type,status').eq('id', sourceId).eq('organization_id', profile.organization_id).maybeSingle();
      if (!alert) return json({ error: 'Breach context not found in your organisation' }, 404);
      const notice = sourceType === 'notice';
      title = `${notice ? 'Notice Letter' : 'Breach Incident Report'} - ${alert.breach_type || 'Breach Alert'}`;
      documentType = notice ? 'letter' : 'incident_report';
      heading = notice ? 'Controlled notice letter' : 'Breach incident report';
      facts = sourceText(alert, ['breach_type', 'created_at', 'notes', 'zone_id', 'action_type', 'status']);
      referenceMetadata = [{ source_type: 'breach_alert', source_id: alert.id, title: 'Breach alert' }];
    }

    const authoredText = `${heading}\n\nSource facts\n${facts}\n\nAnalysis and required controls\n[TO CONFIRM]\n\nRecommended next action\n[TO CONFIRM]\n\nHuman review checklist\n- Verify every source fact\n- Resolve all [TO CONFIRM] fields\n- Confirm owner, deadline, and approval boundary`;
    const authoredHtml = authoredText.split('\n').map((line) => line.trim() ? `<p>${escapeHtml(line)}</p>` : '<p></p>').join('');
    const { data: draft, error: draftError } = await caller.rpc('create_bob_document_draft', {
      p_title: title,
      p_document_type: documentType,
      p_authored_html: authoredHtml,
      p_authored_text: authoredText,
      p_reference_handles: referenceMetadata.map((reference) => reference.source_id),
      p_reference_metadata: referenceMetadata,
    });
    if (draftError || !draft?.document_id || !draft?.document_version_id) return json({ error: draftError?.message ?? 'Draft could not be created' }, 500);
    const { data: review, error: reviewError } = await caller.rpc('submit_bob_document_for_review', {
      p_document_id: draft.document_id,
      p_document_version_id: draft.document_version_id,
      p_review_reason: 'Automatically prepared from source context. Human verification is required before approval or output.',
    });
    if (reviewError) return json({ error: reviewError.message, draft }, 500);
    return json({ ok: true, draft: { ...draft, ...review, title, document_type: documentType, authored_html: authoredHtml, authored_text: authoredText, references: referenceMetadata } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Agentic document drafting failed' }, 500);
  }
});
