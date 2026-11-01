/**
 * check-services-health — Service health aggregator
 *
 * Returns health status for all platform services:
 *   - Supabase database
 *   - CCTV/identity inference (the fcm-inference service: laptop GPU or VPS CPU, GET /health)
 *   - PTT server
 *
 * RunPod is not part of the stack (owner ruling 2026-11-01, docs/CCTV_INFERENCE_TIER.md): an
 * INFERENCE_SERVICE_URL that still names RunPod is reported as a retired provider and never called.
 *
 * Used by the System Diagnostics page, which reads the `services` list.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const INFERENCE_SERVICE_URL = Deno.env.get('INFERENCE_SERVICE_URL') ?? '';
const INFERENCE_API_KEY = Deno.env.get('INFERENCE_API_KEY') ?? '';
const PTT_SERVER_URL = Deno.env.get('PTT_SERVER_URL') ?? '';
const RETIRED_INFERENCE_HOST = /(^|\.)runpod\.(ai|io)$/i;
interface ServiceHealth {
  status: string;
  httpStatus?: number;
  detail?: string;
  cuda?: boolean;
}
type InferenceTarget = {
  url: string;
} | {
  retired: true;
} | {
  invalid: true;
};
function inferenceHealthUrl(configured: string): InferenceTarget {
  try {
    const url = new URL(configured);
    if (RETIRED_INFERENCE_HOST.test(url.hostname)) return { retired: true };
    url.pathname = `${url.pathname.replace(/\/(health|infer\/[a-z_]+)?\/*$/, '')}/health`;
    url.search = '';
    return { url: url.toString() };
  } catch  {
    return { invalid: true };
  }
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const results: Record<'supabase' | 'inference' | 'ptt', ServiceHealth> = {
    supabase: {
      status: 'online'
    },
    inference: {
      status: 'not_configured'
    },
    ptt: {
      status: 'not_configured'
    }
  };
  // Check the fcm-inference service
  const target = INFERENCE_SERVICE_URL ? inferenceHealthUrl(INFERENCE_SERVICE_URL) : null;
  if (!target) {
    // Reported as not_configured.
  } else if ('retired' in target) {
    results.inference = {
      status: 'retired_provider',
      detail: 'INFERENCE_SERVICE_URL still points at RunPod, which is not part of the stack. Point it at the fcm-inference service.'
    };
  } else if ('invalid' in target) {
    results.inference = {
      status: 'misconfigured',
      detail: 'INFERENCE_SERVICE_URL is not a valid URL.'
    };
  } else {
    try {
      const res = await fetch(target.url, {
        headers: INFERENCE_API_KEY ? {
          'x-inference-api-key': INFERENCE_API_KEY
        } : {},
        signal: AbortSignal.timeout(10000)
      });
      const body = res.ok ? await res.json().catch(()=>null) : null;
      results.inference = {
        status: res.ok && body?.status === 'ok' ? 'online' : 'degraded',
        httpStatus: res.status,
        ...typeof body?.cuda === 'boolean' ? {
          cuda: body.cuda
        } : {}
      };
    } catch  {
      results.inference = {
        status: 'offline'
      };
    }
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
  }
  const services = ([
    'supabase',
    'inference',
    'ptt'
  ] as const).map((service)=>({
      service,
      ...results[service]
    }));
  return new Response(JSON.stringify({
    ...results,
    checkedAt: new Date().toISOString(),
    services
  }), {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
});
