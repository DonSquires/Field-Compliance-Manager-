/**
 * submit-dispute — public dispute submission (anonymous, service-role insert)
 *
 * POST /functions/v1/submit-dispute
 * Body: {
 *   notice_number?, dispute_type, plate_number?, notice_date?,
 *   submitter_name, submitter_email?, submitter_phone?,
 *   grounds: string[], statement, scv_number?
 * }
 *
 * The public dispute portal is unauthenticated. Rather than grant anon
 * INSERT on the disputes table (which would let anyone set an arbitrary
 * organization_id), this function runs with the service role and resolves
 * organization_id + notice_id from the entered notice_number via
 * infringement_notices. A dispute is only accepted when that lookup
 * succeeds -- tenant ownership is never guessed or left null.
 *
 * No JWT required (verify_jwt disabled for this function in config).
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  const json = (body, status = 200)=>new Response(JSON.stringify(body), {
      status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  try {
    const b = await req.json();
    if (!b.submitter_name || !b.statement || !b.grounds || b.grounds.length === 0) {
      return json({
        error: 'submitter_name, grounds and statement are required'
      }, 400);
    }
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // Resolve org + notice from the entered notice number (best effort).
    let organizationId = null;
    let noticeId = null;
    if (b.notice_number) {
      const { data: notice } = await admin.from('infringement_notices').select('id, organization_id').eq('notice_number', b.notice_number.trim()).maybeSingle();
      if (notice) {
        noticeId = notice.id;
        organizationId = notice.organization_id;
      }
    }
    if (!organizationId || !noticeId) {
      return json({
        error: 'A valid infringement notice number is required to submit a dispute'
      }, 404);
    }
    const { error: insErr } = await admin.from('disputes').insert({
      organization_id: organizationId,
      notice_id: noticeId,
      notice_number: b.notice_number?.trim() || null,
      dispute_type: b.dispute_type || null,
      plate_number: b.plate_number?.trim().toUpperCase() || null,
      notice_date: b.notice_date || null,
      submitter_name: b.submitter_name.trim(),
      submitter_email: b.submitter_email?.trim() || null,
      submitter_phone: b.submitter_phone?.trim() || null,
      grounds: (b.grounds ?? []).join(' | '),
      statement: b.statement.trim(),
      scv_number: b.scv_number?.trim() || null,
      status: 'received',
      submitted_at: new Date().toISOString()
    });
    if (insErr) {
      console.error('[submit-dispute] insert error:', insErr);
      return json({
        error: 'Could not submit dispute',
        details: insErr.message
      }, 500);
    }
    return json({
      success: true
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
