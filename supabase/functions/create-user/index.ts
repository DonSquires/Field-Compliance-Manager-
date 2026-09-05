/**
 * create-user — User provisioning, invite, and unified staff onboarding
 *
 * POST /functions/v1/create-user
 *
 * Creates a Supabase Auth user via admin API and inserts a user_profile row.
 * Optionally (unified onboarding) also:
 *   - sets user_profiles.employer_organization_id (corporate employer)
 *   - creates a staff_profiles employment record linked via user_id (0072)
 *   - creates staff_branch_authorisations rows (per-branch role + modules) (0074)
 *
 * All onboarding fields are OPTIONAL — a plain invite (email/role/org) still works.
 *
 * Auth: Requires a valid JWT from an admin/master/grand_master user.
 * Uses SUPABASE_SERVICE_ROLE_KEY to call the admin API server-side.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { roleLevel } from '../_shared/auth.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const ALLOWED_ROLES = [
  'grand_master',
  'master',
  'admin',
  'admin_officer',
  'nzscv_monitor',
  'officer',
  'scan_operator',
  'client_admin',
  'client_officer',
  'client_viewer'
];
const CAN_INVITE = [
  'grand_master',
  'master',
  'admin'
];
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
    // Verify caller JWT
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
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
    // Get caller profile to check role
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await adminClient.from('user_profiles').select('role, organization_id, employer_organization_id').eq('id', caller.id).single();
    if (!callerProfile || !CAN_INVITE.includes(callerProfile.role)) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    const { email, display_name, role, organization_id, phone, address, employer_organization_id, staff, branch_authorisations, preauthenticated, password } = body;
    // Optional access preset key (issue #3, C3). Read loosely so it works even if
    // the typed body above does not declare it.
    const access_preset_key = body.access_preset_key;
    if (!email?.trim()) return json({
      error: 'email is required'
    }, 400);
    if (!role || !ALLOWED_ROLES.includes(role)) return json({
      error: 'valid role is required'
    }, 400);
    if (roleLevel(role) > roleLevel(callerProfile.role)) return json({
      error: 'Forbidden: cannot assign a role above your own authority level'
    }, 403);
    // Pre-authenticated path: validate password server-side
    if (preauthenticated) {
      if (!CAN_INVITE.includes(callerProfile.role)) {
        return json({
          error: 'Forbidden: only grand_master, master, or admin may pre-authenticate users'
        }, 403);
      }
      if (!password || typeof password !== 'string' || password.length < 8) {
        return json({
          error: 'Password must be at least 8 characters when pre-authenticating'
        }, 400);
      }
    }
    // Admins can only invite to their own org
    const targetOrgId = callerProfile.role === 'grand_master' ? organization_id ?? callerProfile.organization_id : callerProfile.organization_id;
    if (!targetOrgId) return json({
      error: 'organization_id is required'
    }, 400);
    const employerOrgId = employer_organization_id ?? callerProfile.employer_organization_id ?? callerProfile.organization_id;
    if (!employerOrgId) return json({
      error: 'An employing organization is required'
    }, 400);
    const callerEmployerOrgId = callerProfile.employer_organization_id ?? callerProfile.organization_id;
    if (callerProfile.role !== 'grand_master' && employerOrgId !== callerEmployerOrgId) return json({
      error: 'Forbidden: staff can only be employed by your corporate organization'
    }, 403);
    const { data: employerOrg } = await adminClient.from('organizations').select('id, organization_type, active').eq('id', employerOrgId).maybeSingle();
    if (!employerOrg?.active || !['owner', 'service_provider'].includes(employerOrg.organization_type)) return json({
      error: 'Employer must be an active provider organization'
    }, 400);
    if (staff && ['officer', 'admin_officer'].includes(role) && !branch_authorisations?.length) return json({
      error: 'Field staff require at least one branch authorization'
    }, 400);
    if (branch_authorisations?.length) {
      const { data: descendantIds, error: descendantsError } = await adminClient.rpc('get_descendant_organizations', { org_id: employerOrgId });
      if (descendantsError) return json({ error: 'Employer branch scope could not be verified' }, 500);
      const requestedBranchIds = [...new Set(branch_authorisations.map((branch)=>branch?.branch_org_id).filter(Boolean))];
      const { data: branches, error: branchesError } = await adminClient.from('organizations').select('id').in('id', requestedBranchIds).eq('organization_type', 'branch').eq('active', true);
      if (branchesError || branches?.length !== requestedBranchIds.length || requestedBranchIds.some((branchId)=>!descendantIds?.includes(branchId))) return json({
        error: 'Every branch authorization must be an active delivery branch of the employer'
      }, 400);
    }
    // Fetch the employer org so the invite email can be branded to the inviting
    // company (name + logo) rather than the platform owner.
    const brandingOrgId = employerOrgId;
    const { data: brandingOrg } = await adminClient.from('organizations').select('name, logo_url').eq('id', brandingOrgId).single();
    const ROLE_LABELS = {
      grand_master: 'Grand Master',
      master: 'Master',
      admin: 'Administrator',
      admin_officer: 'Admin Officer',
      nzscv_monitor: 'NZSCV Monitor',
      officer: 'Officer',
      scan_operator: 'Scan Operator',
      client_admin: 'Client Administrator',
      client_officer: 'Client Officer',
      client_viewer: 'Client Viewer'
    };
    const orgName = brandingOrg?.name ?? 'Field Compliance Manager';
    const roleLabel = ROLE_LABELS[role] ?? role;
    // ── Create auth user: pre-authenticated (password) OR invite (email) ──
    // Track only the resolved auth user id. The Supabase admin SDK returns
    // `{ user: User | null }` from both createUser and inviteUserByEmail, so we
    // read `.user?.id` off each result rather than casting the whole object
    // (the differing union shapes make a `typeof` cast a TS2352 error).
    let inviteUserId = null;
    let inviteError = null;
    if (preauthenticated && password) {
      // Pre-authenticated: create with password + email_confirm so they can
      // sign in immediately with no invite email round-trip.
      const { data: createData, error: createError } = await adminClient.auth.admin.createUser({
        email: email.trim().toLowerCase(),
        password,
        email_confirm: true,
        user_metadata: {
          display_name: display_name?.trim() ?? '',
          role,
          role_label: roleLabel,
          organization_id: targetOrgId,
          organization_name: orgName,
          organization_logo: brandingOrg?.logo_url ?? ''
        }
      });
      inviteUserId = createData?.user?.id ?? null;
      inviteError = createError;
    } else {
      // Default invite path: sends an email for the user to set their password.
      const result = await adminClient.auth.admin.inviteUserByEmail(email.trim().toLowerCase(), {
        data: {
          display_name: display_name?.trim() ?? '',
          role,
          role_label: roleLabel,
          organization_id: targetOrgId,
          organization_name: orgName,
          organization_logo: brandingOrg?.logo_url ?? ''
        },
        redirectTo: `${Deno.env.get('SITE_URL') ?? 'https://fcmanager.co.nz'}/auth/callback`
      });
      inviteUserId = result.data?.user?.id ?? null;
      inviteError = result.error;
    }
    if (inviteError) {
      // If the auth user already exists, resolve their id and continue onboarding
      // (attach staff record + branch authorisations) instead of hard-failing.
      const msg = inviteError.message?.toLowerCase() ?? '';
      const alreadyExists = msg.includes('already') || msg.includes('registered') || msg.includes('exists');
      if (!alreadyExists) {
        console.error('[create-user] create/invite error:', inviteError.message);
        return json({
          error: `${preauthenticated ? 'Create' : 'Invite'} failed: ${inviteError.message}`
        }, 400);
      }
      // Resolve the existing auth user by email deterministically (single
      // targeted lookup), NOT by scanning paginated listUsers which could match
      // a stale/wrong id.
      const normEmail = email.trim().toLowerCase();
      let foundId = null;
      try {
        const { data: list } = await adminClient.auth.admin.listUsers({
          page: 1,
          perPage: 200
        });
        const matches = (list?.users ?? []).filter((u)=>(u.email ?? '').toLowerCase() === normEmail);
        // If somehow more than one auth user shares the email, prefer the one that
        // already has a user_profiles row (the FK target); else the most recent.
        if (matches.length === 1) {
          foundId = matches[0].id;
        } else if (matches.length > 1) {
          const { data: prof } = await adminClient.from('user_profiles').select('id').eq('email', normEmail).maybeSingle();
          foundId = prof?.id ?? matches.sort((a, b)=>(b.created_at ?? '').localeCompare(a.created_at ?? ''))[0].id;
        }
      } catch (e) {
        console.error('[create-user] listUsers lookup failed:', e);
      }
      // Fall back to an existing profile by email so we never invent an id.
      if (!foundId) {
        const { data: prof } = await adminClient.from('user_profiles').select('id').eq('email', normEmail).maybeSingle();
        foundId = prof?.id ?? null;
      }
      if (!foundId) {
        return json({
          error: `A user with email ${email} already exists but could not be resolved. Use Invite/Resend instead.`
        }, 409);
      }
      inviteUserId = foundId;
    }
    // Guard: resolve a concrete auth user id. `inviteUserByEmail` returns
    // { user: User | null }, so on the success path the id can be null
    // (TS18047). Never dereference null or invent an id — fail loudly if we
    // somehow have no id at this point.
    if (!inviteUserId) {
      console.error('[create-user] no auth user id resolved after invite/lookup');
      return json({
        step: 'resolve_user',
        error: 'Could not resolve an auth user id for this email.'
      }, 500);
    }
    // Upsert user_profile row (include email so UI can show Resend without service-role)
    const normEmail = email.trim().toLowerCase();
    const { error: profileError } = await adminClient.from('user_profiles').upsert({
      id: inviteUserId,
      organization_id: targetOrgId,
      display_name: display_name?.trim() ?? email.split('@')[0],
      role,
      email: normEmail,
      ...phone?.trim() ? {
        phone: phone.trim()
      } : {},
      ...address?.trim() ? {
        address: address.trim()
      } : {},
      employer_organization_id: employerOrgId
    }, {
      onConflict: 'id'
    });
    if (profileError) {
      console.error('[create-user] profile error:', JSON.stringify(profileError));
      return json({
        step: 'profile_upsert',
        error: profileError.message,
        details: profileError.details ?? null
      }, 500);
    }
    // Anchor everything downstream on the PERSISTED profile id (the exact value
    // staff_profiles.id must FK to). Re-read by email so a wrong/stale auth id
    // can never propagate to the staff write.
    const { data: persistedProfile, error: reReadErr } = await adminClient.from('user_profiles').select('id').eq('email', normEmail).maybeSingle();
    if (reReadErr || !persistedProfile?.id) {
      console.error('[create-user] profile re-read failed:', JSON.stringify(reReadErr));
      return json({
        step: 'profile_verify',
        error: 'Profile was not found after upsert; aborting before staff write.',
        details: reReadErr?.message ?? null
      }, 500);
    }
    const userId = persistedProfile.id;
    // ── Audit: log the create action ─────────────────────────────────────────
    const auditActionType = preauthenticated ? 'user_created_preauthenticated' : 'user_invited';
    const auditMetadata = {
      display_name: display_name?.trim() ?? normEmail.split('@')[0],
      role,
      preauthenticated: !!preauthenticated
    };
    try {
      await adminClient.rpc('log_user_management_action', {
        p_organization_id: targetOrgId,
        p_target_user_id: userId,
        p_action_type: auditActionType,
        p_performed_by: caller.id,
        p_old_value: null,
        p_new_value: null,
        p_metadata: auditMetadata
      });
    } catch (auditErr) {
      // Audit failure must not block user creation
      console.error('[create-user] audit log failed:', auditErr);
    }
    // ── Unified onboarding (optional) ────────────────────────────────────────
    let staffId = null;
    if (staff || branch_authorisations && branch_authorisations.length > 0) {
      // Employment record lives under the corporate employer (fallback to org).
      const employerOrg = employerOrgId;
      // staff_profiles.id is a SHARED PRIMARY KEY: staff_profiles_id_fkey makes
      // id REFERENCE user_profiles(id), so id MUST equal the user's id (= userId).
      // user_id (0072) is redundant with id but kept populated for back-compat.
      const staffPayload = {
        id: userId,
        organization_id: employerOrg,
        user_id: userId,
        employee_number: staff?.employee_number?.trim() || null,
        employment_type: staff?.employment_type?.trim() || null,
        start_date: staff?.start_date || null,
        tax_code: staff?.tax_code?.trim() || null,
        bank_account: staff?.bank_account?.trim() || null,
        date_of_birth: staff?.date_of_birth || null,
        work_ready: staff?.work_ready ?? false
      };
      // Upsert on the primary key (id = userId): idempotent for re-onboarding,
      // no separate check needed since id is the natural one-to-one key.
      const { data: staffRow, error: staffError } = await adminClient.from('staff_profiles').upsert(staffPayload, {
        onConflict: 'id'
      }).select('id').single();
      if (staffError || !staffRow) {
        console.error('[create-user] staff_profiles error:', JSON.stringify(staffError));
        return json({
          step: 'staff_profiles',
          error: `Login created and invite sent, but the staff record failed: ${staffError?.message ?? 'unknown'}`,
          details: staffError?.details ?? null,
          user_id: userId,
          hint: 'Login already exists — fix and use Resend rather than re-onboarding.'
        }, 500);
      }
      staffId = staffRow.id;
      if (branch_authorisations && branch_authorisations.length > 0) {
        const rows = branch_authorisations.filter((b)=>b.branch_org_id).map((b)=>({
            user_id: userId,
            branch_org_id: b.branch_org_id,
            role_at_branch: b.role_at_branch?.trim() || 'officer',
            module_access: Array.isArray(b.module_access) ? b.module_access : [],
            can_be_rostered: b.can_be_rostered ?? true,
            authorised_by: caller.id,
            status: 'active'
          }));
        if (rows.length > 0) {
          // Upsert on the unique (user_id, branch_org_id) key so re-onboarding an
          // already-authorised staff member UPDATES their branch authorisation
          // instead of failing with a 23505 duplicate-key 500 (matches the
          // idempotent upserts used for the profile + staff rows above).
          const { error: authError2 } = await adminClient.from('staff_branch_authorisations').upsert(rows, {
            onConflict: 'user_id,branch_org_id'
          });
          if (authError2) {
            console.error('[create-user] branch authorisation error:', JSON.stringify(authError2));
            return json({
              step: 'branch_authorisations',
              error: `Login and staff created, but branch authorisation failed: ${authError2.message}`,
              details: authError2.details ?? null,
              hint: authError2.hint ?? null,
              user_id: userId,
              staff_id: staffId
            }, 500);
          }
        }
      }
    }
    // ── Access preset assignment (issue #3, C3) ────────────────────────────
    // Optional: link the new user to a named access preset at the target org.
    // The area x level matrix only governs admin-tier roles (officers are field,
    // self-scoped), so a preset is only assigned to admin-tier users. Effective
    // grants resolve LIVE from the preset (link model, migration 0260), so preset
    // edits cascade. Non-fatal: a preset failure must not undo a created user.
    let presetAssigned = null;
    const ADMIN_TIER_ROLES = new Set([
      'grand_master',
      'master',
      'admin',
      'admin_officer'
    ]);
    if (access_preset_key && ADMIN_TIER_ROLES.has(role)) {
      try {
        // Resolve the preset by key: prefer an org-custom preset for the target
        // org, else fall back to the global (organization_id null) preset.
        const { data: presets } = await adminClient.from('access_presets').select('id, organization_id').eq('key', access_preset_key).or(`organization_id.eq.${targetOrgId},organization_id.is.null`);
        const chosen = (presets ?? []).sort((a, b)=>(a.organization_id ? 0 : 1) - (b.organization_id ? 0 : 1))[0];
        if (!chosen) {
          console.warn(`[create-user] access preset '${access_preset_key}' not found for org ${targetOrgId} or globally; skipping.`);
        } else {
          const { error: paErr } = await adminClient.from('preset_assignments').upsert({
            user_id: userId,
            preset_id: chosen.id,
            scope_org_id: targetOrgId,
            status: 'active',
            assigned_by: caller.id
          }, {
            onConflict: 'user_id,preset_id,scope_org_id'
          });
          if (paErr) console.error('[create-user] preset assignment failed (non-fatal):', JSON.stringify(paErr));
          else presetAssigned = access_preset_key;
        }
      } catch (presetErr) {
        console.error('[create-user] preset assignment error (non-fatal):', presetErr);
      }
    }
    console.log(`[create-user] onboarded ${email} as ${role} in org ${targetOrgId} (staff=${staffId ?? 'none'}, preauth=${!!preauthenticated}, preset=${presetAssigned ?? 'none'})`);
    return json({
      success: true,
      user_id: userId,
      staff_id: staffId,
      email,
      role,
      preauthenticated: !!preauthenticated,
      access_preset: presetAssigned
    });
  } catch (err) {
    console.error('[create-user] unexpected error:', err);
    return json({
      error: 'Internal error'
    }, 500);
  }
});
