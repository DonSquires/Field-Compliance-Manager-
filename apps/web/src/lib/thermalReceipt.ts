/**
 * thermalReceipt — pure formatting + ESC/POS byte generation for narrow
 * "infringement ticket" style receipt printers (58mm/80mm thermal). No
 * browser/hardware API here; see useThermalPrinter.ts for the Web Bluetooth
 * transport that sends these bytes to a real printer.
 */

export type ReceiptPaperWidth = '58mm' | '80mm';

/** Characters per line at the default (non-condensed) font on common thermal printers. */
export const RECEIPT_CHARS_PER_LINE: Record<ReceiptPaperWidth, number> = {
  '58mm': 32,
  '80mm': 48,
};

export interface NoticeReceiptData {
  orgName: string;
  noticeType: string;
  noticeNumber: string;
  issuedAtIso: string;
  subjectLabel: string;
  subjectValue: string;
  locationLabel: string;
  officerName: string;
  legalBasis?: string | null;
  fineAmount?: number | null;
  dueDateIso?: string | null;
  notes?: string | null;
  footerText?: string | null;
}

function wrapLine(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width) {
      if (current) lines.push(current);
      current = word.length > width ? word.slice(0, width) : word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function centerLine(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const totalPad = width - text.length;
  const left = Math.floor(totalPad / 2);
  return `${' '.repeat(left)}${text}`;
}

function divider(width: number, char = '-'): string {
  return char.repeat(width);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Not set';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Not set' : date.toLocaleString('en-NZ', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Renders the notice as plain text formatted for a narrow receipt width.
 * Safe to display in a <pre> preview or send as raw text to any printer
 * that accepts plain text (many WiFi/AirPrint receipt printers do).
 */
export function buildReceiptText(data: NoticeReceiptData, width: ReceiptPaperWidth = '58mm'): string {
  const cols = RECEIPT_CHARS_PER_LINE[width];
  const lines: string[] = [];
  lines.push(centerLine(data.orgName.toUpperCase(), cols));
  lines.push(centerLine(data.noticeType.replace(/_/g, ' ').toUpperCase(), cols));
  lines.push(divider(cols));
  lines.push(`No: ${data.noticeNumber}`);
  lines.push(`Date: ${formatDate(data.issuedAtIso)}`);
  lines.push(divider(cols));
  lines.push(`${data.subjectLabel}: ${data.subjectValue}`);
  wrapLine(`Location: ${data.locationLabel}`, cols).forEach((line) => lines.push(line));
  lines.push(`Officer: ${data.officerName}`);
  if (data.legalBasis) wrapLine(`Basis: ${data.legalBasis}`, cols).forEach((line) => lines.push(line));
  if (data.fineAmount != null) lines.push(`Amount: $${data.fineAmount.toFixed(2)}`);
  if (data.dueDateIso) lines.push(`Due: ${formatDate(data.dueDateIso)}`);
  if (data.notes) {
    lines.push(divider(cols));
    wrapLine(data.notes, cols).forEach((line) => lines.push(line));
  }
  if (data.footerText) {
    lines.push(divider(cols));
    wrapLine(data.footerText, cols).forEach((line) => lines.push(line));
  }
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

const ESC = 0x1b;
const GS = 0x1d;

class EscPosBuilder {
  private bytes: number[] = [];

  raw(...values: number[]): this {
    this.bytes.push(...values);
    return this;
  }

  text(value: string): this {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      this.bytes.push(code < 256 ? code : 0x3f); // '?' fallback for unsupported glyphs
    }
    return this;
  }

  line(value = ''): this {
    return this.text(value).raw(0x0a);
  }

  init(): this {
    return this.raw(ESC, 0x40);
  }

  align(mode: 'left' | 'center' | 'right'): this {
    const code = mode === 'center' ? 1 : mode === 'right' ? 2 : 0;
    return this.raw(ESC, 0x61, code);
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  feed(rows = 3): this {
    return this.raw(ESC, 0x64, rows);
  }

  /** Partial cut. Printers without a cutter simply ignore this command. */
  cut(): this {
    return this.raw(GS, 0x56, 1);
  }

  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/**
 * Builds real ESC/POS bytes for the notice, suitable for writing directly to
 * a Bluetooth SPP/BLE thermal printer's write characteristic.
 */
export function buildReceiptEscPos(data: NoticeReceiptData, width: ReceiptPaperWidth = '58mm'): Uint8Array {
  const cols = RECEIPT_CHARS_PER_LINE[width];
  const builder = new EscPosBuilder().init();

  builder.align('center').bold(true).line(data.orgName.toUpperCase()).bold(false);
  builder.line(data.noticeType.replace(/_/g, ' ').toUpperCase());
  builder.align('left').line(divider(cols));
  builder.line(`No: ${data.noticeNumber}`);
  builder.line(`Date: ${formatDate(data.issuedAtIso)}`);
  builder.line(divider(cols));
  builder.line(`${data.subjectLabel}: ${data.subjectValue}`);
  wrapLine(`Location: ${data.locationLabel}`, cols).forEach((line) => builder.line(line));
  builder.line(`Officer: ${data.officerName}`);
  if (data.legalBasis) wrapLine(`Basis: ${data.legalBasis}`, cols).forEach((line) => builder.line(line));
  if (data.fineAmount != null) builder.line(`Amount: $${data.fineAmount.toFixed(2)}`);
  if (data.dueDateIso) builder.line(`Due: ${formatDate(data.dueDateIso)}`);
  if (data.notes) {
    builder.line(divider(cols));
    wrapLine(data.notes, cols).forEach((line) => builder.line(line));
  }
  if (data.footerText) {
    builder.line(divider(cols));
    wrapLine(data.footerText, cols).forEach((line) => builder.line(line));
  }
  builder.feed(4).cut();
  return builder.build();
}
