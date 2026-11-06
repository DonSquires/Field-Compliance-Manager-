import { MAX_PHOTO_BYTES } from '../components/RecordEvidencePanel.helpers';
import { sha256Hex } from './importPreview';
import { supabase } from './supabase';

export const OFFICER_PHOTO_BUCKET = 'officer-record-photos';
export const OFFICER_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export interface OfficerPhotoTarget {
  kind: 'field_report' | 'incident';
  id: string;
  organizationId: string;
}
export interface OfficerPhotoReceipt {
  attachment_id: string;
  evidence_id: string;
  record_kind: OfficerPhotoTarget['kind'];
  record_id: string;
  organization_id: string;
  shift_id: string | null;
  sha256: string;
  storage_path: string;
  privacy_review_status: 'pending';
}

export function validateOfficerPhoto(file: File): void {
  if (!OFFICER_PHOTO_TYPES.includes(file.type)) throw new Error('Choose a JPEG, PNG, WebP or HEIC/HEIF photo.');
  if (!file.size || file.size > MAX_PHOTO_BYTES) throw new Error('Choose a non-empty photo up to 15 MB.');
  if (file.name.length > 255) throw new Error('Shorten the photo filename to 255 characters or fewer.');
}

export function officerPhotoPath(target: OfficerPhotoTarget, sha256: string): string {
  return `org/${target.organizationId}/officer-photos/${target.kind}/${target.id}/${sha256}`;
}

export function validateOfficerPhotoReceipt(
  value: unknown, target: OfficerPhotoTarget, sha256: string, shiftId: string | null,
): OfficerPhotoReceipt {
  const receipt = value as Partial<OfficerPhotoReceipt> | null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!receipt || !uuid.test(receipt.attachment_id ?? '') || !uuid.test(receipt.evidence_id ?? '')
    || receipt.record_kind !== target.kind || receipt.record_id !== target.id
    || receipt.organization_id !== target.organizationId || receipt.shift_id !== shiftId
    || receipt.sha256 !== sha256 || receipt.storage_path !== officerPhotoPath(target, sha256)
    || receipt.privacy_review_status !== 'pending') {
    throw new Error('Photo receipt was not confirmed. The report or incident is already saved; retry this photo only.');
  }
  return receipt as OfficerPhotoReceipt;
}

export async function attachOfficerPhoto(target: OfficerPhotoTarget, file: File, selectedAt: string): Promise<OfficerPhotoReceipt> {
  validateOfficerPhoto(file);
  const context = await supabase.rpc('officer_photo_target_context', {
    p_record_kind: target.kind, p_record_id: target.id,
  });
  const row = (context.data as Array<{ organization_id: string; shift_id: string | null }> | null)?.[0];
  if (context.error || !row || row.organization_id !== target.organizationId
    || !(row.shift_id === null || typeof row.shift_id === 'string')) {
    throw new Error('Photo access could not be confirmed. Your report or incident has not been changed.');
  }
  // Hash and upload exactly the original bytes; selection time is not a verified camera timestamp.
  const sha256 = await sha256Hex(await file.arrayBuffer());
  const path = officerPhotoPath(target, sha256);
  const upload = await supabase.storage.from(OFFICER_PHOTO_BUCKET).upload(path, file, {
    contentType: file.type, upsert: false,
  });
  if (upload.error && !(
    ('statusCode' in upload.error && String(upload.error.statusCode) === '409')
    || /already exists|duplicate/i.test(upload.error.message)
  )) throw new Error('Photo upload failed. The saved report or incident remains; retry this photo only.');
  const registration = await supabase.rpc('attach_officer_record_photo', {
    p_record_kind: target.kind, p_record_id: target.id, p_sha256: sha256,
    p_original_name: file.name, p_selected_at: selectedAt,
  });
  if (registration.error) {
    throw new Error('The original photo may be uploaded, but its attachment receipt was not confirmed. Retry this photo only; do not resubmit the report or incident.');
  }
  return validateOfficerPhotoReceipt(registration.data, target, sha256, row.shift_id);
}
