// Month-end activity report sections for the report-pack PDF.
// The data comes from public.build_agreement_activity_report (frozen into
// monthly_report_packs.data.activityReport and .activity_lines when the pack is
// generated). These helpers only lay the frozen snapshot out; they never query,
// recount or invent values, so the PDF says exactly what the governed snapshot says.

/**
 * @typedef {{ label: string, width: number, align?: 'left' | 'right' }} ReportTableColumn
 * @typedef {{ kind: 'section', title: string }} ReportSectionBlock
 * @typedef {{ kind: 'text', text: string, size?: number, bold?: boolean }} ReportTextBlock
 * @typedef {{ kind: 'table', columns: ReportTableColumn[], rows: string[][], size?: number }} ReportTableBlock
 * @typedef {ReportSectionBlock | ReportTextBlock | ReportTableBlock} ReportBlock
 */

export const ACTIVITY_REPORT_VERSION = 1;

const numberFormats = new Map();

/** @param {number} value @param {number} [digits] */
function fmt(value, digits = 0) {
  if (!numberFormats.has(digits)) numberFormats.set(digits, new Intl.NumberFormat('en-NZ', { maximumFractionDigits: digits }));
  return numberFormats.get(digits).format(value);
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/** @param {unknown} value @returns {Record<string, unknown>[]} */
function rows(value) {
  return Array.isArray(value) ? value.map(obj).filter((item) => item !== null) : [];
}

/** @param {unknown} value */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** @param {string} code */
export function humaniseCode(code) {
  const value = code.replaceAll('_', ' ').trim();
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

/**
 * Returns the frozen activity report from a monthly pack's data, or null for
 * packs generated before the activity report existed.
 * @param {unknown} data
 */
export function readActivityReport(data) {
  const report = obj(obj(data)?.activityReport);
  if (!report || report.version !== ACTIVITY_REPORT_VERSION || !obj(report.totals)) return null;
  return report;
}

/** @param {Record<string, unknown>} report */
function labeller(report) {
  const labels = obj(report.labels) ?? {};
  /** @param {string} dim @param {unknown} code */
  return (dim, code) => {
    const key = text(code);
    if (!key) return '';
    const label = text(obj(labels[dim])?.[key]);
    if (label) return label;
    if (dim === 'serviceLine' && key === 'none') return 'No source category';
    if (dim === 'module' && key === 'unknown') return 'Not specified';
    return humaniseCode(key);
  };
}

/** @param {string} title @returns {ReportSectionBlock} */
const section = (title) => ({ kind: 'section', title });
/** @param {string} value @param {number} [size] @returns {ReportTextBlock} */
const note = (value, size) => ({ kind: 'text', text: value, size });

/**
 * @param {Array<[string, number] | [string, number, 'right']>} columns
 * @param {string[][]} body
 * @param {number} [size]
 * @returns {ReportTableBlock}
 */
function table(columns, body, size) {
  return { kind: 'table', columns: columns.map(([label, width, align]) => ({ label, width, align: align ?? 'left' })), rows: body, size };
}

/**
 * "1 entry" / "3 entries": client-facing copy must not read "1 entries".
 * @param {unknown} value @param {string} one @param {string} many
 */
const counted = (value, one, many) => `${fmt(num(value))} ${num(value) === 1 ? one : many}`;
/** @param {unknown} value */
const hours = (value) => fmt(num(value), 2);
/** @param {unknown} value */
const km = (value) => fmt(num(value), 1);

/**
 * Summary sections for a monthly pack. Returns null when the pack has no
 * activity report so the caller can keep its legacy layout.
 * @param {unknown} data
 * @returns {ReportBlock[] | null}
 */
export function monthlyActivityBlocks(data) {
  const report = readActivityReport(data);
  if (!report) return null;
  const label = labeller(report);
  const totals = obj(report.totals) ?? {};
  /** @type {ReportBlock[]} */
  const blocks = [];

  blocks.push(section('Activity Summary'));
  const summary = [
    ['Recorded activity entries', fmt(num(totals.entries))],
    ['Places with recorded activity', fmt(num(totals.places))],
    ['Recorded work hours', hours(totals.hours)],
    ['Recorded travel (km)', km(totals.travelKm)],
    ['Photos attached', fmt(num(totals.photos))],
    ['Patrol visits', fmt(num(totals.patrolVisits))],
    ['Camera activations', fmt(num(totals.cameraActivations))],
    ['Observations', fmt(num(totals.observations))],
    ['Workshop work orders', fmt(num(totals.workOrders))],
  ];
  if (num(totals.unattributedEntries) > 0) summary.push(['Log entries without an attributed visit', fmt(num(totals.unattributedEntries))]);
  blocks.push(table([['Measure', 327], ['Recorded', 160, 'right']], summary));
  if (text(report.basis)) blocks.push(note(text(report.basis), 8));

  const categories = rows(report.categories);
  blocks.push(section('Activity by Category'));
  if (categories.length) {
    blocks.push(table(
      [['Category', 227], ['Entries', 65, 'right'], ['Hours', 65, 'right'], ['km', 65, 'right'], ['Photos', 65, 'right']],
      categories.map((row) => [label('category', row.code), fmt(num(row.entries)), hours(row.hours), km(row.km), fmt(num(row.photos))]),
    ));
  } else {
    blocks.push(note('No activity was recorded at the places covered by this agreement during the period.'));
  }

  const places = rows(report.byPlace);
  if (places.length) {
    blocks.push(section('Activity by Place'));
    blocks.push(table(
      [['Place', 140], ['Entries', 50, 'right'], ['Hours', 50, 'right'], ['km', 50, 'right'], ['Photos', 47, 'right'], ['Main activity', 150]],
      places.map((row) => {
        const mix = Object.entries(obj(row.categories) ?? {})
          .filter(([, count]) => num(count) > 0)
          .sort(([leftCode, left], [rightCode, right]) => num(right) - num(left) || leftCode.localeCompare(rightCode))
          .slice(0, 3)
          .map(([code, count]) => `${label('category', code)} ${fmt(num(count))}`)
          .join(', ');
        return [text(row.place) || 'Not place-specific', fmt(num(row.entries)), hours(row.hours), km(row.km), fmt(num(row.photos)), mix];
      }),
    ));
  }

  const pest = obj(report.pestControl) ?? {};
  blocks.push(section('Pest Control'));
  if (num(pest.entries) > 0) {
    blocks.push(note(`${counted(pest.entries, 'pest-control entry', 'pest-control entries')} · ${hours(pest.hours)} hours · ${km(pest.km)} km. Species counts are recorded entries, not a population estimate.`));
    const species = rows(pest.bySpecies);
    if (species.length) {
      blocks.push(table(
        [['Species', 187], ['Culls', 75, 'right'], ['Sightings', 75, 'right'], ['Other', 75, 'right'], ['Total', 75, 'right']],
        species.map((row) => [label('species', row.code), fmt(num(row.culls)), fmt(num(row.sightings)), fmt(num(row.other)), fmt(num(row.total))]),
      ));
    }
    const activities = rows(pest.byActivity);
    if (activities.length) {
      blocks.push(table(
        [['Pest-control activity', 287], ['Entries', 100, 'right'], ['Hours', 100, 'right']],
        activities.map((row) => [label('activity', row.code), fmt(num(row.entries)), hours(row.hours)]),
      ));
    }
    const equipment = rows(pest.byEquipment);
    if (equipment.length) {
      blocks.push(table(
        [['Traps, bait stations and equipment', 387], ['Entries', 100, 'right']],
        equipment.map((row) => [label('equipment', row.code), fmt(num(row.entries))]),
      ));
    }
    const ammunition = rows(pest.ammunition);
    if (ammunition.length) {
      blocks.push(table(
        [['Ammunition calibre', 287], ['Entries', 100, 'right'], ['Rounds recorded', 100, 'right']],
        ammunition.map((row) => [
          text(row.calibre) === 'unspecified' ? 'Calibre not recorded' : text(row.calibre) || 'Calibre not recorded',
          fmt(num(row.entries)),
          typeof row.rounds === 'number' ? fmt(row.rounds) : 'Not recorded',
        ]),
      ));
    }
  } else {
    blocks.push(note('No pest-control activity was recorded at the places covered by this agreement during the period.'));
  }

  for (const [key, title, empty] of /** @type {const} */ ([
    ['maintenance', 'Maintenance and Repairs', 'No maintenance or repair work was recorded during the period.'],
    ['manufacture', 'Manufacture and Fabrication', 'No manufacture or fabrication work was recorded during the period.'],
  ])) {
    const work = obj(report[key]) ?? {};
    const orders = obj(work.workOrders) ?? {};
    blocks.push(section(title));
    if (num(work.entries) > 0) {
      blocks.push(note(`${counted(work.entries, 'entry', 'entries')} · ${hours(work.hours)} hours · ${km(work.km)} km · workshop work orders: ${fmt(num(orders.completed))} completed, ${fmt(num(orders.open))} in progress or approved.`));
      const subjects = rows(work.bySubject);
      if (subjects.length) {
        blocks.push(table(
          [['Item worked on', 287], ['Entries', 100, 'right'], ['Hours', 100, 'right']],
          subjects.map((row) => [label('subject', row.code) || 'Not specified', fmt(num(row.entries)), hours(row.hours)]),
        ));
      }
    } else {
      blocks.push(note(empty));
    }
  }

  const observations = obj(report.observations) ?? {};
  blocks.push(section('Observations and Photos'));
  const modules = rows(observations.byModule);
  if (modules.length) {
    blocks.push(table(
      [['Observation type', 187], ['Observations', 100, 'right'], ['With photo', 100, 'right'], ['Photos', 100, 'right']],
      modules.map((row) => [label('module', row.module), fmt(num(row.entries)), fmt(num(row.withPhoto)), fmt(num(row.photos))]),
    ));
  } else {
    blocks.push(note('No observations were recorded at the places covered by this agreement during the period.'));
  }
  blocks.push(note(`Photos attached to patrol-log entries: ${fmt(num(observations.eventPhotos))}. Photos attached to observations: ${fmt(num(observations.photos))}.`, 9));
  return blocks;
}

/**
 * Short email summary: one headline sentence plus the category rows.
 * @param {unknown} data
 * @returns {{ headline: string, categories: string[][] } | null}
 */
export function activityEmailSummary(data) {
  const report = readActivityReport(data);
  if (!report) return null;
  const label = labeller(report);
  const totals = obj(report.totals) ?? {};
  return {
    headline: `${counted(totals.entries, 'recorded activity entry', 'recorded activity entries')} across ${counted(totals.places, 'place', 'places')} · ${hours(totals.hours)} hours · ${km(totals.travelKm)} km · ${counted(totals.photos, 'photo', 'photos')}.`,
    categories: rows(report.categories).map((row) => [label('category', row.code), fmt(num(row.entries)), hours(row.hours)]),
  };
}

/**
 * Plain-language statement that every in-scope record is accounted for.
 * @param {unknown} data
 * @returns {string[]}
 */
export function activityAccountingStatement(data) {
  const report = readActivityReport(data);
  const accounted = obj(report?.accountedFor);
  if (!accounted) return [];
  const statement = [
    `${counted(accounted.entries, 'recorded entry is', 'recorded entries are')} reported: ${counted(accounted.activityEvents, 'patrol-log entry', 'patrol-log entries')}, ${counted(accounted.observationsInScope, 'observation', 'observations')} and ${counted(accounted.workOrdersInScope, 'workshop work order', 'workshop work orders')}.`,
  ];
  if (num(accounted.mirrorEventsExcluded) > 0) statement.push(`${counted(accounted.mirrorEventsExcluded, 'automatic patrol-log copy of an observation was', 'automatic patrol-log copies of observations were')} excluded so no observation is counted twice.`);
  if (num(accounted.unclassified) > 0) statement.push(`${counted(accounted.unclassified, 'entry has', 'entries have')} no work type recorded and ${num(accounted.unclassified) === 1 ? 'is' : 'are'} shown as "Not yet classified".`);
  statement.push(num(accounted.notItemised) > 0
    ? `${counted(accounted.itemised, 'entry is', 'entries are')} itemised in the appendix; ${counted(accounted.notItemised, 'further entry is', 'further entries are')} included in every total but not itemised because of the appendix line limit.`
    : num(accounted.itemised) === 1 ? 'The 1 entry is itemised in the appendix.' : `All ${fmt(num(accounted.itemised))} entries are itemised in the appendix.`);
  statement.push(accounted.reconciled === true
    ? 'Reconciliation: entry, category and place totals agree with the records in scope.'
    : 'Reconciliation: totals did not agree with the records in scope when this snapshot was generated. Ask your provider to regenerate the report.');
  return statement;
}

/** @param {string} value */
function nzDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

/**
 * Itemised activity appendix built from monthly_report_packs.activity_lines.
 * @param {unknown} data
 * @param {unknown} activityLines
 * @returns {ReportBlock[]}
 */
export function itemisedActivityBlocks(data, activityLines) {
  const report = readActivityReport(data);
  if (!report) return [];
  const label = labeller(report);
  const document = obj(activityLines);
  const lines = document?.version === ACTIVITY_REPORT_VERSION ? rows(document.lines) : [];
  /** @type {ReportBlock[]} */
  const blocks = [section('Appendix: Itemised Activity')];
  if (!lines.length) {
    blocks.push(note(num(obj(report.totals)?.entries) > 0
      ? 'Itemised lines are not available for this report pack.'
      : 'No activity was recorded during the period, so there is nothing to itemise.'));
    return blocks;
  }
  blocks.push(note('One line per recorded entry, in date order (New Zealand time). Free-text notes, staff and vehicle details are not included.', 8));
  blocks.push(table(
    [['Date', 50], ['Place', 88], ['Category', 80], ['Detail', 161], ['Ref', 44], ['Hours', 34, 'right'], ['km', 30, 'right']],
    lines.map((line) => {
      const materials = rows(line.m).map((item) => {
        const quantity = typeof item.q === 'number' ? ` × ${fmt(item.q, 2)}` : '';
        const calibre = text(item.cal) && text(item.cal) !== 'unspecified' ? ` ${text(item.cal)}` : '';
        return `${label('material', item.t)}${calibre}${quantity}`;
      });
      const detail = [
        line.k === 'observation' ? 'Observation' : '',
        line.k === 'work_order' ? `Work order ${text(line.ws).replaceAll('_', ' ')}`.trim() : '',
        label('activity', line.a),
        label('subject', line.s),
        label('species', line.sp),
        label('equipment', line.eq),
        ...materials,
        num(line.ph) > 0 ? counted(line.ph, 'photo', 'photos') : '',
      ].filter(Boolean).join(' · ');
      return [
        nzDate(text(line.d)),
        text(line.p) || 'Not place-specific',
        label('category', line.c),
        detail || '—',
        text(line.j),
        num(line.h) > 0 ? hours(line.h) : '',
        num(line.km) > 0 ? km(line.km) : '',
      ];
    }),
    7.5,
  ));
  const notItemised = num(document?.notItemised);
  if (notItemised > 0) blocks.push(note(`${counted(notItemised, 'further entry is', 'further entries are')} included in the totals above but ${notItemised === 1 ? 'is' : 'are'} not itemised because of the appendix line limit.`, 8));
  return blocks;
}
