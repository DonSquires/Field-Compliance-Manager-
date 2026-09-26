const DATE_PATTERN = '(\\d{1,2}[/. -]\\d{1,2}[/. -]\\d{2,4}|\\d{4}[/. -]\\d{1,2}[/. -]\\d{1,2})';
const SECURITY_ENDORSEMENTS = [
  ['PSG', 'Personal guard'], ['CC', 'Crowd controller'], ['PRG', 'Property guard'],
  ['SC', 'Security consultant'], ['ST', 'Security technician'], ['RPA', 'Repossession agent'],
  ['PI', 'Private investigator'], ['MO', 'Monitoring officer'], ['CDDA', 'Confidential document destruction agent'],
];
const DOCUMENT_DEFINITIONS = Object.freeze({
  driver_licence: { label: 'Driver licence', category: 'identity', credential_type: 'drivers_licence', number_field: 'driver_licence_number', expiry_field: 'driver_licence_expiry', indicators: [/driver.?s? licen[cs]e/i] },
  firearms_licence: { label: 'Firearms licence', category: 'identity', credential_type: 'firearms_licence', number_field: 'firearms_licence_number', expiry_field: 'firearms_licence_expiry', indicators: [/firearms? licen[cs]e/i, /arms act/i] },
  security_licence: { label: 'Security licence / CoA', category: 'credential', credential_type: 'security_licence', number_field: 'security_licence_number', expiry_field: 'security_licence_expiry', indicators: [/certificate of approval/i, /private security personnel/i, /\bPSPLA\b/i] },
  warrant_of_appointment: { label: 'Warrant of appointment', category: 'warrant', credential_type: 'warrant_of_authority', activity: 'Appointed officer', indicators: [/warrant of appointment/i, /appointed (?:as|to)/i] },
  noise_control_warrant: { label: 'Noise control officer warrant', category: 'warrant', credential_type: 'noise_control_warrant', activity: 'Noise control officer', indicators: [/noise control officer/i, /resource management act/i] },
  parking_warrant: { label: 'Parking warden warrant', category: 'warrant', credential_type: 'warrant_of_authority', activity: 'Parking warden', indicators: [/parking warden/i, /land transport act/i] },
  freedom_camping_warrant: { label: 'Freedom camping officer warrant', category: 'warrant', credential_type: 'warrant_of_authority', activity: 'Freedom camping officer', indicators: [/freedom camping officer/i, /freedom camping act/i] },
  biosecurity_warrant: { label: 'Biosecurity officer warrant', category: 'warrant', credential_type: 'biosecurity_warrant', activity: 'Biosecurity officer', indicators: [/biosecurity officer/i, /biosecurity act/i] },
  passport: { label: 'Passport', category: 'identity', credential_type: null, indicators: [/passport/i] },
  national_id: { label: 'Other government ID', category: 'identity', credential_type: null, indicators: [/identity card/i, /government id/i] },
  person_photo: { label: 'Person reference photo', category: 'photo', credential_type: null, indicators: [] },
  other_identity: { label: 'Other identity evidence', category: 'other', credential_type: null, indicators: [] },
});

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

function datesIn(text) {
  return [...String(text || '').matchAll(new RegExp(DATE_PATTERN, 'g'))]
    .map((match) => isoDate(match[0]))
    .filter(Boolean);
}

function regexEscape(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function identityDocumentDefinition(documentKind, storedDefinition = null) {
  const fallback = DOCUMENT_DEFINITIONS[documentKind] || DOCUMENT_DEFINITIONS.other_identity;
  return storedDefinition ? { ...fallback, ...storedDefinition } : fallback;
}

function classifyIdentityDocument(rawText, requestedKind, requestedDefinition = null) {
  const text = String(rawText || '');
  const definitions = { ...DOCUMENT_DEFINITIONS };
  if (requestedDefinition) definitions[requestedKind] = requestedDefinition;
  const ranked = Object.entries(definitions)
    .map(([kind, definition]) => {
      const storedIndicators = Array.isArray(definition.extraction_rules?.indicators) ? definition.extraction_rules.indicators : [];
      const score = (definition.indicators || []).filter((indicator) => indicator.test(text)).length
        + storedIndicators.filter((indicator) => text.toLowerCase().includes(String(indicator).toLowerCase())).length;
      return { kind, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind));
  const detectedKind = ranked[0]?.kind || null;
  return {
    requested_kind: requestedKind,
    detected_kind: detectedKind,
    matches_requested_kind: !detectedKind || detectedKind === requestedKind,
    confidence: !detectedKind ? 'unknown' : ranked[0].score > 1 ? 'high' : 'review_required',
  };
}

function extractIdentityFields(rawText, documentKind, requestedDefinition = null) {
  const text = String(rawText || '').replace(/\r/g, '');
  const definition = identityDocumentDefinition(documentKind, requestedDefinition);
  const isWarrant = definition.category === 'warrant';
  const surname = labelled(text, ['surname', 'family name', 'last name']);
  const givenNames = labelled(text, ['given names?', 'first names?']);
  const displayName = labelled(text, ['full name', 'name', 'holder']) || clean([givenNames, surname].filter(Boolean).join(' ')) || null;
  const dateOfBirth = isoDate(labelled(text, ['date of birth', 'birth date', 'dob'], DATE_PATTERN));
  const expiryDate = isoDate(labelled(text, ['date of expiry', 'expiry date', 'expiry', 'expires?', 'valid to'], DATE_PATTERN));
  const issuedDate = isoDate(labelled(text, ['date of issue', 'issue date', 'issued'], DATE_PATTERN));
  let licenceNumber = labelled(text, [
    ...(Array.isArray(definition.extraction_rules?.number_labels) ? definition.extraction_rules.number_labels.map(regexEscape) : []),
    ...(isWarrant ? ['warrant (?:no|number)', 'appointment (?:no|number)'] : []),
    'licen[cs]e (?:no|number)', 'licen[cs]e', 'document (?:no|number)', 'card (?:no|number)'
  ], '[A-Z0-9 -]{4,24}');
  if (!licenceNumber && documentKind === 'driver_licence') licenceNumber = (text.toUpperCase().match(/\b[A-Z]{2}\d{6}\b/) || [])[0] || null;
  if (!licenceNumber && documentKind === 'firearms_licence') licenceNumber = (text.toUpperCase().match(/\b(?=[A-Z0-9]{6,12}\b)(?=[A-Z0-9]*\d)[A-Z0-9]+\b/) || [])[0] || null;
  if (!licenceNumber && documentKind === 'security_licence') {
    licenceNumber = labelled(text, ['badge (?:no|number)', 'certificate of approval (?:no|number)', 'coa (?:no|number)'], '[A-Z0-9 -]{4,24}');
    if (!licenceNumber) {
      const section = text.match(/(?:badge|certificate of approval|coa)(?:\s+(?:no|number))?[\s\S]{0,160}/i)?.[0] || '';
      licenceNumber = (section.toUpperCase().match(/\b(?=[A-Z0-9-]{6,24}\b)(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/) || [])[0] || null;
    }
    const licenceToken = String(licenceNumber || '').toUpperCase().match(/\b(?=[A-Z0-9-]{6,24}\b)(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/);
    if (licenceToken) licenceNumber = licenceToken[0];
  }
  if (!licenceNumber && isWarrant) {
    const section = text.match(/(?:warrant of appointment|warrant|appointment)(?:\s+(?:no|number))?[\s\S]{0,160}/i)?.[0] || '';
    licenceNumber = (section.toUpperCase().match(/\b(?=[A-Z0-9/-]{5,30}\b)(?=[A-Z0-9/-]*\d)[A-Z0-9]+(?:[/-][A-Z0-9]+)+\b/) || [])[0] || null;
  }
  const address = labelled(text, ['address'], '[^\\n]{5,140}');
  const fields = { display_name: displayName, date_of_birth: dateOfBirth, expiry_date: expiryDate, issued_date: issuedDate, address };
  if (documentKind === 'driver_licence') fields.driver_licence_number = clean(licenceNumber) || null;
  else if (documentKind === 'firearms_licence') fields.firearms_licence_number = clean(licenceNumber) || null;
  else if (documentKind === 'security_licence') {
    fields.security_licence_number = clean(licenceNumber) || null;
    fields.expiry_date = fields.expiry_date || datesIn(text).sort().at(-1) || null;
    fields.security_licence_authority = /private security personnel|pspla/i.test(text) ? 'Private Security Personnel Licensing Authority' : null;
    fields.security_endorsements = SECURITY_ENDORSEMENTS.filter(([code]) => new RegExp(`\\b${code}\\b`, 'i').test(text)).map(([, label]) => label).join(', ') || null;
  }
  else if (isWarrant) {
    fields.document_number = clean(licenceNumber) || null;
    fields.expiry_date = fields.expiry_date || datesIn(text).sort().at(-1) || null;
    fields.issuing_authority = labelled(text, ['issuing authority', 'issued by', 'appointing authority', 'appointed by']);
    fields.authorized_activities = definition.activity || definition.default_authorized_activities?.join(', ');
  }
  else fields.document_number = clean(licenceNumber) || null;
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
}

module.exports = { DOCUMENT_DEFINITIONS, classifyIdentityDocument, extractIdentityFields, identityDocumentDefinition, isoDate };
