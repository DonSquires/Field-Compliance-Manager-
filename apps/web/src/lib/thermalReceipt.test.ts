import { describe, expect, it } from 'vitest';
import { buildReceiptEscPos, buildReceiptText, RECEIPT_CHARS_PER_LINE } from './thermalReceipt';

const sample = {
  orgName: 'Nelson City Council',
  noticeType: 'infringement',
  noticeNumber: 'INF-20260913-0001',
  issuedAtIso: '2026-09-13T10:00:00.000Z',
  subjectLabel: 'Plate',
  subjectValue: 'ABC123',
  locationLabel: 'Tahunanui Beach Reserve car park',
  officerName: 'J. Smith',
  legalBasis: 'Freedom Camping Act 2011 s.20',
  fineAmount: 200,
  dueDateIso: '2026-10-11T00:00:00.000Z',
  notes: 'Vehicle observed overnight without a valid self-containment certificate.',
  footerText: 'Pay online or dispute within 28 days.',
};

describe('buildReceiptText', () => {
  it('formats a narrow 58mm receipt with all key fields', () => {
    const text = buildReceiptText(sample, '58mm');
    expect(text).toContain('NELSON CITY COUNCIL');
    expect(text).toContain('INFRINGEMENT');
    expect(text).toContain('INF-20260913-0001');
    expect(text).toContain('Plate: ABC123');
    expect(text).toContain('Amount: $200.00');
    expect(text).toContain('Freedom Camping Act 2011');
  });

  it('wraps long lines to the paper width instead of truncating silently', () => {
    const text = buildReceiptText(sample, '58mm');
    const lines = text.split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(RECEIPT_CHARS_PER_LINE['58mm']);
  });

  it('uses a wider column count for 80mm paper', () => {
    const narrow = buildReceiptText(sample, '58mm');
    const wide = buildReceiptText(sample, '80mm');
    expect(RECEIPT_CHARS_PER_LINE['80mm']).toBeGreaterThan(RECEIPT_CHARS_PER_LINE['58mm']);
    expect(narrow).not.toEqual(wide);
  });

  it('omits optional fields cleanly when absent', () => {
    const minimal = buildReceiptText({ ...sample, legalBasis: null, fineAmount: null, dueDateIso: null, notes: null, footerText: null }, '58mm');
    expect(minimal).not.toContain('Amount:');
    expect(minimal).not.toContain('Due:');
    expect(minimal).not.toContain('Basis:');
  });
});

describe('buildReceiptEscPos', () => {
  it('starts with the ESC/POS initialize command', () => {
    const bytes = buildReceiptEscPos(sample, '58mm');
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x40);
  });

  it('ends with a feed and partial-cut command', () => {
    const bytes = buildReceiptEscPos(sample, '58mm');
    const tail = Array.from(bytes.slice(-5));
    expect(tail).toContain(0x1d); // GS (cut command group)
    expect(tail).toContain(0x56); // V (cut)
  });

  it('includes the notice number and plate as raw ASCII bytes', () => {
    const bytes = buildReceiptEscPos(sample, '58mm');
    const asText = Array.from(bytes).map((code) => String.fromCharCode(code)).join('');
    expect(asText).toContain('INF-20260913-0001');
    expect(asText).toContain('ABC123');
  });

  it('produces different byte lengths for 58mm vs 80mm due to wrapping', () => {
    const narrowBytes = buildReceiptEscPos(sample, '58mm');
    const wideBytes = buildReceiptEscPos(sample, '80mm');
    expect(narrowBytes.length).not.toBe(wideBytes.length);
  });
});
