/**
 * check-services-health — Service health aggregator
 *
 * Returns health status for all platform services:
 *   - Supabase database
 *   - Bob inference (RunPod)
 *   - PTT server
 *
 * Used by the System Diagnostics page.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const INFERENCE_SERVICE_URL = Deno.env.get('INFERENCE_SERVICE_URL') ?? '';
const INFERENCE_API_KEY = Deno.env.get('INFERENCE_API_KEY') ?? '';
const PTT_SERVER_URL = Deno.env.get('PTT_SERVER_URL') ?? '';
const BOB_CONTROL_PLANE_URL = Deno.env.get('BOB_CONTROL_PLANE_URL') ?? '';
const BOB_CONTROL_PLANE_TOKEN = Deno.env.get('BOB_ADMIN_TOKEN') ?? '';
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const results = {};
  // Check Bob/RunPod inference
  if (INFERENCE_SERVICE_URL && INFERENCE_API_KEY) {
    try {
      const baseUrl = INFERENCE_SERVICE_URL.replace(/\/(run|runsync)$/, '');
      const res = await fetch(`${baseUrl}/runsync`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${INFERENCE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          input: {
            action: 'ping'
          }
        }),
        signal: AbortSignal.timeout(10000)
      });
      results.inference = {
        status: res.ok ? 'online' : 'degraded',
        httpStatus: res.status
      };
    } catch  {
      results.inference = {
        status: 'offline'
      };
    }
  } else {
    results.inference = {
      status: 'not_configured'
    };
  }
  // Check PTT server
  if (PTT_SERVER_URL) {
    try {
      const res = await fetch(`${PTT_SERVER_URL}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      results.ptt = {
        status: res.ok ? 'online' : 'degraded',
        httpStatus: res.status
      };
    } catch  {
      results.ptt = {
        status: 'offline'
      };
    }
  } else {
    results.ptt = {
      status: 'not_configured'
    };
  }
  if (BOB_CONTROL_PLANE_URL && BOB_CONTROL_PLANE_TOKEN) {
    try {
      const res = await fetch(`${BOB_CONTROL_PLANE_URL.replace(/\/+$/, '')}/system`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${BOB_CONTROL_PLANE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
      const data = await res.json().catch(() => ({}));
      const builderReady = Boolean(data?.builderRuntime?.ready);
      results.bob_control_plane = {
        status: res.ok && builderReady ? 'online' : res.ok ? 'degraded' : 'offline',
        httpStatus: res.status,
        service: data?.service || 'bob-control-plane',
        builderReady,
        selfHostedProfiles: data?.selfHosted?.defaultProfiles ?? []
      };
    } catch {
      results.bob_control_plane = {
        status: 'offline'
      };
    }
  } else {
    results.bob_control_plane = {
      status: 'not_configured'
    };
  }
  results.supabase = {
    status: 'online'
  };
  results.checkedAt = new Date().toISOString();
  return new Response(JSON.stringify(results), {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
});
