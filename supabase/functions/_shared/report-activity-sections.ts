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
  | { kind: 'charts'; charts: Array<{ title: string; items: Array<{ label: string; value: number }> }> }
  | { kind: 'gallery'; photos: Array<{ ref: ReportPhotoRef; caption: string }> }
  | { kind: 'entry'; when: string; tags: string[]; title: string; lines: ReportEntryLine[]; photos: ReportPhotoRef[]; photoCount: number; tone: 'incident' | 'default' }
  | { kind: 'rich'; runs: Array<{ text: string; bold: boolean }>; style: 'heading' | 'bullet' | 'paragraph' };

export {
  ACTIVITY_REPORT_VERSION,
  INCIDENT_TYPE_LABELS,
  NO_PLACE_LABEL,
  PRIVILEGED_PHOTO,
  REVIEW_SECTIONS,
  ROUTINE_STATUS_WORDS,
  activityEmailSummary,
  activityLineKey,
  applyIncidentTriage,
  clientActivitySnapshot,
  clientReportTitle,
  confirmedIncidentCount,
  executiveSummaryBlocks,
  executiveSummaryMarkup,
  humaniseCode,
  incidentTypeLabel,
  isAdministrationLine,
  isIncidentLine,
  isInternalWorkLine,
  isNotableEvent,
  isObservationLine,
  isRoutineCheck,
  isRoutineLine,
  monthlyActivityBlocks,
  notableEventBlocks,
  observationCount,
  readActivityLines,
  readActivityReport,
  reportDate,
  reviewSectionCode,
  routineCheckRows,
  siteLogBlocks,
  summaryMarkup,
  textParagraphs,
} from './report-activity-sections.mjs';
