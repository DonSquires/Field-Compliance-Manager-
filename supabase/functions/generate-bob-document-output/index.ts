import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const hex = (bytes: Uint8Array) => Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);
    const body = await req.json().catch(() => ({}));
    const outputId = String(body.output_id ?? '').trim();
    if (!outputId) return json({ error: 'output_id is required' }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
    if (!profile || !['grand_master', 'master', 'admin'].includes(String(profile.role))) return json({ error: 'Administrator approval required' }, 403);
    const { data: output, error: outputError } = await admin.from('bob_generated_document_outputs').select('id,organization_id,document_id,document_version_id,output_format,status').eq('id', outputId).single();
    if (outputError || !output) return json({ error: 'Output request not found' }, 404);
    if (String(profile.role) !== 'grand_master' && output.organization_id !== profile.organization_id) return json({ error: 'Forbidden' }, 403);
    if (output.status !== 'requested') return json({ error: 'Output request is not in requested state' }, 409);
    if (output.output_format !== 'print') return json({ error: 'PDF and DOCX renderers are not enabled yet; request print output.' }, 422);

    const { data: version } = await admin.from('document_versions').select('id,metadata_json,extracted_text').eq('id', output.document_version_id).single();
    if (!version || String(version.metadata_json?.authoring_status ?? '') !== 'approved') return json({ error: 'Only approved document versions can be rendered' }, 422);
    const title = String(version.metadata_json?.title ?? 'FCM document');
    const authoredHtml = String(version.metadata_json?.authoring_html ?? `<p>${String(version.extracted_text ?? '')}</p>`);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/[<>]/g, '')}</title><style>body{font-family:Arial,sans-serif;color:#172b2d;max-width:820px;margin:0 auto;padding:48px;line-height:1.6}header{border-bottom:2px solid #2f7d74;margin-bottom:30px}h1{color:#164b4a}h2{color:#276b65}footer{margin-top:48px;border-top:1px solid #ccd8d4;padding-top:12px;color:#607570;font-size:12px}</style></head><body><header><h1>${title.replace(/[<>]/g, '')}</h1><p>Approved FCM document output · Generated ${new Date().toISOString()}</p></header><main>${authoredHtml}</main><footer>Source and approval metadata remain available in the FCM document record. This output is not legal advice.</footer></body></html>`;
    const bytes = new TextEncoder().encode(html);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = hex(new Uint8Array(digest));
    const storagePath = `org/${output.organization_id}/generated/${output.document_id}/${output.id}.html`;
    const { error: uploadError } = await admin.storage.from('bob-uploads').upload(storagePath, new Blob([bytes], { type: 'text/html' }), { upsert: false, contentType: 'text/html' });
    if (uploadError) throw new Error(uploadError.message);
    const { data: updated, error: updateError } = await admin.from('bob_generated_document_outputs').update({ status: 'ready', storage_bucket: 'bob-uploads', storage_path: storagePath, sha256, generated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', output.id).eq('status', 'requested').select('id,status,output_format,sha256,storage_bucket,storage_path').single();
    if (updateError || !updated) throw new Error(updateError?.message ?? 'Output state could not be updated');
    await admin.from('audit_log').insert({ organization_id: output.organization_id, actor_user_id: user.id, action: 'bob_document_output_generated', target_table: 'bob_generated_document_outputs', target_id: output.id, metadata: { document_id: output.document_id, document_version_id: output.document_version_id, output_format: output.output_format, sha256 } });
    return json({ success: true, output: updated });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Document output generation failed' }, 500);
  }
});
