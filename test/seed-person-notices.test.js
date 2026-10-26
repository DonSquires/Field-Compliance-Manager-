const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/seed-person-notices.mjs');

test('parseLetterDate reads the common letter date shapes and rejects prose', async () => {
  const { parseLetterDate } = await load();
  assert.equal(parseLetterDate('9th July 2024'), '2024-07-09');
  assert.equal(parseLetterDate('Monday, the 3rd of June 2024'), '2024-06-03');
  assert.equal(parseLetterDate('June 3, 2024'), '2024-06-03');
  assert.equal(parseLetterDate('Date: 3/06/2024'), '2024-06-03');
  assert.equal(parseLetterDate('31 February 2024'), null);
  assert.equal(parseLetterDate('You were seen on 9th July 2024 in the forest near the gate'), null);
});

test('findPlate takes the plate after a registration cue and skips look-alikes', async () => {
  const { findPlate } = await load();
  assert.equal(findPlate('a vehicle registration ABC123 was seen'), 'ABC123');
  assert.equal(findPlate('vehicle rego 4WD XYZ9 parked'), 'XYZ9');
  assert.equal(findPlate('a 4WD with no plate seen in 2024'), null);
  assert.equal(findPlate('ABC123 was nearby'), null);
});

test('letterKind records letters as titled and reads the body only when the title is silent', async () => {
  const { letterKind } = await load();
  assert.deepEqual(letterKind('Sam Example warning letter.docx', 'please contact us'), { kind: 'warning', basis: 'title' });
  assert.deepEqual(letterKind('Sam Example trespass.docx', ''), { kind: 'trespass', basis: 'title' });
  assert.equal(letterKind('Sam Example DRAFT warning.docx', '').reason, 'draft_letter');
  assert.deepEqual(letterKind('Sam Example.docx', 'Your permit has been revoked.'), { kind: 'permit_refusal', basis: 'text' });
  assert.deepEqual(letterKind('Sam Example.docx', 'Please contact me on the number below.'), { kind: 'contact_request', basis: 'text' });
  assert.equal(letterKind('Sam Example.docx', 'Thank you.').reason, 'letter_type_not_read');
});

test('nameFromFileTitle keeps the person words and drops honorifics and document words', async () => {
  const { nameFromFileTitle } = await load();
  assert.deepEqual(nameFromFileTitle('SAM EXAMPLE warning letter - OFO.docx'), ['Sam', 'Example']);
  assert.deepEqual(nameFromFileTitle('Mr Example 2nd warning.docx'), ['Example']);
});

test('parseLetter reads addressee, address, date and plate; falls back to the created date', async () => {
  const { parseLetter } = await load();
  const text = ['R & M Security and Investigations Ltd', 'Sam Example', '1 Test Road', 'Testville 7000', '9th July 2024',
    'Dear Mr Example', 'Your vehicle registration ABC123 was seen. This is a formal warning not to enter.'].join('\n');
  const parsed = parseLetter({ text, title: 'Sam Example warning letter.docx', createdAt: '2024-07-10T00:00:00Z' });
  assert.equal(parsed.name, 'Sam Example');
  assert.equal(parsed.nameBasis, 'addressee');
  assert.equal(parsed.address, '1 Test Road, Testville 7000');
  assert.equal(parsed.issued, '2024-07-09');
  assert.equal(parsed.issuedBasis, 'document');
  assert.equal(parsed.plate, 'ABC123');
  assert.equal(parsed.kind, 'warning');

  const undated = parseLetter({ text: 'Dear Mr Example\nPlease contact me.', title: 'Sam Example.docx', createdAt: '2023-05-01T00:00:00Z' });
  assert.equal(undated.name, 'Sam Example');
  assert.equal(undated.nameBasis, 'file_title');
  assert.equal(undated.issued, '2023-05-01');
  assert.equal(undated.issuedBasis, 'document_created');
});

test('parseTrespassForm holds a form whose date cannot be read rather than inventing one', async () => {
  const { parseTrespassForm } = await load();
  const read = parseTrespassForm({ text: 'Notice under the Trespass Act 1980\nI hereby warn Sam Example to stay off\nDated this 3rd day of June 2024', title: 'form.pdf' });
  assert.equal(read.name, 'Sam Example');
  assert.equal(read.issued, '2024-06-03');
  assert.equal(read.reason, null);
  const unread = parseTrespassForm({ text: 'Notice under the Trespass Act 1980\nI hereby warn Sam Example to stay off\nDate: 27-01-', title: 'form.pdf' });
  assert.equal(unread.issued, null);
  assert.equal(unread.reason, 'date_not_read');
  assert.equal(parseTrespassForm({ text: 'Invoice', title: 'x.pdf' }).reason, 'not_a_trespass_notice');
});

test('parseRegisterRows reads the enquiry report with its own expiry and withdrawn status', async () => {
  const { parseRegisterRows } = await load();
  const rows = [
    ['Enquiry report'], [], [], [],
    ['ID', 'Type', 'Last Name', 'First Names', 'Issued', 'Issued', 'Expires', 'Status', 'Vehicle', 'Area(s)'],
    [12, 'Warning', 'EXAMPLE', 'SAM', new Date('2019-03-01T00:00:00Z'), 'Staff', new Date('2021-03-01T00:00:00Z'), 'Revoked', 'ABC123 : Blue ute', 'Test Forest'],
    ['', '', '', ''],
    [13, 'Other', 'SAMPLE', 'ALEX', new Date('2019-04-01T00:00:00Z'), '', null, 'Active', '', ''],
  ];
  const [first, second] = parseRegisterRows(rows, 'register.xlsx');
  assert.equal(first.name, 'Sam Example');
  assert.equal(first.kind, 'warning');
  assert.equal(first.status, 'withdrawn');
  assert.equal(first.issued, '2019-03-01');
  assert.equal(first.expires, '2021-03-01');
  assert.equal(first.plate, 'ABC123');
  assert.equal(first.area, 'Test Forest');
  assert.equal(first.reason, null);
  assert.equal(second.reason, 'register_type_not_read');
});

test('buildPlan drops duplicate text and letters that restate a register entry', async () => {
  const { buildPlan } = await load();
  const letter = (relative, text) => ({ sha256: relative, relative, method: 'docx', client: 'ofo', folder_kind: 'letters', text, createdAt: '2019-03-05T00:00:00Z' });
  const body = 'Sam Example\n1 Test Road\n2nd March 2019\nDear Mr Example\nThis is a warning.';
  const plan = await buildPlan([
    { sha256: 'reg', relative: 'register.xlsx', method: 'register', client: 'ofo' },
    letter('Sam Example warning letter.docx', body),
    letter('copy/Sam Example warning letter.docx', body),
    letter('Alex Sample warning letter.docx', 'Alex Sample\n2 Test Road\n2nd March 2019\nDear Mr Sample\nThis is a warning.'),
    { sha256: 'video', relative: 'clip.dav', excluded: 'cctv_video' },
  ], {
    readRegisterFile: async () => [{ source: 'ofo_register', register_id: 12, kind: 'warning', status: 'issued', name: 'Sam Example', nameBasis: 'register',
      issued: '2019-03-01', issuedBasis: 'register', expires: '2021-03-01', plate: null, reason: null }],
  });
  assert.deepEqual(plan.notices.map((notice) => notice.import_key).sort(), ['ofo-register:12', plan.notices.find((n) => n.name === 'Alex Sample').import_key].sort());
  assert.equal(plan.summary.excluded.duplicate_text, 1);
  assert.equal(plan.summary.excluded.duplicate_of_register, 1);
  assert.equal(plan.summary.excluded.cctv_video, 1);
  assert.match(plan.notices.find((n) => n.name === 'Alex Sample').import_key, /^rm-notice:[0-9a-f]{32}$/);
});

test('generated notice PL/pgSQL closes every IF block', async () => {
  const { noticesSql } = await load();
  const body = noticesSql([]).split('DO $seed$').slice(1).map((part) => part.split('$seed$')[0]).join('\n');
  const closes = (body.match(/\bEND IF;/g) || []).length;
  const opens = (body.match(/(?<![A-Z_])IF\b/g) || []).length - closes;
  assert.ok(opens > 0);
  assert.equal(opens, closes);
});

test('a person named with a vehicle they do not own is linked as an associated person through the governed RPC', async () => {
  const { noticesSql } = await load();
  const sql = noticesSql([]);
  assert.match(sql, /public\.record_vehicle_person\([\s\S]*'associated_person', 'other'/);
  assert.match(sql, /<> 'vehicle_registered_owner_at_notice'/);
  assert.doesNotMatch(sql, /INSERT INTO public\.entity_links/i);
  assert.match(sql, /'already_linked'/);
});
