/**
 * bob-reverse-job-step — governed reversal of a recorded job write step
 *
 * Purpose:
 *   Close the governance loop: a write performed by a governed job (recorded in
 *   bob_job_rollback_refs) can be reviewed and reversed with a full audit trail.
 *
 * Reversal model (safe by default):
 *   - CREATE (insert) steps: soft-reverse where the target table supports it
 *     (set status/active flags), else hard delete ONLY for grand_master.
 *   - EXECUTE (proposal_execute) steps: not auto-reversible here (the underlying
 *     effect is domain-specific); returns needs_manual with guidance.
 *   - Marks the rollback ref reversed + timestamp; never silently loses history.
 *
 * Auth: JWT admin/master/grand_master. Hard delete = grand_master only.
 *
 * Body: { "rollback_ref_id": "..." }  or  { "job_id": "...", "step_id": "..." }
 *
 * Extensibility: reversal is table-driven via SOFT_REVERSE map so new data-entry
 * areas (user management, staff, rosters, etc.) are added by extending the map.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_REVERSE = new Set([
  'grand_master',
  'master',
  'admin'
]);
// Table-driven soft-reverse config. To support a new data-entry area, add its
// table here with the column + value that marks a record inactive/archived.
// If a table is not listed, soft-reverse is unavailable and only grand_master
// may hard-delete (when the table allows it).
const SOFT_REVERSE = {
  organizations: {
    column: 'status',
    value: 'archived'
  },
  client_sites: {
    column: 'ownership_status',
    value: 'needs_review'
  },
  crm_contacts: {
    column: 'is_primary',
    value: false
  },
  // user management: soft-reverse = deactivate the profile (never hard-delete by default).
  // NOTE: reversing a user creation only deactivates the profile row; auth teardown
  // must go through the dedicated deactivate-user/delete-user path (grand_master).
  user_profiles: {
    column: 'is_active',
    value: false
  },
  staff_profiles: {
    column: 'work_ready',
    value: false
  },
  // financial: reversing an invoice = void it (never delete financial records).
  invoices: {
    column: 'status',
    value: 'void'
  },
  // credential: reversing = mark unverified (never silently delete a credential record).
  staff_credentials: {
    column: 'verified',
    value: false
  },
  // rostering: reversing a template = deactivate it.
  shift_templates: {
    column: 'is_active',
    value: false
  }
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
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
    if (!profile || !CAN_REVERSE.has(String(profile.role))) return json({
      error: 'Forbidden: admin/master/grand_master required'
    }, 403);
    const isGrandMaster = String(profile.role) === 'grand_master';
    const body = await req.json();
    // Resolve the rollback ref.
    let ref = null;
    if (body.rollback_ref_id) {
      const { data } = await admin.from('bob_job_rollback_refs').select('*').eq('id', body.rollback_ref_id).maybeSingle();
      ref = data;
    } else if (body.job_id && body.step_id) {
      const { data } = await admin.from('bob_job_rollback_refs').select('*').eq('job_id', body.job_id).eq('step_id', body.step_id).maybeSingle();
      ref = data;
    } else {
      return json({
        error: 'Provide rollback_ref_id or (job_id + step_id)'
      }, 400);
    }
    if (!ref) return json({
      error: 'Rollback reference not found'
    }, 404);
    if (ref.reversed) return json({
      success: true,
      already_reversed: true,
      ref
    });
    if (!ref.target_table || !ref.target_record_id) {
      return json({
        success: false,
        needs_manual: true,
        reason: 'This step has no concrete target record to reverse.',
        ref
      }, 200);
    }
    // EXECUTE steps are domain-specific; do not auto-reverse.
    if (ref.action === 'execute') {
      return json({
        success: false,
        needs_manual: true,
        reason: 'Executed proposal effects are domain-specific and must be reversed manually or by a dedicated undo action.',
        ref
      }, 200);
    }
    const table = String(ref.target_table);
    const soft = SOFT_REVERSE[table];
    let reversalMethod = 'none';
    if (soft) {
      const { error } = await admin.from(table).update({
        [soft.column]: soft.value
      }).eq('id', ref.target_record_id);
      if (error) return json({
        error: `Soft-reverse failed: ${error.message}`
      }, 500);
      reversalMethod = `soft:${soft.column}=${String(soft.value)}`;
    } else if (body.hard_delete && isGrandMaster) {
      const { error } = await admin.from(table).delete().eq('id', ref.target_record_id);
      if (error) return json({
        error: `Hard delete failed: ${error.message}`
      }, 500);
      reversalMethod = 'hard_delete';
    } else {
      return json({
        success: false,
        needs_manual: true,
        reason: `No soft-reverse configured for '${table}'. Hard delete requires grand_master with hard_delete:true.`,
        ref
      }, 200);
    }
    await admin.from('bob_job_rollback_refs').update({
      reversed: true,
      reversed_at: new Date().toISOString()
    }).eq('id', ref.id);
    return json({
      success: true,
      reversed: true,
      method: reversalMethod,
      target_table: table,
      target_record_id: ref.target_record_id,
      audit: {
        actor_id: user.id,
        role: profile.role
      },
      note: 'Reversal recorded. History is preserved; this is a governed, audited action.'
    });
  } catch (err) {
    console.error('[bob-reverse-job-step] error:', err);
    return json({
      error: 'Reversal failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
