/**
 * bob-perceive-video — evidence-safe video observation for Bob (body-worn/MP4)
 *
 * Purpose:
 *   Let Bob "observe" video without altering the original. It requests frame
 *   sampling + audio transcription from the media/inference service, then returns
 *   normalized observations, a transcript, and provenance. Designed for
 *   body-worn footage and MP4 evidence.
 *
 * Evidence-safe (legal requirement):
 *   - NEVER mutates or re-encodes the source video.
 *   - Preserves and returns provenance: attachment id, storage path, checksum
 *     (if provided/known), org, and any embedded capture metadata passed in.
 *   - Advisory only; no records mutated here.
 *   - Heavy processing is delegated; this function orchestrates + audits.
 *
 * Auth:
 *   Supabase JWT required. Caller must be admin/master/grand_master/admin_officer/officer.
 *
 * Body:
 *   {
 *     "attachment_id": "...",
 *     "frame_interval_seconds": 5,   // sampling cadence (default 5)
 *     "max_frames": 24,              // cap frames analysed
 *     "want_transcript": true,
 *     "want_frame_observations": true,
 *     "question": "optional focus"
 *   }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
// Media processing service (frame sampling + audio extraction/STT). Reuses the
// inference/voice rail. If unset, the function returns a clear capability gap.
const BOB_MEDIA_URL = Deno.env.get('BOB_MEDIA_URL') ?? Deno.env.get('BOB_INFERENCE_URL') ?? '';
const BOB_MEDIA_SECRET = Deno.env.get('BOB_MEDIA_SECRET') ?? Deno.env.get('BOB_INFERENCE_SECRET') ?? '';
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
const DEFAULT_INTERVAL = 5;
const MAX_FRAMES_CAP = 60;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
async function callMedia(action, payload) {
  const res = await fetch(BOB_MEDIA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bob-Secret': BOB_MEDIA_SECRET
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
        error: 'Forbidden: insufficient role for video perception'
      }, 403);
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
    const provenance = {
      attachment_id: att.id,
      file_name: att.file_name,
      storage_path: att.storage_path,
      organization_id: att.organization_id,
      capture_metadata: null
    };
    if (!BOB_MEDIA_URL || !BOB_MEDIA_SECRET) {
      return json({
        success: false,
        capability_gap: 'media_service_not_configured',
        provenance,
        developer_handoff: 'Set BOB_MEDIA_URL/BOB_MEDIA_SECRET (or BOB_INFERENCE_URL/SECRET) and implement video frame sampling + audio STT (sample_video_frames, transcribe_media). Source video must be read-only; never re-encode the original.',
        note: 'Video observation is orchestrated here but requires a media processing service to sample frames and transcribe audio.'
      }, 503);
    }
    const interval = Math.max(1, Math.min(body.frame_interval_seconds ?? DEFAULT_INTERVAL, 60));
    const maxFrames = Math.max(1, Math.min(body.max_frames ?? 24, MAX_FRAMES_CAP));
    const wantTranscript = body.want_transcript !== false;
    const wantFrames = body.want_frame_observations !== false;
    const result = {
      success: true,
      attachment_id: att.id,
      file_name: att.file_name,
      provenance,
      sampling: {
        frame_interval_seconds: interval,
        max_frames: maxFrames
      },
      advisory: true,
      evidence_note: 'Original video is unchanged and read-only. This is advisory analysis only.'
    };
    if (wantFrames) {
      const frames = await callMedia('sample_video_frames', {
        attachment_id: att.id,
        frame_interval_seconds: interval,
        max_frames: maxFrames,
        question: body.question ?? ''
      });
      result.frame_observations = frames.ok ? frames.data.frames ?? frames.data.observations ?? frames.data : {
        error: `frame_sampling_failed_${frames.status}`,
        note: 'Implement sample_video_frames in the media service.'
      };
    }
    if (wantTranscript) {
      const transcript = await callMedia('transcribe_media', {
        attachment_id: att.id
      });
      result.transcript = transcript.ok ? transcript.data.transcript ?? transcript.data.text ?? transcript.data : {
        error: `transcription_failed_${transcript.status}`,
        note: 'Implement transcribe_media (audio track STT) in the media service.'
      };
    }
    result.audit = {
      actor_id: user.id,
      role: profile.role
    };
    return json(result);
  } catch (err) {
    console.error('[bob-perceive-video] error:', err);
    return json({
      error: 'Video perception failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
