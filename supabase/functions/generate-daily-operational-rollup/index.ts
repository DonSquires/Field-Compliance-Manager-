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

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization) return json({ error: 'Unauthorized' }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile, error: profileError } = await admin.from('user_profiles').select('organization_id,role').eq('id', user.id).single();
    if (profileError || !profile?.organization_id) return json({ error: 'Organization context is unavailable' }, 403);
    if (!['grand_master', 'master', 'admin', 'admin_officer'].includes(profile.role)) return json({ error: 'Administrator access is required' }, 403);

    const orgId = profile.organization_id;
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const dateStr = now.toISOString().slice(0, 10);

    const [breachRes, obsRes, dispatchRes, fieldReportRes, shiftRes] = await Promise.all([
      admin.from('breach_alerts').select('id,breach_type,status,plate_number,created_at').eq('organization_id', orgId).gte('created_at', since),
      admin.from('observations').select('id,is_compliant,plate_number,observed_at').eq('organization_id', orgId).gte('observed_at', since),
      admin.from('dispatch_jobs').select('id,job_type,priority,status,created_at').eq('organization_id', orgId).gte('created_at', since),
      admin.from('officer_field_reports').select('id,report_type,severity,title,follow_up_required').eq('organization_id', orgId).gte('reported_at', since),
      admin.from('shifts').select('id,service_type,status').eq('organization_id', orgId).gte('scheduled_start', since),
    ]);

    const breaches = breachRes.data ?? [];
    const observations = obsRes.data ?? [];
    const dispatches = dispatchRes.data ?? [];
    const fieldReports = fieldReportRes.data ?? [];
    const shifts = shiftRes.data ?? [];

    const nonCompliantObs = observations.filter((o) => o.is_compliant === false).length;
    const completedDispatch = dispatches.filter((d) => d.status === 'completed').length;
    const followUpReports = fieldReports.filter((r) => r.follow_up_required).length;

    const title = `Daily Operational Rollup - ${dateStr}`;
    const heading = `Daily Operational Rollup - ${dateStr}`;

    const textLines = [
      heading,
      '',
      'Executive Summary',
      `Operational rollup for period ending ${now.toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}. Summarizes field patrols, compliance observations, dispatch jobs, and officer field reports recorded in the last 24 hours.`,
      '',
      '24-Hour Operational Metrics',
      `- Shifts scheduled / active: ${shifts.length}`,
      `- Total vehicle / field observations: ${observations.length} (${nonCompliantObs} non-compliant)`,
      `- Compliance breach alerts created: ${breaches.length}`,
      `- Dispatch jobs handled: ${dispatches.length} (${completedDispatch} completed)`,
      `- Officer field reports submitted: ${fieldReports.length} (${followUpReports} requiring follow-up)`,
      '',
      'Compliance & Enforcement Highlights',
      breaches.length > 0
        ? breaches.slice(0, 5).map((b) => `- Plate ${b.plate_number}: ${b.breach_type.replaceAll('_', ' ')} (${b.status})`).join('\n')
        : '- No breach alerts recorded in the last 24 hours.',
      '',
      'Dispatch & Field Activity',
      dispatches.length > 0
        ? dispatches.slice(0, 5).map((d) => `- ${d.job_type.replaceAll('_', ' ')} [${d.priority}]: status ${d.status}`).join('\n')
        : '- No dispatch jobs recorded in the last 24 hours.',
      '',
      'Field Concerns & Maintenance',
      fieldReports.length > 0
        ? fieldReports.slice(0, 5).map((r) => `- [${r.severity.toUpperCase()}] ${r.title} (${r.report_type})${r.follow_up_required ? ' [FOLLOW-UP REQUIRED]' : ''}`).join('\n')
        : '- No officer field reports recorded in the last 24 hours.',
      '',
      'Human Review & Follow-up Checklist',
      `- [TO CONFIRM] Shift coverage and roster completion verified for ${dateStr}`,
      `- [TO CONFIRM] High-priority breach alerts and enforcement actions reviewed`,
      `- [TO CONFIRM] Open dispatch jobs and pending field report follow-ups assigned to owners`,
      `- [TO CONFIRM] Approved by operational supervisor before distribution`,
    ];

    const authoredText = textLines.join('\n');
    const authoredHtml = textLines.map((line) => line.trim() ? `<p>${escapeHtml(line)}</p>` : '<p></p>').join('');

    const { data: draft, error: draftError } = await caller.rpc('create_bob_document_draft', {
      p_title: title,
      p_document_type: 'report',
      p_authored_html: authoredHtml,
      p_authored_text: authoredText,
      p_reference_handles: [],
      p_reference_metadata: [],
    });

    if (draftError || !draft?.document_id || !draft?.document_version_id) {
      return json({ error: draftError?.message ?? 'Daily rollup draft could not be created' }, 500);
    }

    const { data: review, error: reviewError } = await caller.rpc('submit_bob_document_for_review', {
      p_document_id: draft.document_id,
      p_document_version_id: draft.document_version_id,
      p_review_reason: `Automated 24-hour operational rollup generated for ${dateStr}. Human verification required before distribution.`,
    });

    if (reviewError) {
      return json({ error: reviewError.message, draft }, 500);
    }

    return json({
      ok: true,
      draft: {
        ...draft,
        ...review,
        title,
        document_type: 'report',
        summary: {
          shifts: shifts.length,
          observations: observations.length,
          breaches: breaches.length,
          dispatches: dispatches.length,
          fieldReports: fieldReports.length,
        },
      },
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Daily operational rollup generation failed' }, 500);
  }
});
