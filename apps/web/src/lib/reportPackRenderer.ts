// Must equal rendererVersion in supabase/functions/generate-report-pack-pdf/index.ts
// and CURRENT_REPORT_PDF_RENDERER in supabase/functions/send-report-pack/index.ts.
// A PDF rendered by an older layout is hidden until it is regenerated, except
// for issued (sent) packs, whose frozen PDF is the record of what was sent.
export const CURRENT_REPORT_PDF_RENDERER = 'fcm-report-pack-pdf-lib-a4-v13';

export interface ReportPackPdfState {
  status: string;
  updated_at: string;
  pdf_path: string | null;
  pdf_source_updated_at: string | null;
  pdf_renderer_version: string | null;
}

export function isReportPackPdfCurrent(pack: ReportPackPdfState): boolean {
  return Boolean(pack.pdf_path
    && pack.pdf_source_updated_at === pack.updated_at
    && (pack.status === 'sent' || pack.pdf_renderer_version === CURRENT_REPORT_PDF_RENDERER));
}
