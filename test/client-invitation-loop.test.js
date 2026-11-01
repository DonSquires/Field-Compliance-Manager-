const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const migration = read('supabase/migrations/20260920050000_client_invitation_loop.sql');
const inviteOrg = read('supabase/functions/invite-org/index.ts');
const createUser = read('supabase/functions/create-user/index.ts');
const supabaseLib = read('apps/web/src/lib/supabase.ts');
const authContext = read('apps/web/src/context/AuthContext.tsx');
const loginPage = read('apps/web/src/pages/LoginPage.tsx');

test("a client's first user runs the client portal; only a platform subscriber or own-org bootstrap gets master", () => {
  assert.match(migration, /create or replace function public\.resolve_org_invitation\(p_target_organization_id uuid\)/);
  assert.match(migration, /v_profile\.role not in \('grand_master', 'master', 'admin'\)/);
  assert.match(migration, /'kind', 'client', 'role', 'client_admin'/);
  assert.match(migration, /a\.agreement_type = 'operational'[\s\S]{0,200}and public\.is_admin_for_org\(a\.provider_organization_id\)/);
  // reach = employer + branches + branches the actor is authorised at
  assert.match(migration, /public\.get_descendant_organizations\(coalesce\(v_profile\.employer_organization_id, v_profile\.organization_id\)\)/);
  assert.match(migration, /from public\.staff_branch_authorisations a where a\.user_id = v_actor and a\.status = 'active'/);
  // the owner seats a subscriber's master under the financial agreement only
  assert.match(migration, /if v_profile\.role = 'grand_master' then[\s\S]{0,300}a\.agreement_type = 'financial'[\s\S]{0,400}'kind', 'subscriber', 'role', 'master'/);
  assert.match(migration, /raise exception 'Not authorised to invite users for this organisation'/);
});

test('the first-user claim is service-role only, employs the user in their own organisation, and allows only the two first-user roles', () => {
  assert.match(migration, /if p_role not in \('master', 'client_admin'\) then raise exception/);
  assert.match(migration, /insert into public\.user_profiles \(id, organization_id, employer_organization_id, display_name, role, email\)\s+values \(p_user_id, p_org_id, p_org_id, p_display_name, p_role, p_email\)/);
  assert.match(migration, /revoke all on function public\.claim_first_org_user\(uuid, uuid, text, text, text\) from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.claim_first_org_user\(uuid, uuid, text, text, text\) to service_role;/);
});

test('acceptance is the invited user\'s own act, audited per agreement, and idempotent', () => {
  assert.match(migration, /create or replace function public\.accept_client_invitation\(\)/);
  assert.match(migration, /where a\.client_organization_id = v_profile\.organization_id\s+and a\.invitation_status = 'invited'/);
  assert.match(migration, /'client_invitation_accepted', 'service_agreements', u\.id/);
  assert.match(migration, /return jsonb_build_object\('accepted', v_accepted, 'organization_id', v_profile\.organization_id\)/);
  // prepare finds the branch-held agreement instead of minting one under the parent
  assert.match(migration, /WHERE provider_organization_id = ANY\(public\.get_descendant_organizations\(v_provider\)\) AND client_organization_id = v_account\.id AND agreement_type = 'operational'/);
  assert.match(migration, /CASE WHEN v_account\.parent_organization_id = ANY\(public\.get_descendant_organizations\(v_provider\)\) THEN v_account\.parent_organization_id ELSE v_provider END/);
});

test('invite-org takes authority and role from resolve_org_invitation, run as the caller', () => {
  assert.match(inviteOrg, /callerClient\.rpc\('resolve_org_invitation', \{\s*p_target_organization_id: targetOrgId\s*\}\)/);
  assert.match(inviteOrg, /const role = invitation\?\.role \?\? 'master';/);
  assert.match(inviteOrg, /p_role: role,/);
  assert.match(inviteOrg, /employer_organization_id: targetOrgId,/);
  assert.doesNotMatch(inviteOrg, /\.from\('service_agreements'\)\.select\('id, ends_on'\)/);
  assert.match(inviteOrg, /const CAN_INVITE_ORG = \[\s*'grand_master',\s*'master',\s*'admin',\s*'admin_officer'\s*\];/);
  // recovery stays owner-only
  assert.match(inviteOrg, /if \(callerProfile\.role !== 'grand_master'\) \{[\s\S]{0,600}'org_recovery_denied'/);
});

test("create-user: the client's administrator adds client users; provider staff are pointed at the client invitation", () => {
  assert.match(createUser, /const callerIsClientAdmin = callerProfile\?\.role === 'client_admin';/);
  assert.match(createUser, /if \(callerIsClientAdmin && !isClientRole\) return json\(/);
  assert.match(createUser, /if \(isClientRole && !callerIsClientAdmin && callerProfile\.role !== 'grand_master'\) return json\(/);
  assert.match(createUser, /Invite the client from Client Portfolios; their administrator then adds their people\./);
  assert.match(createUser, /const employerOrgId = isClientRole \? targetOrgId : employer_organization_id \?\? callerProfile\.employer_organization_id \?\? callerProfile\.organization_id;/);
  assert.match(createUser, /if \(!isClientRole && \(!employerOrg\.active \|\| !\['owner', 'service_provider'\]\.includes\(employerOrg\.organization_type\)\)\)/);
});

test('an invitation link lands on "set your password" and records acceptance once the password is set', () => {
  assert.match(supabaseLib, /export const initialAuthLinkType: AuthLinkType = typeof window !== 'undefined' \? readAuthLinkType\(window\.location\.hash\) : null;/);
  // read before createClient consumes the hash
  assert.ok(supabaseLib.indexOf('export const initialAuthLinkType') < supabaseLib.indexOf('export const supabase = createClient('));
  assert.match(authContext, /if \(event === 'SIGNED_IN' && initialAuthLinkType === 'invite' && session\?\.user\) \{/);
  assert.match(authContext, /setInvitation\(\{ organizationName: metadata\.organization_name \?\? null, roleLabel: metadata\.role_label \?\? null \}\);\s+setRecoveryMode\(true\);/);
  assert.match(authContext, /if \(invitation\) \{[\s\S]{0,300}supabase\.rpc\('accept_client_invitation'\)/);
  assert.match(loginPage, /Welcome to \$\{invitation\.organizationName \?\? 'Field Compliance Manager'\}/);
  assert.match(loginPage, /Choose a password to finish setting up your account; you will use it to sign in from now on\./);
  assert.match(loginPage, /invited \? 'Set password and continue'/);
});

test('resend-invite: authority is checked before anything about the target organisation is looked up; the provider may re-send its client\'s invitation', () => {
  const resend = read('supabase/functions/resend-invite/index.ts');
  assert.match(resend, /if \(!callerProfile \|\| !\(CAN_INVITE\.includes\(callerProfile\.role\) \|\| callerProfile\.role === 'client_admin'\)\)/);
  assert.match(resend, /const targetOrgId = targetProfile\?\.organization_id \?\? organization_id;/);
  assert.match(resend, /callerClient\.rpc\('resolve_org_invitation', \{ p_target_organization_id: targetOrgId \}\)/);
  // the pending scan comes after the authority block
  assert.ok(resend.indexOf("callerClient.rpc('resolve_org_invitation'") < resend.indexOf('const pending = [];'));
  assert.match(resend, /Nobody at this organisation is waiting for an invitation; they have already signed in\./);
  assert.match(resend, /This person has already signed in\. If they cannot get in, they can use "Forgot password" on the sign-in page\./);
  // the landing page reads these
  assert.match(resend, /role_label: ROLE_LABELS\[targetProfile\.role\] \?\? targetProfile\.role,/);
  assert.match(resend, /organization_name: targetOrg\?\.name \?\? 'Field Compliance Manager',/);
});

test("the client's administrator manages their own people from the client portal; provider staff never appear there", () => {
  const panel = read('apps/web/src/components/ClientPeoplePanel.tsx');
  const access = read('apps/web/src/lib/clientPortalAccess.ts');
  const deactivate = read('supabase/functions/deactivate-user/index.ts');
  const deactivation = read('supabase/migrations/20261102140000_rm_verified_only_operational_custody_consolidation.sql');
  assert.match(access, /if \(role === 'client_admin'\) pages\.add\('people'\);/);
  assert.match(panel, /\.eq\('organization_id', organizationId\)\.like\('role', 'client_%'\)/);
  assert.match(panel, /functions\.invoke\('create-user', \{ body: \{ email: form\.email\.trim\(\), display_name: form\.name\.trim\(\), role: form\.role, organization_id: organizationId \} \}\)/);
  assert.match(panel, /functions\.invoke\('deactivate-user', \{ body: \{ user_id: person\.id, action \} \}\)/);
  assert.match(panel, /Your service provider's staff never have accounts at your organisation; they see your places through the service agreement\./);
  // the administrator cannot remove their own access from here
  assert.match(panel, /const me = person\.id === currentUserId;/);
  // deactivation authority lives in the audited RPC; the Edge Function only relays the caller's request
  assert.match(deactivate, /userClient\.rpc\('set_user_deactivation'/);
  assert.match(deactivation, /v_actor\.role NOT IN \('grand_master', 'master', 'admin', 'admin_officer', 'client_admin'\)/);
  assert.match(deactivation, /IF v_actor\.role = 'client_admin' AND left\(v_target\.role, 7\) <> 'client_' THEN/);
  assert.match(deactivation, /IF v_actor\.role <> 'grand_master' AND v_target\.organization_id IS DISTINCT FROM v_actor\.organization_id THEN/);
});

test('when the client accepts, the person who invited them is told and the notification opens that Client Portfolio', () => {
  const notify = read('supabase/migrations/20260920070000_client_accepted_notifies_provider.sql');
  const resolver = read('apps/web/src/lib/notificationNavigation.ts');
  const shell = read('apps/web/src/shells/AdminShell.tsx');
  assert.match(notify, /'bob_self_memory', 'crm_client'\]\)\);/);
  assert.match(notify, /where l\.action = 'crm_client_invitation_prepared' and l\.target_id = v_row\.id/);
  assert.match(notify, /has accepted your invitation'/);
  assert.match(notify, /Finish the provider setup, then activate the account\./);
  assert.match(notify, /p_recipient_user_id => null, p_recipient_role => 'admin', p_link_page => 'crm'/);
  // an admin inviter is not told twice
  assert.match(notify, /if v_inviter is null or not exists \(select 1 from public\.user_profiles p where p\.id = v_inviter and p\.role = 'admin'\) then/);
  assert.match(resolver, /if \(notification\.category === 'crm_client' \|\| link === 'crm'\) return \{ kind: 'admin_crm_account', accountId \};/);
  assert.match(shell, /navigate\(destination\.accountId \? `\/admin\/crm\?account=\$\{encodeURIComponent\(destination\.accountId\)\}` : '\/admin\/crm'\);/);
});
