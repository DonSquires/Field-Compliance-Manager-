export function validatePhotoImportEnvironment({ apply, url, serviceRole, actorEmail, actorPassword }) {
  if (!url || !serviceRole) throw new Error('Supabase URL and service role are required for scoped photo matching');
  if (apply && (!actorEmail || !actorPassword)) {
    throw new Error('Apply requires RM_PHOTO_IMPORT_ACTOR_EMAIL and RM_PHOTO_IMPORT_ACTOR_PASSWORD');
  }
}