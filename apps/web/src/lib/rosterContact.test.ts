import { describe, expect, it } from 'vitest';
import { contactPhoneHref, validateRosterContact } from './rosterContact';

describe('static roster contacts', () => {
  it('accepts a name, a phone, both, or neither', () => {
    expect(validateRosterContact('', '')).toBeNull();
    expect(validateRosterContact('Shift contact', '')).toBeNull();
    expect(validateRosterContact('', '03 555 1234')).toBeNull();
    expect(validateRosterContact('Shift contact', '+64 (0)3 555 1234 ext. 21')).toBeNull();
  });

  it('preserves extensions in phone links without appending them to the dialled number', () => {
    expect(contactPhoneHref('+64 (0)3 555 1234 ext. 21')).toBe('tel:+6435551234;ext=21');
    expect(contactPhoneHref('03 555 1234 x21')).toBe('tel:035551234;ext=21');
  });

  it('rejects invalid numbers and multiline or oversized names', () => {
    for (const phone of ['12', '123text', '+123+456', 'javascript:123', '123 x']) {
      expect(contactPhoneHref(phone)).toBeNull();
      expect(validateRosterContact('', phone)).toMatch(/valid contact phone/i);
    }
    expect(validateRosterContact('First\nSecond', '')).toMatch(/one line/i);
    expect(validateRosterContact('A'.repeat(121), '')).toMatch(/120/);
  });

  it('applies the same entered-digit limit as the database, including an optional trunk zero', () => {
    expect(contactPhoneHref('+64 (0)12345678901234567')).toBe('tel:+6412345678901234567');
    expect(contactPhoneHref('+64 (0)123456789012345678')).toBeNull();
  });
});
