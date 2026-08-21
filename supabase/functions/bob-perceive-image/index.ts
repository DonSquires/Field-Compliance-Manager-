/**
 * bob-perceive-image — unified image perception (OCR + vision) for Bob
 *
 * Purpose:
 *   Give Bob one call to "observe" an image: extract text (OCR) and a vision
 *   description/observations, with provenance. Wraps the existing inference
 *   service (bob-inference) actions rather than duplicating model logic.
 *
 * Evidence-safe: never mutates the source image; advisory only.
 *
 * Auth:
 *   Supabase JWT required. Caller must be admin/master/grand_master/admin_officer/officer.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const BOB_INFERENCE_URL = Deno.env.get('BOB_INFERENCE_URL') ?? '';
const BOB_INFERENCE_SECRET = Deno.env.get('BOB_INFERENCE_SECRET') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_PERCEIVE = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer',
  'officer'
]);
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
async function callInference(action, payload) {
  const res = await fetch(BOB_INFERENCE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bob-Secret': BOB_INFERENCE_SECRET
    },
    body: JSON.stringify({
      action,
      ...payload
    })
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch  {
    data = {
      raw: text.slice(0, 500)
    };
  }
  return {
    ok: res.ok,
    status: res.status,
    data
  };
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, role').eq('id', user.id).single();
    if (!profile || !CAN_PERCEIVE.has(String(profile.role))) {
      return json({
        error: 'Forbidden: insufficient role for image perception'
      }, 403);
    }
    if (!BOB_INFERENCE_URL || !BOB_INFERENCE_SECRET) {
      return json({
        error: 'inference_not_configured',
        message: 'BOB_INFERENCE_URL/SECRET are not set.'
      }, 503);
    }
    const body = await req.json();
    const attachmentId = String(body.attachment_id ?? '').trim();
    if (!attachmentId) return json({
      error: 'attachment_id is required'
    }, 400);
    const { data: att } = await admin.from('bob_attachments').select('id, organization_id, file_name, purpose, storage_path').eq('id', attachmentId).maybeSingle();
    if (!att) return json({
      error: 'Attachment not found'
    }, 404);
    const wantOcr = body.want_ocr !== false;
    const wantVision = body.want_vision !== false;
    const result = {
      success: true,
      attachment_id: att.id,
      file_name: att.file_name,
      provenance: {
        storage_path: att.storage_path,
        organization_id: att.organization_id
      },
      advisory: true
    };
    if (wantVision) {
      const vision = await callInference('describe_image', {
        attachment_id: att.id,
        question: body.question ?? ''
      });
      result.vision = vision.ok ? vision.data.vision ?? vision.data : {
        error: `vision_failed_${vision.status}`
      };
    }
    if (wantOcr) {
      const ocr = await callInference('ocr_image', {
        attachment_id: att.id
      });
      result.ocr = ocr.ok ? ocr.data.ocr ?? ocr.data.text ?? ocr.data : {
        error: `ocr_failed_${ocr.status}`,
        note: 'If OCR action is unavailable in inference, add ocr_image support server-side.'
      };
    }
    result.note = 'Advisory perception only. Original image is unchanged. Verify text/observations before acting.';
    result.audit = {
      actor_id: user.id,
      role: profile.role
    };
    return json(result);
  } catch (err) {
    console.error('[bob-perceive-image] error:', err);
    return json({
      error: 'Image perception failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
