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
  nzta_mvr_record: {
    label: 'NZTA Motor Vehicle Register query result',
    category: 'identity',
    credential_type: null,
    indicators: [/current details query results/i, /current registered person details/i, /registration details/i],
  },
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

function localDateTime(value) {
  const match = String(value || '').trim().match(
    /^(\d{1,2})[/. -](\d{1,2})[/. -](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{1,2}))?)?$/,
  );
  if (!match) return null;
  const date = isoDate(`${match[1]}/${match[2]}/${match[3]}`);
  if (!date) return null;
  if (!match[4]) return `${date}T12:00`;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function regexEscape(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePlateCandidate(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.length >= 3 && normalized.length <= 8 ? normalized : null;
}

function nztaPlateEvidence(rawText, variantIndex = 0) {
  const text = String(rawText || '').replace(/\r/g, '');
  const evidence = [];
  const add = (value, source) => {
    const normalized = normalizePlateCandidate(value);
    if (normalized) evidence.push({ value: normalized, source, variant_index: variantIndex });
  };
  for (const match of text.matchAll(/(?:^|\n)\s*(?:plate|registration plate|rego)(?!\s+type\b)\s*[:#-]?\s*([A-Z0-9 -]{3,12})/gim)) {
    add(match[1], 'labelled_plate');
  }
  for (const match of text.matchAll(/show\s+the\s+results\s+for\s+plate\s*\/?\s*vin\s*[:#-]?\s*(?:\n|\s)+([A-Z0-9-]{3,20})/gim)) {
    add(match[1], 'query_entry');
  }
  return evidence;
}

function resolveNztaPlateFromOcr(rawVariants) {
  const variants = (Array.isArray(rawVariants) ? rawVariants : [rawVariants]).map((value) => String(value || '')).filter(Boolean);
  const allEvidence = variants.flatMap((text, index) => nztaPlateEvidence(text, index));
  const plateType = variants.map((text) => labelled(text, ['plate type'], '[^\\n]{2,40}')).find(Boolean) || null;
  const standard = /\bstandard\b/i.test(String(plateType || ''));
  const byValue = new Map();
  for (const item of allEvidence) {
    const current = byValue.get(item.value) || { value: item.value, occurrences: 0, variants: new Set(), sources: new Set() };
    current.occurrences += 1;
    current.variants.add(item.variant_index);
    current.sources.add(item.source);
    byValue.set(item.value, current);
  }
  const candidates = [...byValue.values()].map((item) => {
    const standardShape = /^[A-Z]{3}\d{3}$/.test(item.value) || /^[A-Z]{2}\d{4}$/.test(item.value);
    const mixed = /[A-Z]/.test(item.value) && /\d/.test(item.value);
    const validShape = standard ? standardShape : mixed;
    const score = item.occurrences + item.variants.size + item.sources.size + (standardShape ? 2 : 0);
    return {
      value: item.value,
      occurrences: item.occurrences,
      variant_count: item.variants.size,
      source_kinds: [...item.sources].sort(),
      valid_shape: validShape,
      score,
    };
  }).sort((left, right) => right.score - left.score || right.occurrences - left.occurrences || left.value.localeCompare(right.value));
  const valid = candidates.filter((candidate) => candidate.valid_shape);
  const winner = valid[0] || null;
  const runnerUp = valid[1] || null;
  const verified = Boolean(winner
    && (winner.variant_count >= 2 || winner.source_kinds.length >= 2 || winner.occurrences >= 2)
    && (!runnerUp || winner.score > runnerUp.score));
  return {
    status: verified ? 'verified_candidate' : 'manual_review_required',
    value: verified ? winner.value : null,
    candidates,
    plate_type: plateType,
    rule: standard ? 'nz_standard_plate_shape_and_ocr_consensus' : 'mixed_alphanumeric_and_ocr_consensus',
  };
}

function extractIdentityFieldsConsensus(rawVariants, documentKind, requestedDefinition = null) {
  const variants = (Array.isArray(rawVariants) ? rawVariants : [rawVariants]).map((value) => String(value || '')).filter(Boolean);
  const fields = extractIdentityFields(variants[0] || '', documentKind, requestedDefinition);
  if (documentKind !== 'nzta_mvr_record') return { fields, identifier_verification: null };
  const plate = resolveNztaPlateFromOcr(variants);
  delete fields.plate_number;
  if (plate.value) fields.plate_number = plate.value;
  return {
    fields,
    identifier_verification: {
      plate_number: plate,
      authority: 'provisional_source_time',
      review_required: true,
    },
  };
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
  if (documentKind === 'nzta_mvr_record') {
    const title = text.match(/(?:^|\n)\s*((?:19|20)\d{2})\s+([A-Za-z][A-Za-z0-9-]*)\s+([A-Za-z][A-Za-z0-9-]*)(?:\s+([^\n]{2,40}))?/m);
    const queryDateTime = text.match(
      /current details query results[\s\S]{0,180}?(\d{1,2}[/. -]\d{1,2}[/. -]\d{2,4}\s+\d{1,2}:\d{2}(?::\d{1,2})?)/i,
    )?.[1] || text.match(/\b\d{1,2}[/. -]\d{1,2}[/. -]\d{2,4}\s+\d{1,2}:\d{2}(?::\d{1,2})?\b/)?.[0];
    const fields = {
      display_name: labelled(text, ['current registered person', 'registered person', 'person name'], '[^\\n]{2,120}'),
      plate_number: labelled(text, ['plate', 'registration plate', 'rego'], '[A-Z0-9 -]{2,12}'),
      vin: labelled(text, ['vin'], '[A-Z0-9 -]{8,24}'),
      query_completed_at: localDateTime(queryDateTime),
      vehicle_year: title?.[1] || labelled(text, ['year'], '\\d{4}'),
      vehicle_make: title?.[2] || labelled(text, ['make'], '[^\\n]{2,40}'),
      vehicle_model: title?.[3] || labelled(text, ['model'], '[^\\n]{2,60}'),
      vehicle_body_type: clean(title?.[4]) || labelled(text, ['vehicle type', 'body type'], '[^\\n]{2,60}'),
      vehicle_colour: labelled(text, ['colour', 'color'], '[^\\n]{2,40}'),
      chassis_number: labelled(text, ['chassis number', 'chassis no'], '[A-Z0-9 -]{4,30}'),
      engine_number: labelled(text, ['engine no', 'engine number'], '[A-Z0-9 -]{3,30}'),
      fuel_type: labelled(text, ['fuel type'], '[^\\n]{2,30}'),
      country_of_origin: labelled(text, ['country of origin', 'previous country'], '[^\\n]{2,60}'),
      registration_status: labelled(text, ['registration status'], '[^\\n]{2,30}'),
      rego_expiry: isoDate(labelled(text, ['licence expiry date', 'registration expiry'], DATE_PATTERN)),
      wof_expiry: isoDate(labelled(text, ['expiry date of last wof', 'wof expiry'], DATE_PATTERN)),
      cof_expiry: isoDate(labelled(text, ['expiry date of last cof', 'cof expiry'], DATE_PATTERN)),
      acquisition_date: isoDate(labelled(text, ['acquisition date'], DATE_PATTERN)),
      physical_address: labelled(text, ['physical address'], '[^\\n]{5,180}'),
      mailing_address: labelled(text, ['mailing address'], '[^\\n]{5,180}'),
      gross_vehicle_mass_kg: labelled(text, ['gross vehicle mass'], '[\\d, ]{2,12}'),
      cc_rating: labelled(text, ['cc rating'], '[\\d, ]{2,12}'),
      number_of_seats: labelled(text, ['no\\. of seats', 'number of seats'], '\\d{1,3}'),
      number_of_axles: labelled(text, ['no\\. of axles', 'number of axles'], '\\d{1,2}'),
      plate_type: labelled(text, ['plate type'], '[^\\n]{2,40}'),
      vehicle_usage: labelled(text, ['usage'], '[^\\n]{2,60}'),
      latest_odometer: labelled(text, ['latest odometer', 'prior odometer reading'], '[\\d, ]{2,20}'),
    };
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
  }
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

module.exports = {
  DOCUMENT_DEFINITIONS,
  classifyIdentityDocument,
  extractIdentityFields,
  extractIdentityFieldsConsensus,
  identityDocumentDefinition,
  isoDate,
  localDateTime,
  normalizePlateCandidate,
  nztaPlateEvidence,
  resolveNztaPlateFromOcr,
};
