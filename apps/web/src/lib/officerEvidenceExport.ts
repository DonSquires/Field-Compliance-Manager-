export function buildEvidenceExportFilename(displayName: string, generatedAt: string, exportId: string): string {
  const officer = displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'officer';
  const date = generatedAt.slice(0, 10);
  return `officer-activity-${officer}-${date}-${exportId.slice(0, 8)}.json`;
}

export function downloadEvidencePackage(packageText: string, filename: string): void {
  const blob = new Blob([packageText], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}