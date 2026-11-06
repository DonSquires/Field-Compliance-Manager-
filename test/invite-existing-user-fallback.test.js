const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const resend = read('supabase/functions/resend-invite/index.ts');
const updateEmail = read('supabase/functions/update-user-email/index.ts');
const ALREADY = /already \(been \)\?registered\|already exists/;

test('resend-invite: an already-registered login gets a set-password link instead of a 400', () => {
  const invite = resend.indexOf('inviteUserByEmail(authUser.user.email');
  const fallback = resend.indexOf('resetPasswordForEmail(authUser.user.email');
  const failure = resend.indexOf('if (sendError)');
  assert.ok(invite > 0 && fallback > invite && failure > fallback, 'fallback runs after the invite and before the error response');
  assert.match(resend, ALREADY);
  assert.match(resend, /inviteError\.code === 'email_exists'/);
  assert.match(resend.slice(fallback, failure), /redirectTo: `\$\{siteUrl\}\/auth\/callback`/);
  assert.match(resend, /delivery = 'password_setup_link'/);
  assert.match(resend, /success: true,\s*email: authUser\.user\.email,\s*delivery/);
  // caller authority still precedes any lookup or send
  assert.ok(resend.indexOf("'Forbidden: insufficient role'") < resend.indexOf('getUserById(user_id)'));
  assert.ok(resend.indexOf("'resolve_org_invitation'") < invite);
  assert.match(resend, /This person has already signed in/);
});

test('update-user-email: a corrected unclaimed address still receives a usable link', () => {
  const invite = updateEmail.indexOf('inviteUserByEmail(requested, {\n        data: {');
  const fallback = updateEmail.indexOf('resetPasswordForEmail(requested');
  assert.ok(invite > 0 && fallback > invite);
  assert.match(updateEmail, ALREADY);
  assert.match(updateEmail, /invitationDelivery = 'password_setup_link'/);
  assert.match(updateEmail, /invitation_resent: invitationResent, invitation_delivery: invitationDelivery \}\);/);
  // the claimed-login guard is intended validation and stays a 409
  assert.match(updateEmail, /return json\(\{ error: error instanceof Error \? error\.message : 'Staff login provisioning failed\.' \}, 409\);/);
});

test('bob-extract-document: no esm.sh target=deno builds that pull std node polyfills', () => {
  const extract = read('supabase/functions/bob-extract-document/index.ts');
  assert.doesNotMatch(extract, /target=deno(?!next)/);
  assert.doesNotMatch(extract, /deno\.land\/std@0\.177/);
  assert.match(extract, /from 'npm:jszip@3\.10\.1'/);
  assert.match(extract, /from 'npm:unpdf@0\.12\.1'/);
  assert.match(extract, /from 'npm:xlsx@0\.18\.5'/);
});
