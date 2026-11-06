/** Officer-facing words for a shift's service type; unknown types fall back to their readable key. */
const SERVICE_TYPE_LABELS: Record<string, { label: string; detail: string }> = {
  freedom_camping: { label: 'Freedom Camping Patrol', detail: 'Vehicle scans, breaches, and evidence' },
  static: { label: 'Site Guarding', detail: 'Site security and checkpoints' },
  static_guarding: { label: 'Site Guarding', detail: 'Site security and checkpoints' },
  mobile: { label: 'Mobile Compliance Patrol', detail: 'Field assignments and evidence' },
  rostered: { label: 'Rostered Field Work', detail: 'Assignment and evidence' },
  parking: { label: 'Parking Enforcement', detail: 'Vehicle compliance and enforcement' },
  noise_control: { label: 'Noise Control', detail: 'Assessment and response' },
  biosecurity_inspection: { label: 'Biosecurity Inspection', detail: 'Inspection evidence and notices' },
  smoke_complaint_ooh: { label: 'Smoke Complaint', detail: 'Out-of-hours complaint response' },
};

export function serviceTypeLabel(value: string): { label: string; detail: string } {
  return SERVICE_TYPE_LABELS[value] ?? { label: value.replaceAll('_', ' '), detail: 'Field assignment and evidence' };
}
