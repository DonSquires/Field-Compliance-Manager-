/**
 * bob-upsert-entity — governed create/update executor for CRM entities
 *
 * Purpose:
 *   Let Bob (and daily UI flows) create/update core CRM records from
 *   documents/imports WITHOUT users typing everything. This is the write end of
 *   the day-to-day loop: upload -> extract -> compare -> preview -> APPROVE ->
 *   this executor writes canonical records.
 *
 * Governance (fail-closed, old-app contract):
 *   - SERVICE-ROLE or x-cron-secret only (never a browser/user call) OR a
 *     JWT admin/master/grand_master when human_invoked=true.
 *   - Dedupe-aware: refuses to create a duplicate when a match key exists unless
 *     mode='update' with a target id.
 *   - Provenance required: every write records source + confidence + actor.
 *   - Canonical model only: organizations -> client_sites (site geofence),
 *     zones handled separately (polygon-first).
 *   - Advisory-safe: dry_run returns the exact planned write with NO mutation.
 *
 * Supported entities (this MR): client_org, client_site.
 *
 * Body:
 *   {
 *     "entity": "client_org" | "client_site",
 *     "mode": "create" | "update",
 *     "dry_run": true,
 *     "human_invoked": true,
 *     "data": { ... entity fields ... },
 *     "target_id": "uuid (required for update)",
 *     "provenance": { "source": "deputy_csv", "confidence": "high|medium|low", "evidence_ref": "..." },
 *     "job_id": "optional link to bob_job_runs",
 *     "step_id": "optional"
 *   }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret'
};
const CAN_WRITE_ROLES = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
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
function normKey(value) {
  return String(value ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
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
    const cronHeader = req.headers.get('x-cron-secret') ?? '';
    const isServiceRole = SUPABASE_SERVICE_ROLE_KEY && authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
    const isCron = CRON_SECRET && cronHeader === CRON_SECRET;
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // Resolve actor: service-role/cron OR an authorised human (human_invoked).
    let actorId = null;
    let actorRole = 'service';
    const body = await req.json();
    if (!isServiceRole && !isCron) {
      // Human path: must be human_invoked + authorised role.
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
      const { data: profile } = await admin.from('user_profiles').select('id, role').eq('id', user.id).single();
      if (!profile || !CAN_WRITE_ROLES.has(String(profile.role))) return json({
        error: 'Forbidden: admin/master/grand_master required'
      }, 403);
      if (body.human_invoked !== true) return json({
        error: 'human_invoked_required',
        message: 'A write must be explicitly human-invoked.'
      }, 403);
      actorId = user.id;
      actorRole = String(profile.role);
    }
    const entity = String(body.entity ?? '');
    const mode = body.mode ?? 'create';
    const dryRun = body.dry_run !== false; // default safe: dry-run unless explicitly false
    const data = body.data ?? {};
    const provenance = body.provenance ?? {};
    if (![
      'client_org',
      'client_site',
      'contact',
      'service_agreement',
      'user',
      'staff_profile',
      'invoice',
      'credential',
      'shift_template'
    ].includes(entity)) {
      return json({
        error: `Unsupported entity '${entity}' (supported: client_org, client_site, contact, service_agreement, user, staff_profile, invoice, credential, shift_template)`
      }, 422);
    }
    if (!provenance.source) return json({
      error: 'provenance.source is required (data lineage)'
    }, 400);
    // ── credential (staff_credentials) ──
    if (entity === 'credential') {
      const staffId = data.staff_id ? String(data.staff_id) : null;
      const orgId = data.organization_id ? String(data.organization_id) : null;
      if (mode === 'create') {
        if (!staffId || !orgId) return json({
          error: 'data.staff_id and data.organization_id are required to create a credential'
        }, 400);
        const credType = String(data.credential_type ?? '').trim();
        if (!credType) return json({
          error: 'data.credential_type is required'
        }, 400);
        const credNumber = String(data.credential_number ?? '').trim();
        const { data: existing } = await admin.from('staff_credentials').select('id, credential_type, credential_number').eq('staff_id', staffId).eq('credential_type', credType);
        const dup = (existing ?? []).find((c)=>credNumber && normKey(c.credential_number) === normKey(credNumber));
        if (dup) return json({
          success: false,
          blocked: 'duplicate',
          existing: dup,
          note: 'A matching credential exists for this staff member. Use mode=update with target_id.'
        }, 409);
        const row = {
          staff_id: staffId,
          organization_id: orgId,
          credential_type: credType,
          credential_number: credNumber || null,
          issuing_authority: data.issuing_authority ?? null,
          issued_date: data.issued_date ?? null,
          expiry_date: data.expiry_date ?? null,
          authorized_activities: data.authorized_activities ?? [],
          document_storage_path: data.document_storage_path ?? null,
          verified: false
        };
        if (dryRun) return json({
          success: true,
          dry_run: true,
          entity,
          mode,
          planned_row: row,
          provenance,
          note: 'Credential created unverified; verification is a separate governed action.'
        });
        const { data: created, error } = await admin.from('staff_credentials').insert(row).select('id, credential_type').single();
        if (error) return json({
          error: error.message
        }, 500);
        return json({
          success: true,
          entity,
          mode,
          result_table: 'staff_credentials',
          result_record_id: created.id,
          created,
          provenance,
          audit: {
            actor_id: actorId,
            actor_role: actorRole
          }
        });
      }
      if (!body.target_id) return json({
        error: 'target_id required for update'
      }, 400);
      const patch = {};
      for (const k of [
        'credential_type',
        'credential_number',
        'issuing_authority',
        'issued_date',
        'expiry_date',
        'authorized_activities',
        'document_storage_path',
        'verified'
      ])if (k in data) patch[k] = data[k];
      if (dryRun) return json({
        success: true,
        dry_run: true,
        entity,
        mode,
        target_id: body.target_id,
        planned_patch: patch,
        provenance
      });
      const { data: updated, error } = await admin.from('staff_credentials').update(patch).eq('id', body.target_id).select('id').single();
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        success: true,
        entity,
        mode,
        result_table: 'staff_credentials',
        result_record_id: updated.id,
        updated,
        provenance,
        audit: {
          actor_id: actorId,
          actor_role: actorRole
        }
      });
    }
    // ── shift_template (rostering) ──
    if (entity === 'shift_template') {
      const orgId = data.organization_id ? String(data.organization_id) : null;
      if (mode === 'create') {
        if (!orgId) return json({
          error: 'data.organization_id is required'
        }, 400);
        const name = String(data.name ?? '').trim();
        const shiftType = String(data.shift_type ?? '').trim();
        const startTime = String(data.start_time ?? '').trim();
        const endTime = String(data.end_time ?? '').trim();
        if (!name || !shiftType || !startTime || !endTime) return json({
          error: 'data.name, shift_type, start_time and end_time are required'
        }, 400);
        const row = {
          organization_id: orgId,
          name,
          description: data.description ?? null,
          shift_type: shiftType,
          start_time: startTime,
          end_time: endTime,
          recurrence_type: data.recurrence_type ?? 'weekly',
          active_days: data.active_days ?? [
            1,
            2,
            3,
            4,
            5,
            6,
            7
          ],
          required_staff_count: data.required_staff_count ?? 1,
          site_id: data.site_id ?? null,
          patrol_route_id: data.patrol_route_id ?? null,
          required_credentials: data.required_credentials ?? [],
          created_by: actorId
        };
        if (dryRun) return json({
          success: true,
          dry_run: true,
          entity,
          mode,
          planned_row: row,
          provenance
        });
        const { data: created, error } = await admin.from('shift_templates').insert(row).select('id, name').single();
        if (error) return json({
          error: error.message
        }, 500);
        return json({
          success: true,
          entity,
          mode,
          result_table: 'shift_templates',
          result_record_id: created.id,
          created,
          provenance,
          audit: {
            actor_id: actorId,
            actor_role: actorRole
          }
        });
      }
      if (!body.target_id) return json({
        error: 'target_id required for update'
      }, 400);
      const patch = {};
      for (const k of [
        'name',
        'description',
        'shift_type',
        'start_time',
        'end_time',
        'recurrence_type',
        'active_days',
        'required_staff_count',
        'site_id',
        'patrol_route_id',
        'required_credentials',
        'is_active'
      ])if (k in data) patch[k] = data[k];
      if (dryRun) return json({
        success: true,
        dry_run: true,
        entity,
        mode,
        target_id: body.target_id,
        planned_patch: patch,
        provenance
      });
      const { data: updated, error } = await admin.from('shift_templates').update(patch).eq('id', body.target_id).select('id').single();
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        success: true,
        entity,
        mode,
        result_table: 'shift_templates',
        result_record_id: updated.id,
        updated,
        provenance,
        audit: {
          actor_id: actorId,
          actor_role: actorRole
        }
      });
    }
    // ── invoice (invoices) ──
    // Financial data-entry: create/update invoices. Created as DRAFT by default;
    // status transitions (issued/paid/void) are explicit and audited. Dedupe on
    // (organization_id, invoice_number).
    if (entity === 'invoice') {
      const orgId = data.organization_id ? String(data.organization_id) : null;
      if (mode === 'create') {
        if (!orgId) return json({
          error: 'data.organization_id is required to create an invoice'
        }, 400);
        const invoiceNumber = String(data.invoice_number ?? '').trim();
        // Live invoices schema has NOT NULL (no default) on: organization_id,
        // client_organization_id, invoice_number, due_date (verified 2026-07-04).
        // Fail closed with a clear message rather than inserting nulls that error
        // opaquely at the DB.
        const clientOrgId = data.client_organization_id ? String(data.client_organization_id) : null;
        const dueDate = data.due_date ?? data.due_at ?? null;
        const missing = [];
        if (!invoiceNumber) missing.push('invoice_number');
        if (!clientOrgId) missing.push('client_organization_id');
        if (!dueDate) missing.push('due_date');
        if (missing.length) {
          return json({
            success: false,
            needs_clarification: true,
            entity,
            mode,
            missing_required: missing,
            clarifying_questions: missing.map((m)=>`What is the ${m.replace(/_/g, ' ')} for this invoice?`),
            note: 'These invoice fields are required by the live schema (NOT NULL).'
          }, 200);
        }
        if (invoiceNumber) {
          const { data: existing } = await admin.from('invoices').select('id, invoice_number, status').eq('organization_id', orgId).eq('invoice_number', invoiceNumber).maybeSingle();
          if (existing) return json({
            success: false,
            blocked: 'duplicate',
            existing,
            note: 'An invoice with this number exists for the org. Use mode=update with target_id.'
          }, 409);
        }
        const row = {
          organization_id: orgId,
          invoice_number: invoiceNumber || null,
          client_organization_id: clientOrgId,
          service_agreement_id: data.service_agreement_id ?? null,
          site_id: data.site_id ?? null,
          subtotal: data.subtotal ?? null,
          gst_amount: data.gst_amount ?? null,
          total_amount: data.total_amount ?? data.amount ?? null,
          currency: data.currency ?? 'NZD',
          status: data.status ?? 'draft',
          invoice_date: data.invoice_date ?? new Date().toISOString().slice(0, 10),
          due_date: dueDate,
          service_period_start: data.service_period_start ?? null,
          service_period_end: data.service_period_end ?? null,
          notes: data.notes ?? null,
          created_by: actorId
        };
        if (dryRun) return json({
          success: true,
          dry_run: true,
          entity,
          mode,
          planned_row: row,
          provenance,
          note: 'Invoice created as draft unless status supplied. Client is referenced by client_organization_id (there is no client_name column).'
        });
        const { data: created, error } = await admin.from('invoices').insert(row).select('id, invoice_number').single();
        if (error) return json({
          error: error.message
        }, 500);
        return json({
          success: true,
          entity,
          mode,
          result_table: 'invoices',
          result_record_id: created.id,
          created,
          provenance,
          audit: {
            actor_id: actorId,
            actor_role: actorRole
          }
        });
      }
      if (!body.target_id) return json({
        error: 'target_id required for update'
      }, 400);
      const patch = {};
      for (const k of [
        'invoice_number',
        'client_organization_id',
        'service_agreement_id',
        'site_id',
        'subtotal',
        'gst_amount',
        'total_amount',
        'currency',
        'status',
        'invoice_date',
        'due_date',
        'service_period_start',
        'service_period_end',
        'sent_at',
        'paid_at',
        'notes'
      ])if (k in data) patch[k] = data[k];
      if (dryRun) return json({
        success: true,
        dry_run: true,
        entity,
        mode,
        target_id: body.target_id,
        planned_patch: patch,
        provenance
      });
      const { data: updated, error } = await admin.from('invoices').update(patch).eq('id', body.target_id).select('id').single();
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        success: true,
        entity,
        mode,
        result_table: 'invoices',
        result_record_id: updated.id,
        updated,
        provenance,
        audit: {
          actor_id: actorId,
          actor_role: actorRole
        }
      });
    }
    // ── user (delegates to create-user: auth + invite + staff onboarding) ──
    // User creation is auth-sensitive and MUST go through create-user, which owns
    // Supabase Auth provisioning, invite email, and unified staff onboarding.
    // We never insert user_profiles/auth directly here.
    if (entity === 'user') {
      if (mode !== 'create') {
        // Non-auth profile edits go through staff_profile/update or a dedicated
        // manage-user path; we do not update auth identity here.
        return json({
          error: 'user update is not supported here; use staff_profile update or the manage-user path for profile changes.'
        }, 422);
      }
      const email = String(data.email ?? '').trim();
      const role = String(data.role ?? '').trim();
      if (!email || !role) return json({
        error: 'data.email and data.role are required to create a user'
      }, 400);
      // Dedupe: existing profile by email.
      const { data: existingUser } = await admin.from('user_profiles').select('id, display_name').eq('email', email).maybeSingle();
      if (existingUser) {
        return json({
          success: false,
          blocked: 'duplicate',
          existing: existingUser,
          note: 'A user with this email already exists.'
        }, 409);
      }
      if (dryRun) {
        return json({
          success: true,
          dry_run: true,
          entity,
          mode,
          planned_action: 'invoke create-user',
          planned_row: {
            email,
            role,
            organization_id: data.organization_id ?? null,
            display_name: data.display_name ?? null
          },
          provenance
        });
      }
      // Live: forward to create-user with the caller JWT so it enforces its own
      // role gate + performs auth provisioning/invite/onboarding.
      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader
        },
        body: JSON.stringify(data)
      });
      const created = await res.json().catch(()=>({}));
      if (!res.ok) return json({
        error: 'create-user failed',
        detail: created
      }, res.status);
      return json({
        success: true,
        entity,
        mode,
        result_table: 'user_profiles',
        result_record_id: created.user_id ?? created.id ?? null,
        created,
        provenance,
        audit: {
          actor_id: actorId,
          actor_role: actorRole
        }
      });
    }
    // ── staff_profile (non-auth employment record update) ──
    if (entity === 'staff_profile') {
      if (!body.target_id) return json({
        error: 'target_id (staff_profiles.id) required'
      }, 400);
      const patch = {};
      for (const k of [
        'employee_number',
        'employment_type',
        'start_date',
        'end_date',
        'emergency_contact_name',
        'emergency_contact_phone',
        'emergency_contact_relation',
        'payroll_id',
        'tax_code',
        'uniform_size',
        'notes'
      ]){
        if (k in data) patch[k] = data[k];
      }
      if (!Object.keys(patch).length) return json({
        error: 'no updatable staff_profile fields supplied'
      }, 400);
      if (dryRun) return json({
        success: true,
        dry_run: true,
        entity,
        mode: 'update',
        target_id: body.target_id,
        planned_patch: patch,
        provenance
      });
      const { data: updated, error } = await admin.from('staff_profiles').update(patch).eq('id', body.target_id).select('id').single();
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        success: true,
        entity,
        mode: 'update',
        result_table: 'staff_profiles',
        result_record_id: updated.id,
        updated,
        provenance,
        audit: {
          actor_id: actorId,
          actor_role: actorRole
        }
      });
    }
    // ── contact (crm_contacts) ──
    if (entity === 'contact') {
      const orgId = data.organization_id ? String(data.organization_id) : null;
      const firstName = String(data.first_name ?? '').trim();
      const lastName = String(data.last_name ?? '').trim();
      if (mode === 'create') {
        if (!orgId) return json({
          error: 'data.organization_id is required to create a contact'
        }, 400);
        if (!firstName || !lastName) return json({
          error: 'data.first_name and data.last_name are required'
        }, 400);
        // Dedupe on org + normalised name + email.
        const { data: existing } = await admin.from('crm_contacts').select('id, first_name, last_name, email').eq('organization_id', orgId);
        const dup = (existing ?? []).find((c)=>normKey(`${c.first_name} ${c.last_name}`) === normKey(`${firstName} ${lastName}`) || data.email && normKey(c.email) === normKey(data.email));
        if (dup) return json({
          success: false,
          blocked: 'duplicate',
          existing: dup,
          note: 'A matching contact exists for this org. Use mode=update with target_id.'
        }, 409);
        const row = {
          organization_id: orgId,
          first_name: firstName,
          last_name: lastName,
          role_title: data.role_title ?? null,
          email: data.email ?? null,
          phone: data.phone ?? null,
          mobile: data.mobile ?? null,
          is_primary: data.is_primary ?? false,
          is_emergency: data.is_emergency ?? false,
          notes: data.notes ?? null
        };
        if (dryRun) return json({
          success: true,
          dry_run: true,
          entity,
          mode,
          planned_row: row,
          provenance
        });
        const { data: created, error } = await admin.from('crm_contacts').insert(row).select('id, first_name, last_name').single();
        if (error) return json({
          error: error.message
        }, 500);
        return json({
          success: true,
          entity,
          mode,
          result_table: 'crm_contacts',
          result_record_id: created.id,
          created,
          provenance,
          audit: {
            actor_id: actorId,
            actor_role: actorRole
          }
        });
      }
      if (!body.target_id) return json({
        error: 'target_id required for update'
      }, 400);
      const patch = {};
      for (const k of [
        'first_name',
        'last_name',
        'role_title',
        'email',
        'phone',
        'mobile',
        'is_primary',
        'is_emergency',
        'notes'
      ])if (k in data) patch[k] = data[k];
      if (dryRun) return json({
        success: true,
        dry_run: true,
        entity,
        mode,
        target_id: body.target_id,
        planned_patch: patch,
        provenance
      });
      const { data: updated, error } = await admin.from('crm_contacts').update(patch).eq('id', body.target_id).select('id').single();
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        success: true,
        entity,
        mode,
        result_table: 'crm_contacts',
        result_record_id: updated.id,
        updated,
        provenance,
        audit: {
          actor_id: actorId,
          actor_role: actorRole
        }
      });
    }
    // ── service_agreement (INERT DRAFT create; safe update) ──
    // Live required (verified via bob-proposal-execute): provider_organization_id,
    // client_organization_id, name. Draft is inert (no portal enablement).
    if (entity === 'service_agreement') {
      if (mode === 'create') {
        const providerOrgId = data.provider_organization_id ? String(data.provider_organization_id) : null;
        const clientOrgId = data.client_organization_id ? String(data.client_organization_id) : null;
        const name = String(data.name ?? '').trim();
        if (!providerOrgId || !clientOrgId || !name) {
          return json({
            error: 'provider_organization_id, client_organization_id and name are required'
          }, 400);
        }
        const row = {
          provider_organization_id: providerOrgId,
          client_organization_id: clientOrgId,
          name,
          starts_on: data.starts_on ?? null,
          ends_on: data.ends_on ?? null,
          client_portal_access_mode: 'transparency_only',
          client_portal_reports_enabled: false,
          client_portal_finance_enabled: false,
          allows_client_submission: false,
          allows_auto_dispatch: false
        };
        if (dryRun) return json({
          success: true,
          dry_run: true,
          entity,
          mode,
          planned_row: row,
          provenance,
          note: 'Draft is inert; a human activates it in CRM.'
        });
        const { data: created, error } = await admin.from('service_agreements').insert(row).select('id, name').single();
        if (error) return json({
          error: error.message
        }, 500);
        return json({
          success: true,
          entity,
          mode,
          result_table: 'service_agreements',
          result_record_id: created.id,
          created,
          provenance,
          note: 'Inert draft created; activate in CRM.',
          audit: {
            actor_id: actorId,
            actor_role: actorRole
          }
        });
      }
      if (!body.target_id) return json({
        error: 'target_id required for update'
      }, 400);
      const patch = {};
      for (const k of [
        'name',
        'client_organization_id',
        'provider_organization_id',
        'starts_on',
        'ends_on'
      ])if (k in data) patch[k] = data[k];
      if (dryRun) return json({
        success: true,
        dry_run: true,
        entity,
        mode,
        target_id: body.target_id,
        planned_patch: patch,
        provenance
      });
      const { data: updated, error } = await admin.from('service_agreements').update(patch).eq('id', body.target_id).select('id').single();
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        success: true,
        entity,
        mode,
        result_table: 'service_agreements',
        result_record_id: updated.id,
        updated,
        provenance,
        audit: {
          actor_id: actorId,
          actor_role: actorRole
        }
      });
    }
    // ── client_org ──
    if (entity === 'client_org') {
      const name = String(data.name ?? '').trim();
      if (!name && mode === 'create') return json({
        error: 'data.name is required to create a client organisation'
      }, 400);
      if (mode === 'create') {
        // Dedupe on normalised name.
        const { data: existing } = await admin.from('organizations').select('id, name, organization_type').eq('organization_type', 'client');
        const dup = (existing ?? []).find((o)=>normKey(o.name) === normKey(name));
        if (dup) {
          return json({
            success: false,
            blocked: 'duplicate',
            existing: dup,
            note: 'A client with this name exists. Use mode=update with target_id to modify it.'
          }, 409);
        }
        const row = {
          name,
          organization_type: 'client',
          active: true,
          parent_organization_id: data.parent_organization_id ?? null,
          contact_email: data.contact_email ?? null,
          contact_phone: data.contact_phone ?? null,
          account_notes: data.account_notes ?? null
        };
        if (dryRun) return json({
          success: true,
          dry_run: true,
          entity,
          mode,
          planned_row: row,
          provenance
        });
        const { data: created, error } = await admin.from('organizations').insert(row).select('id, name').single();
        if (error) return json({
          error: error.message
        }, 500);
        return json({
          success: true,
          entity,
          mode,
          result_table: 'organizations',
          result_record_id: created.id,
          created,
          provenance,
          audit: {
            actor_id: actorId,
            actor_role: actorRole
          }
        });
      }
      // update
      if (!body.target_id) return json({
        error: 'target_id required for update'
      }, 400);
      const patch = {};
      for (const k of [
        'name',
        'active',
        'status',
        'parent_organization_id',
        'contact_email',
        'contact_phone',
        'account_notes'
      ])if (k in data) patch[k] = data[k];
      if (dryRun) return json({
        success: true,
        dry_run: true,
        entity,
        mode,
        target_id: body.target_id,
        planned_patch: patch,
        provenance
      });
      const { data: updated, error } = await admin.from('organizations').update(patch).eq('id', body.target_id).select('id, name').single();
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        success: true,
        entity,
        mode,
        result_table: 'organizations',
        result_record_id: updated.id,
        updated,
        provenance,
        audit: {
          actor_id: actorId,
          actor_role: actorRole
        }
      });
    }
    // ── client_site ──
    // Live schema (confirmed 2026-07-04): client_sites has NO organization_id,
    // suburb, postcode or country columns. Ownership is via client_organization_id.
    // Aligned field-for-field with the human ClientOnboardingWizard.
    const siteName = String(data.name ?? '').trim();
    const address = String(data.address ?? '').trim();
    const clientOrgId = data.client_organization_id ? String(data.client_organization_id) : null;
    // Same key rule as public.address_match_key(text); the DB trigger re-derives it on write.
    const addressMatchKey = (String(data.address_match_key ?? '').trim() || address).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (mode === 'create') {
      if (!siteName && !address) return json({
        error: 'data.name or data.address is required to create a site'
      }, 400);
      if (addressMatchKey && clientOrgId) {
        // A duplicate is the same address inside the same owner organisation; another
        // organisation's site at this address is its own facet on the shared registry place.
        const { data: existing } = await admin.from('client_sites').select('id, name, address_match_key').eq('client_organization_id', clientOrgId).eq('address_match_key', addressMatchKey).limit(1).maybeSingle();
        if (existing) {
          return json({
            success: false,
            blocked: 'duplicate',
            existing,
            note: 'A site with this address key exists. Use mode=update with target_id.'
          }, 409);
        }
      }
      const row = {
        name: siteName || `${data.client_name ?? 'Site'} - ${address}`,
        client_organization_id: clientOrgId,
        address: address || null,
        site_type: data.site_type ?? null,
        risk_level: data.risk_level ?? null,
        site_origin: data.site_origin ?? 'contracted',
        ownership_status: clientOrgId ? 'resolved' : 'needs_review',
        address_match_key: addressMatchKey || null,
        gps_lat: data.gps_lat ?? null,
        gps_lng: data.gps_lng ?? null,
        active: true
      };
      if (dryRun) return json({
        success: true,
        dry_run: true,
        entity,
        mode,
        planned_row: row,
        provenance
      });
      const { data: created, error } = await admin.from('client_sites').insert(row).select('id, name').single();
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        success: true,
        entity,
        mode,
        result_table: 'client_sites',
        result_record_id: created.id,
        created,
        provenance,
        audit: {
          actor_id: actorId,
          actor_role: actorRole
        }
      });
    }
    // update site
    if (!body.target_id) return json({
      error: 'target_id required for update'
    }, 400);
    const patch = {};
    for (const k of [
      'name',
      'client_organization_id',
      'address',
      'site_type',
      'risk_level',
      'site_origin',
      'ownership_status',
      'gps_lat',
      'gps_lng',
      'active'
    ]){
      if (k in data) patch[k] = data[k];
    }
    if (dryRun) return json({
      success: true,
      dry_run: true,
      entity,
      mode,
      target_id: body.target_id,
      planned_patch: patch,
      provenance
    });
    const { data: updated, error } = await admin.from('client_sites').update(patch).eq('id', body.target_id).select('id, name').single();
    if (error) return json({
      error: error.message
    }, 500);
    return json({
      success: true,
      entity,
      mode,
      result_table: 'client_sites',
      result_record_id: updated.id,
      updated,
      provenance,
      audit: {
        actor_id: actorId,
        actor_role: actorRole
      }
    });
  } catch (err) {
    console.error('[bob-upsert-entity] error:', err);
    return json({
      error: 'Upsert failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
