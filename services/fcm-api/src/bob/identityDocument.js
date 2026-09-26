const DATE_PATTERN = '(\\d{1,2}[/. -]\\d{1,2}[/. -]\\d{2,4}|\\d{4}[/. -]\\d{1,2}[/. -]\\d{1,2})';
const SECURITY_ENDORSEMENTS = [
  ['PSG', 'Personal guard'], ['CC', 'Crowd controller'], ['PRG', 'Property guard'],
  ['SC', 'Security consultant'], ['ST', 'Security technician'], ['RPA', 'Repossession agent'],
  ['PI', 'Private investigator'], ['MO', 'Monitoring officer'], ['CDDA', 'Confidential document destruction agent'],
];

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/^[\s:;-]+|[\s:;-]+$/g, '').trim();
}

function labelled(text, labels, pattern = '[^\\n]{2,80}') {
  for (const label of labels) {
    const match = new RegExp(`(?:^|\\n)\\s*${label}\\s*[:#-]?\\s*(${pattern})`, 'im').exec(text);
    if (match?.[1]) return clean(match[1]);
  }
  return null;
}

function isoDate(value) {
  if (!value) return null;
  const parts = String(value).trim().split(/[/. -]/).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  let [first, second, third] = parts;
  let year; let month; let day;
  if (first > 1900) [year, month, day] = [first, second, third];
  else [day, month, year] = [first, second, third < 50 ? 2000 + third : third < 100 ? 1900 + third : third];
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}

function extractIdentityFields(rawText, documentKind) {
  const text = String(rawText || '').replace(/\r/g, '');
  const surname = labelled(text, ['surname', 'family name', 'last name']);
  const givenNames = labelled(text, ['given names?', 'first names?']);
  const displayName = labelled(text, ['full name', 'name']) || clean([givenNames, surname].filter(Boolean).join(' ')) || null;
  const dateOfBirth = isoDate(labelled(text, ['date of birth', 'birth date', 'dob'], DATE_PATTERN));
  const expiryDate = isoDate(labelled(text, ['date of expiry', 'expiry date', 'expiry', 'expires?', 'valid to'], DATE_PATTERN));
  const issuedDate = isoDate(labelled(text, ['date of issue', 'issue date', 'issued'], DATE_PATTERN));
  let licenceNumber = labelled(text, ['licen[cs]e (?:no|number)', 'licen[cs]e', 'document (?:no|number)', 'card (?:no|number)'], '[A-Z0-9 -]{4,24}');
  if (!licenceNumber && documentKind === 'driver_licence') licenceNumber = (text.toUpperCase().match(/\b[A-Z]{2}\d{6}\b/) || [])[0] || null;
  if (!licenceNumber && documentKind === 'firearms_licence') licenceNumber = (text.toUpperCase().match(/\b[A-Z0-9]{6,12}\b/) || [])[0] || null;
  if (!licenceNumber && documentKind === 'security_licence') {
    licenceNumber = labelled(text, ['badge (?:no|number)', 'certificate of approval (?:no|number)', 'coa (?:no|number)'], '[A-Z0-9 -]{4,24}');
  }
  const address = labelled(text, ['address'], '[^\\n]{5,140}');
  const fields = { display_name: displayName, date_of_birth: dateOfBirth, expiry_date: expiryDate, issued_date: issuedDate, address };
  if (documentKind === 'driver_licence') fields.driver_licence_number = clean(licenceNumber) || null;
  else if (documentKind === 'firearms_licence') fields.firearms_licence_number = clean(licenceNumber) || null;
  else if (documentKind === 'security_licence') {
    fields.security_licence_number = clean(licenceNumber) || null;
    fields.security_licence_authority = /private security personnel|pspla/i.test(text) ? 'Private Security Personnel Licensing Authority' : null;
    fields.security_endorsements = SECURITY_ENDORSEMENTS.filter(([code]) => new RegExp(`\\b${code}\\b`, 'i').test(text)).map(([, label]) => label).join(', ') || null;
  }
  else fields.document_number = clean(licenceNumber) || null;
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
}

module.exports = { extractIdentityFields, isoDate };
