export interface ReportTableColumn {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

export type ReportBlock =
  | { kind: 'section'; title: string }
  | { kind: 'text'; text: string; size?: number; bold?: boolean }
  | { kind: 'table'; columns: ReportTableColumn[]; rows: string[][]; size?: number };

export {
  ACTIVITY_REPORT_VERSION,
  activityAccountingStatement,
  activityEmailSummary,
  humaniseCode,
  itemisedActivityBlocks,
  monthlyActivityBlocks,
  readActivityReport,
} from './report-activity-sections.mjs';
