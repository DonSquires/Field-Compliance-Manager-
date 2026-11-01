export interface ReportTableColumn {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

export interface ReportPhotoRef {
  b: string;
  p: string;
}

export interface ReportEntryLine {
  label?: string;
  text: string;
}

export type ReportBlock =
  | { kind: 'section'; title: string }
  | { kind: 'subsection'; title: string; detail?: string }
  | { kind: 'text'; text: string; size?: number; bold?: boolean; muted?: boolean }
  | { kind: 'table'; columns: ReportTableColumn[]; rows: string[][]; size?: number }
  | { kind: 'metrics'; items: Array<{ label: string; value: string }> }
  | { kind: 'entry'; when: string; tags: string[]; title: string; lines: ReportEntryLine[]; photos: ReportPhotoRef[]; photoCount: number; tone: 'incident' | 'default' };

export {
  ACTIVITY_REPORT_VERSION,
  NO_PLACE_LABEL,
  activityEmailSummary,
  humaniseCode,
  isRoutineLine,
  monthlyActivityBlocks,
  readActivityLines,
  readActivityReport,
  reportDate,
  siteLogBlocks,
} from './report-activity-sections.mjs';
