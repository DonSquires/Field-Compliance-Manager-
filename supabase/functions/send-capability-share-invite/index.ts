/**
 * send-capability-share-invite — create a client capability-share invite and
 * email the accept link, via SMTP.
 *
 * POST /functions/v1/send-capability-share-invite
 * Body: { service_agreement_id, capability: 'reporting' | 'finance', email }
 *
 * Auth: valid JWT from an admin/master/grand_master user who administers the
 * agreement's provider organisation (enforced by invite_client_capability_share).
 *
 * Creates the invite via the existing governed RPC (as the caller, so
 * is_admin_for_org resolves against the real actor), then emails the accept
 * link. Mirrors send-invoice/send-report-pack: if SMTP is not configured, the
 * invite still exists — the caller sees the link in the response and can
 * deliver it out-of-band, matching how the UI already behaves without this
 * function.
 *
 * Required edge-function secrets (Supabase → Edge Functions → Secrets):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SITE_URL
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SMTP_HOST = Deno.env.get('SMTP_HOST') ?? '';
const SMTP_PORT = Number(Deno.env.get('SMTP_PORT') ?? '587');
const SMTP_USER = Deno.env.get('SMTP_USER') ?? '';
const SMTP_PASS = Deno.env.get('SMTP_PASS') ?? '';
const SMTP_FROM = Deno.env.get('SMTP_FROM') ?? SMTP_USER;
const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://fcmanager.vercel.app';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
    if (authError || !caller) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json();
    const serviceAgreementId = String(body.service_agreement_id ?? '');
    const capability = String(body.capability ?? '');
    const email = String(body.email ?? '').trim();
    if (!serviceAgreementId || !['reporting', 'finance'].includes(capability) || !email) {
      return json({ error: 'service_agreement_id, capability, and email are required' }, 400);
    }

    // Create the invite as the caller — the RPC re-validates is_admin_for_org.
    const { data: invite, error: inviteError } = await callerClient.rpc('invite_client_capability_share', {
      p_service_agreement_id: serviceAgreementId,
      p_capability: capability,
      p_email: email,
    });
    if (inviteError || !invite) {
      return json({ error: inviteError?.message ?? 'Invite could not be created' }, 400);
    }

    const acceptUrl = `${SITE_URL}/invite/capability/${invite.token_hash}`;

    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      return json({ success: true, invite, accept_url: acceptUrl, email_sent: false, email_error: 'SMTP not configured — deliver the link manually' });
    }

    try {
      const client = new SMTPClient({
        connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: SMTP_PORT === 465, auth: { username: SMTP_USER, password: SMTP_PASS } },
      });
      await client.send({
        from: SMTP_FROM,
        to: email,
        subject: `You've been invited to view ${capability} — Field Compliance Manager`,
        html: `<div style="font-family: Georgia, serif; color:#111; max-width:640px;">
          <h2 style="margin:0 0 12px;">Shared access invitation</h2>
          <p>You have been invited to view <strong>${capability}</strong> information without accepting a full operational agreement.</p>
          <p><a href="${acceptUrl}" style="display:inline-block; padding:10px 16px; background:#0d1827; color:#fff; text-decoration:none; border-radius:6px;">Accept shared access</a></p>
          <p style="font-size:12px; color:#888;">This link expires in 14 days. If you did not expect this invite, you can ignore it.</p>
        </div>`,
      });
      await client.close();
    } catch (sendErr) {
      const msg = sendErr instanceof Error ? sendErr.message : 'SMTP send failed';
      return json({ success: true, invite, accept_url: acceptUrl, email_sent: false, email_error: msg });
    }

    return json({ success: true, invite, accept_url: acceptUrl, email_sent: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({ error: 'Server error', details: msg }, 500);
  }
});
