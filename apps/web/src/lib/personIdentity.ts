import { supabase } from './supabase';

export type MatchStrength = 'strong' | 'likely' | 'possible';

export interface PersonMatch {
  person_record_id: string;
  display_name: string | null;
  review_state: string;
  matched_name: string | null;
  match_basis: string;
  score: number;
  strength: MatchStrength;
  aliases: string[] | null;
  locality: string | null;
  origin: string | null;
  sighting_count: number;
}

export interface PersonAlias {
  id: string;
  alias: string;
  alias_kind: string;
  source: string;
  can_remove: boolean;
}

export interface PersonIdentitySummary {
  person_record_id: string;
  organization_id: string;
  display_name: string | null;
  review_state: string;
  verified: boolean;
  verified_at: string | null;
  origin: string | null;
  merged_into_person_record_id: string | null;
  pending_documents: number;
  approved_documents: number;
  has_face_reference: boolean;
  sighting_count: number;
  aliases: PersonAlias[];
  can_review: boolean;
  can_merge: boolean;
}

export interface FaceMatch {
  person_record_id: string;
  display_name: string | null;
  review_state: string;
  score: number;
  sighting_count: number;
  last_seen_at: string | null;
  thumbnail: string | null;
}

export interface ObservationPerson {
  mention_id: string | null;
  person_record_id: string;
  display_name: string | null;
  review_state: string;
  aliases: string[] | null;
  mention_role: string;
  status: 'unconfirmed' | 'confirmed' | 'dismissed' | string;
  basis: string | null;
  mention_text: string | null;
  is_identity_of_record: boolean;
  recorded_by_name: string | null;
  recorded_at: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  can_dismiss: boolean;
}

export interface DocumentKindOption {
  document_kind: string;
  display_name: string;
  category: string;
}

export interface NewPersonFields {
  display_name: string;
  date_of_birth?: string;
  phone?: string;
  email?: string;
  licence_number?: string;
  suburb?: string;
  city?: string;
  notes?: string;
  confirm_new_person?: boolean;
}

export const ALIAS_KINDS: Array<[string, string]> = [
  ['aka', 'Also known as'],
  ['preferred_name', 'Preferred name'],
  ['legal_name', 'Legal name'],
  ['previous_name', 'Previous name'],
  ['maiden_name', 'Maiden / birth name'],
  ['nickname', 'Nickname'],
];
export const ALIAS_KIND_LABEL: Record<string, string> = { ...Object.fromEntries(ALIAS_KINDS), merged_record: 'From merged record' };

export const MENTION_ROLES: Array<[string, string]> = [
  ['mentioned', 'Mentioned'],
  ['driver', 'Driver'],
  ['passenger', 'Passenger'],
  ['occupant', 'Occupant'],
  ['witness', 'Witness'],
  ['other', 'Other'],
];
export const MENTION_ROLE_LABEL: Record<string, string> = { ...Object.fromEntries(MENTION_ROLES), identity_of_record: 'Identity of record' };

const MATCH_BASIS_LABEL: Record<string, string> = {
  name_exact: 'same name',
  alias_exact: 'known alias',
  name_variant: 'similar name',
  name_similar: 'similar spelling',
  licence_number: 'same licence number',
  phone: 'same phone',
  email: 'same email',
  date_of_birth: 'same date of birth',
};

export const describeMatchBasis = (basis: string) =>
  basis.split('+').map((part) => MATCH_BASIS_LABEL[part] ?? part.replace(/_/g, ' ')).join(' + ');

export const reviewStateLabel = (state: string) =>
  state === 'verified' ? 'Verified' : state === 'rejected' ? 'Rejected' : state === 'draft' ? 'Draft' : 'Unverified';

export const isDuplicateError = (message: string | null | undefined) => Boolean(message?.startsWith('POSSIBLE_DUPLICATE'));

const clean = (fields: Partial<NewPersonFields>) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === 'boolean' ? value : Boolean(String(value ?? '').trim()))
    .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));

export const cleanPersonFields = (fields: Partial<NewPersonFields>) => clean(fields);

// ATLAS CALLS: find_person_matches
export async function findPersonMatches(organizationId: string, criteria: Partial<NewPersonFields>, excludePersonRecordId?: string | null, limit = 6) {
  const { data, error } = await supabase.rpc('find_person_matches', {
    p_organization_id: organizationId,
    p_name: criteria.display_name?.trim() || null,
    p_date_of_birth: criteria.date_of_birth || null,
    p_licence_number: criteria.licence_number?.trim() || null,
    p_phone: criteria.phone?.trim() || null,
    p_email: criteria.email?.trim() || null,
    p_exclude_person_record_id: excludePersonRecordId ?? null,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as PersonMatch[];
}

// ATLAS CALLS: get_person_identity_summary
export async function getPersonIdentitySummary(personRecordId: string) {
  const { data, error } = await supabase.rpc('get_person_identity_summary', { p_person_record_id: personRecordId });
  if (error) throw error;
  return data as PersonIdentitySummary | null;
}

// ATLAS CALLS: add_person_alias
export async function addPersonAlias(personRecordId: string, alias: string, aliasKind: string, notes?: string) {
  const { error } = await supabase.rpc('add_person_alias', { p_person_record_id: personRecordId, p_alias: alias.trim(), p_alias_kind: aliasKind, p_notes: notes?.trim() || null });
  if (error) throw error;
}

// ATLAS CALLS: retire_person_alias
export async function retirePersonAlias(aliasId: string, reason: string) {
  const { error } = await supabase.rpc('retire_person_alias', { p_alias_id: aliasId, p_reason: reason.trim() });
  if (error) throw error;
}

// ATLAS CALLS: get_person_face_matches
export async function getPersonFaceMatches(personRecordId: string) {
  const { data, error } = await supabase.rpc('get_person_face_matches', { p_person_record_id: personRecordId, p_limit: 8 });
  if (error) throw error;
  return (data ?? []) as FaceMatch[];
}

// ATLAS CALLS: merge_person_records
export async function mergePersonRecords(organizationId: string, sourceId: string, targetId: string, reason: string, displayName?: string | null) {
  const { data, error } = await supabase.rpc('merge_person_records', {
    p_organization_id: organizationId,
    p_source_person_record_id: sourceId,
    p_target_person_record_id: targetId,
    p_reason: reason.trim(),
    p_display_name: displayName?.trim() || null,
  });
  if (error) throw error;
  return data as { moved?: Record<string, number> } | null;
}

// ATLAS CALLS: get_observation_people
export async function getObservationPeople(observationId: string) {
  const { data, error } = await supabase.rpc('get_observation_people', { p_observation_id: observationId });
  if (error) throw error;
  return (data ?? []) as ObservationPerson[];
}

// ATLAS CALLS: record_observation_person_mention
export async function recordObservationPersonMention(input: {
  observationId: string;
  personRecordId?: string | null;
  personFields?: Partial<NewPersonFields> | null;
  role: string;
  basis: string;
  mentionText?: string;
}) {
  const { data, error } = await supabase.rpc('record_observation_person_mention', {
    p_observation_id: input.observationId,
    p_person_record_id: input.personRecordId ?? null,
    p_person_fields: input.personFields ? clean(input.personFields) : null,
    p_mention_role: input.role,
    p_basis: input.basis.trim(),
    p_mention_text: input.mentionText?.trim() || null,
  });
  if (error) throw error;
  return data as { mention_id: string; person_record_id: string; status: string };
}

// ATLAS CALLS: review_observation_person_mention
export async function reviewObservationPersonMention(mentionId: string, action: 'confirm' | 'dismiss', notes?: string, setIdentityOfRecord = false) {
  const { error } = await supabase.rpc('review_observation_person_mention', {
    p_mention_id: mentionId,
    p_action: action,
    p_notes: notes?.trim() || null,
    p_set_identity_of_record: setIdentityOfRecord,
  });
  if (error) throw error;
}

// ATLAS CALLS: get_identity_document_types
export async function getIdentityDocumentKinds() {
  const { data, error } = await supabase.rpc('get_identity_document_types');
  if (error) throw error;
  return ((data ?? []) as DocumentKindOption[]).filter((kind) => kind.category === 'identity' || kind.category === 'credential');
}

/**
 * Any member may submit ID evidence for a person they can see. The file goes to
 * the private identity-evidence bucket under the member's submission folder,
 * register_person_identity_submission records it, and bob-perceive-image
 * extracts a proposal that stays manual_review_required until an
 * administrator approves it in Users → Identity records.
 */
// ATLAS CALLS: register_person_identity_submission, bob-perceive-image
export async function submitPersonIdentityEvidence(input: { organizationId: string; personRecordId: string; documentKind: string; file: File }) {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('Sign in again to submit identity evidence.');
  const attachmentId = crypto.randomUUID();
  const safeName = input.file.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-180);
  const storagePath = `org/${input.organizationId}/identity/${userId}/submission-${input.personRecordId}/${attachmentId}-${safeName}`;
  const upload = await supabase.storage.from('identity-evidence').upload(storagePath, input.file, {
    contentType: input.file.type || 'application/octet-stream',
    upsert: false,
  });
  if (upload.error) throw upload.error;
  const registered = await supabase.rpc('register_person_identity_submission', {
    p_person_record_id: input.personRecordId,
    p_document_kind: input.documentKind,
    p_attachment_id: attachmentId,
    p_file_name: input.file.name,
    p_file_type: input.file.type || 'application/octet-stream',
    p_file_size_bytes: input.file.size,
    p_storage_path: storagePath,
  });
  if (registered.error) throw registered.error;
  const perception = await supabase.functions.invoke('bob-perceive-image', {
    body: {
      mode: 'person_identity_submission',
      attachment_id: attachmentId,
      organization_id: input.organizationId,
      person_record_id: input.personRecordId,
      document_kind: input.documentKind,
    },
  });
  if (perception.error || !perception.data?.success) {
    // The file is safely recorded; extraction can be retried by an administrator.
    return { attachmentId, extracted: false, faceCount: 0, message: perception.data?.error ?? perception.error?.message ?? 'Extraction did not complete' };
  }
  return { attachmentId, extracted: true, faceCount: Number(perception.data.face?.count ?? 0), message: null };
}
