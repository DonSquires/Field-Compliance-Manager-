/**
 * Provision an unconfirmed Auth identity at the existing staff/profile UUID.
 * The caller must first verify administrator authority and the staff linkage.
 */
export async function ensureExistingStaffAuth(auth, id, email, metadata) {
  const found = await auth.getUserById(id);
  if (found.error && found.error.status !== 404 && found.error.code !== 'user_not_found') {
    throw new Error('The existing login could not be checked. No invitation was sent.');
  }
  let user = found.data?.user;
  if (!user) {
    const created = await auth.createUser({ id, email, email_confirm: false, user_metadata: metadata });
    if (created.error) throw new Error(`The staff login could not be created: ${created.error.message}`);
    user = created.data?.user;
  }
  if (!user || user.id !== id || user.email?.toLowerCase() !== email) {
    throw new Error('The login did not match the existing staff identity. No invitation was sent.');
  }
  if (user.last_sign_in_at || user.email_confirmed_at) {
    throw new Error('This login is already claimed. Use the normal email-change or password-reset flow.');
  }
  return user;
}
