export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
  return cleaned || 'photo';
}

export function evidenceStoragePath(organizationId: string, recordId: string, sha256: string, fileName: string): string {
  return `org/${organizationId}/record-evidence/${recordId}/${sha256.slice(0, 16)}-${safeFileName(fileName)}`;
}
