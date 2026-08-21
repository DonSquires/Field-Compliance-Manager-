/**
 * send-report-pack — email a generated monthly report pack via SMTP
 *
 * POST /functions/v1/send-report-pack
 * Body: { pack_id, to }  (to optional — falls back to the pack's client billing contact)
 *
 * Auth: valid JWT from an admin/master/grand_master user in the pack's org.
 *
 * Sends a plain summary email of the pack via the configured SMTP, then
 * updates monthly_report_packs delivery log (status='sent', sent_at, sent_to)
 * or records delivery_error on failure.
 *
 * Required edge-function secrets (set in Supabase → Edge Functions → Secrets):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 * If any are missing the function returns a clear 'SMTP not configured'
 * error and writes delivery_error — it never silently succeeds.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SMTP_HOST = Deno.env.get('SMTP_HOST') ?? '';
const SMTP_PORT = Number(Deno.env.get('SMTP_PORT') ?? '587');
const SMTP_USER = Deno.env.get('SMTP_USER') ?? '';
const SMTP_PASS = Deno.env.get('SMTP_PASS') ?? '';
const SMTP_FROM = Deno.env.get('SMTP_FROM') ?? SMTP_USER;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_SEND = [
  'grand_master',
  'master',
  'admin'
];
function summaryHtml(pack) {
  const d = pack.data ?? {};
  const fac = d.facilities ?? [];
  const facRows = fac.map((f)=>{
    const pct = f.expected > 0 ? Math.round(f.completed / f.expected * 100) : 0;
    return `<tr><td>${f.siteName}</td><td align="right">${f.expected}</td><td align="right">${f.completed}</td><td align="right">${pct}%</td></tr>`;
  }).join('');
  return `
    <h2>Monthly Report Pack</h2>
    <p>Period: ${pack.period_start} to ${pack.period_end}</p>
    <h3>SLA Performance</h3>
    <p>${d.slaMet ?? 0} met · ${d.slaBreached ?? 0} breached · ${d.slaRunning ?? 0} running</p>
    <h3>Incidents</h3>
    <p>${d.incidentsTotal ?? 0} total</p>
    <h3>Patrol &amp; Compliance</h3>
    <p>Checkpoint visits: ${d.checkpointVisits ?? 0} · Breach alerts: ${d.breachAlerts ?? 0}</p>
    ${fac.length ? `<h3>Patrol Completion by Facility</h3>
    <table border="1" cellpadding="4" cellspacing="0">
      <tr><th align="left">Facility</th><th>Expected</th><th>Completed</th><th>Completion</th></tr>
      ${facRows}
    </table>` : ''}
  `;
}
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
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
    if (authError || !caller) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await admin.from('user_profiles').select('role, organization_id').eq('id', caller.id).single();
    if (!callerProfile || !CAN_SEND.includes(callerProfile.role)) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    if (!body.pack_id) return json({
      error: 'pack_id is required'
    }, 400);
    // Load the pack and verify org.
    const { data: pack } = await admin.from('monthly_report_packs').select('id, organization_id, service_agreement_id, period_start, period_end, data').eq('id', body.pack_id).single();
    if (!pack) return json({
      error: 'Pack not found'
    }, 404);
    if (callerProfile.role !== 'grand_master' && pack.organization_id !== callerProfile.organization_id) {
      return json({
        error: 'Cannot send packs for other organizations'
      }, 403);
    }
    // Resolve recipient: explicit `to`, else the agreement's client billing contact.
    let recipient = body.to ?? '';
    if (!recipient) {
      const { data: ag } = await admin.from('service_agreements').select('client_organization_id').eq('id', pack.service_agreement_id).single();
      if (ag?.client_organization_id) {
        const { data: contact } = await admin.from('crm_contacts').select('email').eq('organization_id', ag.client_organization_id).eq('is_primary', true).not('email', 'is', null).maybeSingle();
        recipient = contact?.email ?? '';
      }
    }
    if (!recipient) return json({
      error: 'No recipient email (pass `to` or set a primary client contact email)'
    }, 400);
    // Guard: SMTP must be configured.
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      const msg = 'SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM secrets)';
      await admin.from('monthly_report_packs').update({
        delivery_error: msg,
        updated_at: new Date().toISOString()
      }).eq('id', pack.id);
      return json({
        error: msg
      }, 503);
    }
    // Send via SMTP.
    try {
      const client = new SMTPClient({
        connection: {
          hostname: SMTP_HOST,
          port: SMTP_PORT,
          tls: SMTP_PORT === 465,
          auth: {
            username: SMTP_USER,
            password: SMTP_PASS
          }
        }
      });
      await client.send({
        from: SMTP_FROM,
        to: recipient,
        subject: `Monthly Report Pack — ${pack.period_start} to ${pack.period_end}`,
        html: summaryHtml(pack)
      });
      await client.close();
    } catch (sendErr) {
      const msg = sendErr instanceof Error ? sendErr.message : 'SMTP send failed';
      await admin.from('monthly_report_packs').update({
        status: 'failed',
        delivery_error: msg,
        updated_at: new Date().toISOString()
      }).eq('id', pack.id);
      return json({
        error: 'Send failed',
        details: msg
      }, 502);
    }
    // Record delivery.
    await admin.from('monthly_report_packs').update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      sent_to: recipient,
      delivery_error: null,
      updated_at: new Date().toISOString()
    }).eq('id', pack.id);
    return json({
      success: true,
      sent_to: recipient
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
