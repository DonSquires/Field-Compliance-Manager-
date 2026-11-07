export function contactPhoneHref(value: string): string | null {
  const phone = value.trim();
  const match = phone.match(/^(\+?[(\d][\d ().-]*?)(?: *(?:ext\.?|x) *(\d+))?$/i);
  if (!match || phone.length > 50) return null;
  const diallingNumber = match[1].replace(/^(\+\d{1,3}) *\( *0 *\)/, '$1');
  const digits = diallingNumber.replace(/\D/g, '');
  const extension = match[2] ?? '';
  const enteredDigits = phone.replace(/\D/g, '').length;
  if (enteredDigits < 3 || enteredDigits > 20) return null;
  return `tel:${diallingNumber.startsWith('+') ? '+' : ''}${digits}${extension ? `;ext=${extension}` : ''}`;
}

export function validateRosterContact(name: string, phone: string): string | null {
  const trimmedName = name.trim();
  if (Array.from(trimmedName).length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmedName)) {
    return 'Contact name must be at most 120 characters on one line.';
  }
  if (phone.trim() && !contactPhoneHref(phone)) {
    return 'Enter a valid contact phone number, including any extension.';
  }
  return null;
}
