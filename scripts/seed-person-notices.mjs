#!/usr/bin/env node
/**
 * Seed R&M's historical trespass notices, warning letters, permit refusals and
 * contact requests into FCM under the confirmed owner rules.
 *
 * R&M's documents are the source of truth until R&M operate in FCM. Each notice
 * is filed under the landowner client organisation and linked to the shared
 * canonical person through the governed import_person_notice RPC: the NZTA
 * registered owner of the vehicle the notice names (family name must agree and
 * the notice's first given name must equal, be an initial of, or share a 3+
 * letter prefix with one of the owner's given names), a unique exact name, or a
 * new person verified by the notice itself. A person
 * named with a vehicle they did not own at the time (often a company vehicle)
 * is recorded against that vehicle as an associated person (record_vehicle_person).
 *
 *   --scan  inventory the R&M folders, hash every file and extract text locally
 *           (Word XML, PyMuPDF, tesseract in the local inference container).
 *   --plan  parse letters, the OFO register and trespass forms into notices;
 *           anything not read confidently is held with a reason.
 *   --apply call the RPC per notice (rolled back unless --commit).
 *
 * The cache, plan and report hold personal information and must live outside
 * the repository. Nothing is sent to an external service.
 */
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const BASE = process.env.RM_DOCUMENTS_ROOT || 'C:/Users/squir/R & M Security and Investigations/RemSec - Documents';
const CONTAINER = process.env.NZTA_OCR_CONTAINER || 'fcm-inference-laptop';
const RM_ORGANIZATION_ID = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
const IMPORT_ACTOR_ID = 'f1c00000-0000-4000-8000-000000000001';

export const CLIENTS = {
  ofo: { id: 'c48c1aaf-236b-417c-bbce-938c151662d6', name: 'OneFortyOne New Zealand', cue: /one\s*forty[\s-]*one|onefortyone|nelson management|\bofo\b/i },
  tpfl: { id: '74d7fcf1-106a-481f-a770-1589c8a0db6b', name: 'Tasman Pine Forests Limited', cue: /tasman pine|\btpfl\b/i },
  tdc: { id: '54ade19f-0bb7-45ca-a32d-2d87214c4e77', name: 'Tasman District Council', cue: /tasman district|\btdc\b/i },
  taylors: { id: 'cb2af45b-8743-4bfb-b57e-18c16503d4ac', name: 'Taylors Contracting', cue: /taylors contracting/i },
  wenita: { id: null, name: 'Wenita Forest Products', cue: /wenita/i },
  ernslaw: { id: null, name: 'Ernslaw One', cue: /ernslaw/i },
};
const isWithinRepo = (file) => {
  const relative = path.relative(path.resolve('.'), path.resolve(file));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

// [folder under the R&M documents root, client key or null to read the client from the text]
export const SOURCE_ROOTS = [
  ['Warning Letter OFO', 'ofo'], ['Warning Letters TDC', 'tdc'], ['Warning Letters TPFL', 'tpfl'],
  ['TPFL/TPFL Warning letters', 'tpfl'], ['Archive RemSec/TPFL/TPFL Warning letters', 'tpfl'],
  ['OFO/Trespass Notices and Warnings', 'ofo'], ['Archive RemSec/OFO/Trespass Notices and Warnings', 'ofo'],
  ['Photos/Ernslaw One/Warning Letters', 'ernslaw'], ['Photos/Ernslaw One/Trespass', 'ernslaw'],
  ['Archive RemSec/Photos/Ernslaw One/Warning Letters', 'ernslaw'], ['Archive RemSec/Photos/Ernslaw One/Trespass', 'ernslaw'],
  ['Photos/Wenita/Wenita/Warning Letters', 'wenita'], ['Photos/Wenita/Wenita/Trespass Notices', 'wenita'],
  ['Archive RemSec/Photos/Wenita/Wenita/Warning Letters', 'wenita'], ['Archive RemSec/Photos/Wenita/Wenita/Trespass Notices', 'wenita'],
  ['Taylors/Trespass Notices', 'taylors'],
  ['Trespass Notices', null], ['Archive RemSec/Trespass Notices', null],
  ['Archive RemSec/Admin - Susan/Trespass Notices', null], ['Archive RemSec/Admin - Susan/Warning Letters', null],
  ['Archive RemSec/Admin - Susan (old)/Trespass Notices', null], ['Archive RemSec/Admin - Susan (old)/Warning Letters', null],
];

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const EXCLUDED_EXTENSIONS = { '.dav': 'cctv_video', '.zip': 'archive', '.exe': 'program', '.doc': 'legacy_word_format' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr)\.?$/i;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const titleCase = (value) => value.toLowerCase().replace(/(^|[\s'-])([a-z\u00c0-\u024f])/g, (_, lead, letter) => lead + letter.toUpperCase());
const monthIndex = (name) => MONTHS.findIndex((month) => month.startsWith(name.toLowerCase().slice(0, 3)));
const isoDate = (year, month, day) => {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCMonth() !== month || year < 2005 || date > new Date()) return null;
  return date.toISOString().slice(0, 10);
};

/** A whole line that is just a letter date: "9th July 2024", "Monday, the 3rd of June 2024", "June 3, 2024", "3/06/2024". */
export function parseLetterDate(line) {
  const text = String(line ?? '').replace(/\s+/g, ' ').replace(/^date[d:]?\s*:?\s*/i, '').trim();
  if (text.length > 45) return null;
  let match = new RegExp(`^(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:day\\s+)?(?:of\\s+)?${MONTH},?\\s+(\\d{4})\\.?$`, 'i').exec(text);
  if (match) return isoDate(Number(match[3]), monthIndex(match[2]), Number(match[1]));
  match = new RegExp(`^(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\\s+)?${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\.?$`, 'i').exec(text);
  if (match) return isoDate(Number(match[3]), monthIndex(match[1]), Number(match[2]));
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(text);
  if (match) return isoDate(match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  return null;
}

const PLATE_CUE = /\b(registration|registered|rego|reg\.?|plate|number plate)\b/gi;
const NOT_A_PLATE = /^(\d+(WD|AM|PM|ST|ND|RD|TH|HR|HRS|KM|KG|MM)|NZ\d*|\d{4}|[A-Z]+)$/;

/** The vehicle plate a letter cites: the first plate-shaped token shortly after a registration cue. */
export function findPlate(text) {
  for (const cue of String(text ?? '').matchAll(PLATE_CUE)) {
    const window = text.slice(cue.index + cue[0].length, cue.index + cue[0].length + 90);
    for (const [token] of window.matchAll(/\b[A-Za-z0-9]{2,6}\b/g)) {
      const plate = token.toUpperCase();
      if (token !== plate || !/\d/.test(plate) || NOT_A_PLATE.test(plate)) continue;
      return plate;
    }
  }
  return null;
}

/** Letters retain their title; the text decides only when the title does not. */
export function letterKind(title, text) {
  const name = String(title ?? '').toLowerCase();
  if (/\bdraft\b/.test(name)) return { kind: null, reason: 'draft_letter' };
  if (/tres+pass|trespas/.test(name)) return { kind: 'trespass', basis: 'title' };
  if (/\bwar?n(ing|ed)?\b|\bwaring\b/.test(name)) return { kind: 'warning', basis: 'title' };
  if (/\brequest\b/.test(name)) return { kind: 'contact_request', basis: 'title' };
  const body = String(text ?? '').toLowerCase();
  if (/trespass act 1980|section 4 of the trespass/.test(body) && /hereby|warned? (you )?to stay off|you are (now )?trespassed/.test(body)) return { kind: 'trespass', basis: 'text' };
  if (/\bwarning\b|not to (re-?)?enter|not permitted to enter|do not enter|stay (off|out)/.test(body)) return { kind: 'warning', basis: 'text' };
  if (/permit/.test(body) && /(revok|cancel|refus|declin|not be (issued|granted|eligible)|ineligib|suspend|\bban)/.test(body)) return { kind: 'permit_refusal', basis: 'text' };
  if (/contact (me|us|the)|get in touch|\bring\b|\bphone\b/.test(body)) return { kind: 'contact_request', basis: 'text' };
  return { kind: null, reason: 'letter_type_not_read' };
}

const TITLE_STOP = /\b(warning|waring|warned|letter|information|request|permit|not|on|breach|hunting|explanation|draft|new|park|reference|locked|and|with|trespass\w*|tres+pass\w*)\b/i;

/** The person words of a file title such as "JOHN SMITH warning letter - OFO". */
export function nameFromFileTitle(fileName) {
  const base = path.basename(String(fileName ?? '')).replace(/\.[a-z0-9]+$/i, '').split(/\s+-\s+/)[0];
  const stop = TITLE_STOP.exec(base);
  const head = (stop ? base.slice(0, stop.index) : base).replace(/\b\d+(st|nd|rd|th)?\b/gi, ' ');
  return head.split(/\s+/).filter((token) => /^[A-Za-z\u00c0-\u024f'-]{2,}$/.test(token) && !HONORIFIC.test(token)).map(titleCase);
}

const HEADER_LINE = /r\s*&\s*m security|remsec|^e-?mail\b|^ph(one)?\b|^mob(ile)?\b|^cell\b|profession or industry|^p\.?\s?o\.?\s?box|^www\.|^private bag|investigations ltd/i;

/** Read the addressee, salutation, date, plate and type from a letter's paragraphs. */
export function parseLetter({ text, title, createdAt }) {
  const lines = String(text ?? '').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const dateIndex = lines.findIndex((line) => parseLetterDate(line));
  const dearIndex = lines.findIndex((line) => /^dear\b/i.test(line));
  const addresseeArea = lines.slice(0, dearIndex >= 0 ? dearIndex + 1 : lines.length);
  if (addresseeArea.some((line) => /name\s*(?:and|&)\s*address/i.test(line))) {
    return { name: null, nameBasis: null, address: null, issued: null, issuedBasis: null,
      plate: null, kind: null, reason: 'template_addressee' };
  }
  const blockEnd = Math.min(...[dateIndex, dearIndex, lines.length].filter((index) => index >= 0));
  let blockStart = 0;
  lines.slice(0, blockEnd).forEach((line, index) => { if (HEADER_LINE.test(line)) blockStart = index + 1; });
  const block = lines.slice(blockStart, blockEnd).filter((line) => !HEADER_LINE.test(line) && !/^(to|attention|attn)\s*:?$/i.test(line));
  const nameTokens = (line) => line.replace(/^(to|attn|attention)\s*:\s*/i, '').split(/\s+/).filter((token) => !HONORIFIC.test(token));
  const addresseeLine = block[0] && !/\d/.test(block[0]) && /^[A-Za-z\u00c0-\u024f .'-]+$/.test(block[0]) ? block[0] : null;
  const addressee = addresseeLine ? nameTokens(addresseeLine).map(titleCase) : [];
  const address = addresseeLine && block.length > 1 ? block.slice(1, 5).join(', ') : null;
  const dear = dearIndex >= 0 ? /^dear\s+(?:(mr|mrs|ms|miss|mx|dr)\.?\s+)?([A-Za-z\u00c0-\u024f'-]+(?:\s+[A-Za-z\u00c0-\u024f'-]+)?)/i.exec(lines[dearIndex]) : null;
  const salutation = dear && !/^(sir|madam|sirs|occupier|owner)$/i.test(dear[2]) ? { honorific: dear[1] ?? null, words: dear[2].split(/\s+/).map(titleCase) } : null;
  const fromTitle = nameFromFileTitle(title);

  let name = null;
  let nameBasis = null;
  if (addressee.length >= 2 && addressee.length <= 5) { name = addressee.join(' '); nameBasis = 'addressee'; }
  else if (fromTitle.length >= 2) { name = fromTitle.join(' '); nameBasis = 'file_title'; }
  else if (fromTitle.length === 1 && salutation?.honorific && salutation.words.at(-1).toLowerCase() !== fromTitle[0].toLowerCase()) {
    name = `${fromTitle[0]} ${salutation.words.at(-1)}`; nameBasis = 'file_title_and_salutation';
  } else if (salutation?.honorific) { name = `${titleCase(salutation.honorific)} ${salutation.words.at(-1)}`; nameBasis = 'salutation_only'; }
  else if (fromTitle.length === 1 && salutation && salutation.words.length >= 2) { name = salutation.words.join(' '); nameBasis = 'salutation'; }

  const letterDate = dateIndex >= 0 ? parseLetterDate(lines[dateIndex]) : null;
  const issued = letterDate ?? (createdAt ? createdAt.slice(0, 10) : null);
  return {
    name, nameBasis, address,
    issued, issuedBasis: letterDate ? 'document' : issued ? 'document_created' : null,
    plate: findPlate(lines.join('\n')),
    ...letterKind(title, lines.join('\n')),
  };
}

const FORM_NAME = /(?:^|\n)\s*(?:to|name|full name|person)\s*[:.]?\s*([A-Za-z][A-Za-z .'-]{3,40}?)\s*(?:\n|\bof\b|,|$)/i;
const WARN_NAME = /\bhereby\s+warn\s+(?:you,?\s+)?([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\b/;

/** Read a trespass notice form or letter. Handwriting is rarely read reliably, so most forms are held. */
export function parseTrespassForm({ text, title, createdAt }) {
  const body = String(text ?? '');
  if (!/trespass/i.test(body)) return { kind: null, reason: 'not_a_trespass_notice' };
  const match = WARN_NAME.exec(body) ?? FORM_NAME.exec(body);
  const raw = match?.[1]?.replace(/\s+/g, ' ').trim();
  const words = raw ? raw.split(' ').filter((token) => !HONORIFIC.test(token)) : [];
  const fromTitle = nameFromFileTitle(title);
  const name = words.length >= 2 ? words.map(titleCase).join(' ') : fromTitle.length >= 2 ? fromTitle.join(' ') : null;
  const dated = /dated\s+(?:this\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+day\s+of\s+([a-z]+),?\s+(\d{4})/i.exec(body);
  const lineDate = body.split('\n').map(parseLetterDate).find(Boolean);
  const issued = (dated ? isoDate(Number(dated[3]), monthIndex(dated[2]), Number(dated[1])) : null) ?? lineDate ?? null;
  return {
    kind: 'trespass', basis: 'form', name, nameBasis: words.length >= 2 ? 'form' : fromTitle.length >= 2 ? 'file_title' : null,
    issued, issuedBasis: issued ? 'document' : null, plate: findPlate(body), address: null,
    reason: !name ? 'name_not_read' : !issued ? 'date_not_read' : null,
    createdAt,
  };
}

export function detectClient(text) {
  const body = String(text ?? '').split('\n').filter((line) => !HEADER_LINE.test(line)).join('\n');
  const hits = Object.entries(CLIENTS).filter(([, client]) => client.cue.test(body)).map(([key]) => key);
  return hits.length === 1 ? hits[0] : null;
}

/** Rows of OFO's "Trespass Notice and Warnings Enquiry Report" and its "Trespass" sheet. */
export function parseRegisterRows(rows, sourceName) {
  const out = [];
  const headerIndex = rows.findIndex((row) => row.some((cell) => /^type$/i.test(String(cell ?? '').trim())) && row.some((cell) => /^last name$/i.test(String(cell ?? '').trim())));
  if (headerIndex >= 0) {
    const header = rows[headerIndex].map((cell) => String(cell ?? '').trim().toLowerCase());
    const col = (label, nth = 0) => header.reduce((found, value, index) => (value === label ? [...found, index] : found), [])[nth];
    for (const row of rows.slice(headerIndex + 1)) {
      const id = row[col('id')];
      if (typeof id !== 'number') continue;
      const type = String(row[col('type')] ?? '').trim().toLowerCase();
      const status = String(row[col('status')] ?? '').trim().toLowerCase();
      const issued = row[col('issued')] instanceof Date ? row[col('issued')].toISOString().slice(0, 10) : null;
      const expires = row[col('expires')] instanceof Date ? row[col('expires')].toISOString().slice(0, 10) : null;
      const vehicle = String(row[col('vehicle')] ?? '');
      out.push({
        source: 'ofo_register', register_id: id,
        kind: type === 'warning' ? 'warning' : type === 'trespass' ? 'trespass' : null,
        status: /revok|cancel|withdr|rescind/.test(status) ? 'withdrawn' : 'issued',
        name: [row[col('first names')], row[col('last name')]].map((part) => String(part ?? '').trim()).filter(Boolean).map(titleCase).join(' ') || null,
        nameBasis: 'register', issued, issuedBasis: 'register', expires,
        plate: /^\s*([A-Z0-9]{1,6})\s*:/.exec(vehicle)?.[1] ?? null,
        area: String(row[col('area(s)')] ?? '').trim() || null,
        reason: type !== 'warning' && type !== 'trespass' ? 'register_type_not_read' : !issued ? 'date_not_read' : null,
        sourceName,
      });
    }
    return out;
  }
  const sheetHeader = rows.findIndex((row) => /^name$/i.test(String(row[0] ?? '').trim()) && row.some((cell) => /date of issue/i.test(String(cell ?? ''))));
  if (sheetHeader >= 0) {
    const header = rows[sheetHeader].map((cell) => String(cell ?? '').trim().toLowerCase());
    const dateCol = header.findIndex((value) => /date of issue/.test(value));
    const particularsCol = header.findIndex((value) => /particulars/.test(value));
    rows.slice(sheetHeader + 1).forEach((row, offset) => {
      const name = String(row[0] ?? '').trim();
      if (!name) return;
      const particulars = String(row[particularsCol] ?? '').trim();
      const issued = row[dateCol] instanceof Date ? row[dateCol].toISOString().slice(0, 10) : parseLetterDate(String(row[dateCol] ?? ''));
      const kind = /warn/i.test(particulars) && !/trespass/i.test(particulars) ? 'warning' : 'trespass';
      out.push({
        source: 'ofo_trespass_sheet', row_number: sheetHeader + offset + 2, kind, status: 'issued',
        name: titleCase(name), nameBasis: 'register', issued, issuedBasis: 'register', expires: null,
        plate: findPlate(particulars), area: /\bin\s+([A-Z][\w' ]{2,40}?)(?:[.,]|$)/.exec(particulars)?.[1] ?? null,
        author: /issued by\s+(.+?)\s+for\b/i.exec(particulars)?.[1] ?? null,
        reason: name.split(/\s+/).length < 2 ? 'name_not_read' : !issued ? 'date_not_read' : null,
        sourceName,
      });
    });
  }
  return out;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((line, index) => {
    if (!line) return [];
    try { return [JSON.parse(line)]; } catch {
      throw new Error(`Invalid JSON in the local notice cache at line ${index + 1}`);
    }
  });
}

function docxText(file) {
  const xml = execFileSync('tar', ['-xOf', file, 'word/document.xml'], { maxBuffer: 1 << 26 }).toString('utf8');
  const decode = (value) => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const text = xml.split(/<\/w:p>/).map((paragraph) => decode((paragraph.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? [])
    .map((run) => run.replace(/<[^>]+>/g, '')).join('')).trim()).filter(Boolean).join('\n');
  let createdAt = null;
  try {
    const core = execFileSync('tar', ['-xOf', file, 'docProps/core.xml'], { maxBuffer: 1 << 20 }).toString('utf8');
    createdAt = /<dcterms:created[^>]*>([^<]+)</.exec(core)?.[1] ?? null;
  } catch { /* documents without core properties have no creation date */ }
  return { text, createdAt };
}

const PDF_HELPER = `
import json, sys, warnings
warnings.filterwarnings('ignore')
import pymupdf
doc = pymupdf.open(sys.argv[1])
pages = [page.get_text() for page in doc]
images = []
if sum(len(p.strip()) for p in pages) < 200:
    for i, page in enumerate(doc):
        if i >= 3: break
        out = f"{sys.argv[2]}/page-{i}.png"
        page.get_pixmap(dpi=200).save(out)
        images.append(out)
print(json.dumps({"text": "\\n".join(pages), "images": images}))
`;

async function ocr(file, slot) {
  const remote = `/tmp/notice-ocr-${process.pid}-${slot}${path.extname(file).toLowerCase()}`;
  await execFileAsync('docker', ['cp', file, `${CONTAINER}:${remote}`]);
  try {
    return (await execFileAsync('docker', ['exec', CONTAINER, 'tesseract', remote, 'stdout', '--psm', '4'], { encoding: 'utf8', maxBuffer: 1 << 24 })).stdout;
  } finally {
    await execFileAsync('docker', ['exec', '-u', 'root', CONTAINER, 'rm', '-f', remote]).catch(() => {});
  }
}

async function extract(file, slot) {
  const extension = path.extname(file).toLowerCase();
  if (EXCLUDED_EXTENSIONS[extension]) return { excluded: EXCLUDED_EXTENSIONS[extension] };
  if (extension === '.xlsx') return { method: 'register' };
  if (extension === '.docx') return { method: 'docx', ...docxText(file) };
  if (IMAGE_EXTENSIONS.has(extension)) return { method: 'ocr', text: await ocr(file, slot) };
  if (extension === '.pdf') {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'notice-pdf-'));
    try {
      const result = JSON.parse(execFileSync('python', ['-c', PDF_HELPER, file, temp], { encoding: 'utf8', maxBuffer: 1 << 26 }));
      if (result.images.length === 0) return { method: 'pdf_text', text: result.text };
      const pages = [];
      for (const image of result.images) pages.push(await ocr(image, slot));
      return { method: 'pdf_ocr', text: pages.join('\n') };
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  return { excluded: 'unsupported_format' };
}

async function runScan({ cache, workers }) {
  const done = new Set(readJsonLines(cache).map((entry) => entry.sha256));
  const seen = new Map();
  for (const [folder, client] of SOURCE_ROOTS) {
    for (const file of walk(path.join(BASE, folder))) {
      if (path.basename(file).startsWith('~$')) continue;
      const hash = sha256(readFileSync(file));
      const relative = path.relative(BASE, file).replaceAll('\\', '/');
      if (seen.has(hash)) { seen.get(hash).copies.push(relative); continue; }
      seen.set(hash, { sha256: hash, file, relative, copies: [], client, folder_kind: /trespass/i.test(folder) ? 'trespass' : 'letter' });
    }
  }
  const queue = [...seen.values()].filter((entry) => !done.has(entry.sha256));
  let finished = 0;
  let failed = 0;
  const work = async (slot) => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const { file, ...record } = entry;
      try { Object.assign(record, await extract(file, slot)); } catch (error) { record.error = String(error.message).slice(0, 200); failed += 1; }
      record.extension = path.extname(file).toLowerCase();
      appendFileSync(cache, `${JSON.stringify(record)}\n`);
      finished += 1;
      if (finished % 20 === 0) console.log(`scan ${finished}/${seen.size - done.size} failed=${failed}`);
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, slot) => work(slot)));
  return { sources: seen.size, extracted: finished, failed, previously_cached: done.size };
}

async function readRegister(file) {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  return workbook.worksheets.flatMap((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: true }, (row, number) => {
      rows[number - 1] = row.values.slice(1).map((cell) => (cell && typeof cell === 'object' && !(cell instanceof Date) ? cell.result ?? cell.text ?? null : cell));
    });
    return parseRegisterRows(Array.from(rows, (row) => row ?? []), path.basename(file));
  });
}

const normaliseText = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const surnameOf = (name) => String(name ?? '').toLowerCase().split(/[^\p{L}]+/u).filter((token) => token.length >= 2).at(-1) ?? null;
const KIND_TITLES = { warning: 'Warning letter', trespass: 'Trespass notice', permit_refusal: 'Permit refusal letter', contact_request: 'Contact request letter' };

export async function buildPlan(entries, { readRegisterFile = readRegister } = {}) {
  const notices = [];
  const held = [];
  const excluded = {};
  const textSeen = new Set();
  for (const entry of entries) {
    if (entry.excluded) { excluded[entry.excluded] = (excluded[entry.excluded] ?? 0) + 1; continue; }
    const source = { sha256: entry.sha256, relative: entry.relative, copies: entry.copies?.length ?? 0 };
    if (entry.error) { held.push({ ...source, reason: 'extraction_failed' }); continue; }
    if (entry.method === 'register') {
      const rows = await readRegisterFile(path.join(BASE, entry.relative));
      if (rows.length === 0) { excluded.empty_register = (excluded.empty_register ?? 0) + 1; continue; }
      for (const row of rows) {
        const key = row.source === 'ofo_register' ? `ofo-register:${row.register_id}` : `ofo-trespass-sheet:${row.name?.toLowerCase()}:${row.issued}`;
        const notice = { ...source, ...row, client: entry.client ?? 'ofo', import_key: key, title: row.source === 'ofo_register' ? `OFO trespass and warning register #${row.register_id}` : 'OFO trespass sheet' };
        (row.reason ? held : notices).push(notice);
      }
      continue;
    }
    const text = String(entry.text ?? '');
    if (entry.method === 'ocr' && text.replace(/\s/g, '').length < 60) { excluded.photo_without_text = (excluded.photo_without_text ?? 0) + 1; continue; }
    const textKey = sha256(normaliseText(text)).slice(0, 32);
    if (textSeen.has(textKey)) { excluded.duplicate_text = (excluded.duplicate_text ?? 0) + 1; continue; }
    textSeen.add(textKey);
    const title = path.basename(entry.relative);
    const isForm = entry.folder_kind === 'trespass' && entry.method !== 'docx';
    const parsed = isForm ? parseTrespassForm({ text, title, createdAt: entry.createdAt }) : parseLetter({ text, title, createdAt: entry.createdAt });
    const client = entry.client ?? detectClient(text);
    const notice = {
      ...source, source: isForm ? 'trespass_form' : 'letter', ...parsed, status: 'issued', expires: null,
      client, import_key: `rm-notice:${textKey}`, title: KIND_TITLES[parsed.kind] ?? null,
    };
    const reason = parsed.reason ?? (!client ? 'client_not_read' : !parsed.kind ? 'letter_type_not_read' : !parsed.name ? 'name_not_read' : !parsed.issued ? 'date_not_read' : null);
    (reason ? held : notices).push({ ...notice, reason });
  }

  // A letter that restates a register entry (same client, type and surname within three weeks) is the same notice.
  const registered = notices.filter((notice) => notice.source === 'ofo_register' || notice.source === 'ofo_trespass_sheet');
  const unique = notices.filter((notice) => {
    if (notice.source === 'ofo_register' || notice.source === 'ofo_trespass_sheet') return true;
    const twin = registered.find((row) => row.client === notice.client && row.kind === notice.kind && surnameOf(row.name) === surnameOf(notice.name)
      && Math.abs(Date.parse(row.issued) - Date.parse(notice.issued)) <= 21 * 86400000);
    if (twin) excluded.duplicate_of_register = (excluded.duplicate_of_register ?? 0) + 1;
    return !twin;
  });
  const seenKeys = new Set();
  const final = unique.filter((notice) => !seenKeys.has(`${notice.client}|${notice.import_key}`) && seenKeys.add(`${notice.client}|${notice.import_key}`));
  const count = (rows, field) => rows.reduce((counts, row) => ({ ...counts, [row[field] ?? 'none']: (counts[row[field] ?? 'none'] ?? 0) + 1 }), {});
  return {
    summary: {
      sources: entries.length,
      notices: final.length,
      by_client: count(final, 'client'), by_kind: count(final, 'kind'), by_source: count(final, 'source'),
      name_basis: count(final, 'nameBasis'), issued_basis: count(final, 'issuedBasis'),
      with_plate: final.filter((notice) => notice.plate).length,
      held: held.length, held_reasons: count(held, 'reason'), excluded,
    },
    notices: final, held,
  };
}

const dollarQuote = (json, tag) => {
  if (json.includes(`$${tag}$`)) throw new Error('Seed data must not contain its SQL delimiter');
  return `$${tag}$${json}$${tag}$::jsonb`;
};
const uuidFrom = (value) => {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const CLAIMS = `set local request.jwt.claim.sub = '${IMPORT_ACTOR_ID}';
set local request.jwt.claims = '{"sub":"${IMPORT_ACTOR_ID}","role":"authenticated"}';`;

/** Ensure missing client organisations through the CRM path, then import each notice in its own savepoint. */
export function noticesSql(notices) {
  const clients = Object.entries(CLIENTS).map(([key, client]) => ({ key, id: client.id, name: client.name, request_id: uuidFrom(`rm-notice-client|${key}`) }));
  const rows = notices.map((notice) => ({
    import_key: notice.import_key, client: notice.client, kind: notice.kind, status: notice.status ?? 'issued',
    issued: notice.issued, expires: notice.expires ?? null, name: notice.name, plate: notice.plate ?? null,
    address: notice.address ?? null, area: notice.area ?? null, title: notice.title ?? null, author: notice.author ?? null,
    notice_number: notice.register_id != null ? `OFO-${notice.register_id}` : null,
    legal_basis: notice.kind === 'trespass' ? 'Trespass Act 1980 s4' : null,
    issued_basis: notice.issuedBasis === 'register' ? 'register' : notice.issuedBasis === 'document_created' ? 'document_created' : 'document',
    document_name: path.basename(notice.relative), reference: `local://rm/remsec-documents/${notice.relative}`, sha: notice.sha256,
  }));
  return `CREATE TEMP TABLE IF NOT EXISTS notice_seed_results (import_key text, outcome text, match_basis text, canonical_person_id uuid, error text,
  vehicle_link text);
DO $seed$
DECLARE
  v_client jsonb;
  v_ids jsonb := '{}'::jsonb;
  v_id uuid;
  v_row jsonb;
  v_result jsonb;
  v_vehicle uuid;
  v_person_record uuid;
  v_link text;
BEGIN
  FOR v_client IN SELECT * FROM jsonb_array_elements(${dollarQuote(JSON.stringify(clients), 'seed_clients')}) LOOP
    v_id := nullif(v_client->>'id', '')::uuid;
    IF v_id IS NULL THEN
      SELECT o.id INTO v_id FROM public.organizations o
      WHERE o.parent_organization_id = '${RM_ORGANIZATION_ID}'::uuid AND lower(o.name) = lower(v_client->>'name') LIMIT 1;
    END IF;
    IF v_id IS NULL THEN
      SELECT (public.manage_crm_organization((v_client->>'request_id')::uuid, NULL, NULL, 'create', v_client->>'name', 'client',
        p_account_notes => 'Landowner client created for the R&M historical notice import.')).id INTO v_id;
    END IF;
    v_ids := v_ids || jsonb_build_object(v_client->>'key', v_id);
  END LOOP;
  FOR v_row IN SELECT * FROM jsonb_array_elements(${dollarQuote(JSON.stringify(rows), 'seed_notices')}) LOOP
    BEGIN
      v_result := public.import_person_notice(
        (v_ids->>(v_row->>'client'))::uuid, v_row->>'kind', v_row->>'status', (v_row->>'issued')::date::timestamp AT TIME ZONE 'Pacific/Auckland',
        v_row->>'name', v_row->>'document_name', v_row->>'reference', v_row->>'sha', v_row->>'import_key',
        p_expires_at => ((v_row->>'expires')::date::timestamp AT TIME ZONE 'Pacific/Auckland'),
        p_plate_number => v_row->>'plate', p_subject_address => v_row->>'address', p_notice_number => v_row->>'notice_number',
        p_legal_basis => v_row->>'legal_basis', p_area => v_row->>'area', p_title => v_row->>'title',
        p_source_author => v_row->>'author', p_issued_date_basis => v_row->>'issued_basis');
      v_link := NULL;
      -- Owner ruling 2026-10-27: a person named on a notice with a vehicle they do not own (often a company
      -- vehicle) is recorded against that vehicle as an associated person, through the governed path.
      IF v_row->>'plate' IS NOT NULL AND v_result->>'canonical_person_id' IS NOT NULL
         AND coalesce(v_result->>'match_basis', '') <> 'vehicle_registered_owner_at_notice' THEN
        BEGIN
          SELECT vehicle.id INTO v_vehicle FROM public.canonical_vehicles vehicle
          WHERE regexp_replace(upper(vehicle.plate_number), '[^A-Z0-9]', '', 'g') = v_row->>'plate'
          ORDER BY vehicle.created_at LIMIT 1;
          IF v_vehicle IS NULL THEN
            v_link := 'plate_not_on_file';
          ELSIF EXISTS (
            SELECT 1 FROM public.entity_links link
            WHERE link.organization_id = '${RM_ORGANIZATION_ID}'::uuid AND link.from_type = 'person'
              AND link.from_id = (v_result->>'canonical_person_id')::uuid AND link.to_type = 'vehicle'
              AND link.to_id = v_vehicle AND link.active
          ) THEN
            v_link := 'already_linked';
          ELSE
            SELECT record.id INTO v_person_record
            FROM public.canonical_person_links person_link
            JOIN public.person_records record ON record.id = person_link.source_id
            WHERE person_link.canonical_person_id = (v_result->>'canonical_person_id')::uuid
              AND person_link.source_table = 'person_records'
              AND record.organization_id = '${RM_ORGANIZATION_ID}'::uuid
              AND NOT (record.metadata ? 'merged_into_person_record_id')
            ORDER BY record.created_at LIMIT 1;
            IF v_person_record IS NULL THEN
              v_link := 'no_rm_person_record';
            ELSE
              PERFORM public.record_vehicle_person('${RM_ORGANIZATION_ID}'::uuid, v_vehicle, v_person_record, NULL,
                'associated_person', 'other',
                'Named with this vehicle on an R&M ' || replace(v_row->>'kind', '_', ' ') || ' (' || (v_row->>'document_name')
                  || ', issued ' || (v_row->>'issued') || ')');
              v_link := 'linked_associated_person';
            END IF;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          v_link := 'link_error: ' || left(SQLERRM, 120);
        END;
      END IF;
      INSERT INTO notice_seed_results VALUES (v_row->>'import_key',
        CASE WHEN (v_result->>'inserted')::boolean THEN 'imported' ELSE 'already_present' END,
        v_result->>'match_basis', (v_result->>'canonical_person_id')::uuid, NULL, v_link);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO notice_seed_results VALUES (v_row->>'import_key',
        CASE WHEN SQLERRM LIKE 'Ambiguous person%' THEN 'held_ambiguous_person'
             WHEN SQLERRM LIKE 'A given name and family name%' THEN 'held_name_incomplete' ELSE 'error' END,
        NULL, NULL, left(SQLERRM, 200), NULL);
    END;
  END LOOP;
END
$seed$;`;
}

const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));

async function runApply({ plan, commit, limit, report }) {
  const { cliQuery: rawQuery } = await import('../services/document-source-worker/reconcile-plan.mjs');
  const cliQuery = (sql) => {
    try { return rawQuery(sql); } catch (error) {
      // Postgres can echo seed data in its error; keep the full text in a local file only.
      const text = String(error.stderr || '') + String(error.stdout || '') + String(error.message);
      if (process.env.NOTICE_SEED_ERROR_LOG) writeFileSync(process.env.NOTICE_SEED_ERROR_LOG, text);
      throw new Error((text.split('\n').find((line) => /ERROR|error:/i.test(line)) ?? 'query failed').slice(0, 300));
    }
  };
  // Oldest first so a later notice for the same new person links to the person the earlier one created.
  const notices = [...plan.notices].sort((a, b) => a.issued.localeCompare(b.issued)).slice(0, limit ?? plan.notices.length);
  const results = [];
  const read = `SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]') AS out FROM notice_seed_results r;`;
  if (!commit) {
    // Each batch rolls back on its own (the API caps request size and time), so a person created by an
    // earlier batch is not visible to a later one in a dry run; commit mode keeps that order.
    for (const batch of chunk(notices, 60)) {
      results.push(...cliQuery(`BEGIN;\n${CLAIMS}\n${noticesSql(batch)}\n${read}\nROLLBACK;`)[0].out);
      console.log(`checked ${results.length}/${notices.length}`);
    }
  } else {
    for (const batch of chunk(notices, 60)) {
      results.push(...cliQuery(`BEGIN;\n${CLAIMS}\n${noticesSql(batch)}\n${read}\nCOMMIT;`)[0].out);
      console.log(`applied ${results.length}/${notices.length}`);
    }
  }
  const tally = (field) => results.reduce((counts, row) => ({ ...counts, [row[field] ?? 'none']: (counts[row[field] ?? 'none'] ?? 0) + 1 }), {});
  const summary = {
    mode: commit ? 'committed' : 'dry_run_rolled_back', planned: notices.length,
    outcomes: tally('outcome'), match_basis: tally('match_basis'), vehicle_links: tally('vehicle_link'),
    errors: results.filter((row) => row.outcome === 'error').reduce((counts, row) => ({ ...counts, [row.error]: (counts[row.error] ?? 0) + 1 }), {}),
  };
  if (report) writeFileSync(outsideRepo(report, 'apply report'), JSON.stringify({ summary, results }, null, 2));
  return summary;
}

function outsideRepo(file, label) {
  if (isWithinRepo(file)) throw new Error(`The ${label} holds personal information and must live outside the repository`);
  return file;
}
const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };

async function main() {
  const cache = argument('--cache');
  if (!cache) throw new Error('Use --cache <local jsonl outside the repository> with --scan, --plan or --apply');
  outsideRepo(cache, 'text cache');
  if (process.argv.includes('--scan')) {
    console.log(JSON.stringify(await runScan({ cache, workers: Math.min(Math.max(Number(argument('--workers') ?? 4), 1), 8) })));
    return;
  }
  const plan = await buildPlan(readJsonLines(cache));
  if (process.argv.includes('--plan')) {
    if (argument('--output')) writeFileSync(outsideRepo(argument('--output'), 'plan'), JSON.stringify(plan, null, 2));
    console.log(JSON.stringify(plan.summary, null, 2));
    return;
  }
  if (process.argv.includes('--apply')) {
    const limit = argument('--limit') ? Number(argument('--limit')) : undefined;
    console.log(JSON.stringify(await runApply({ plan, commit: process.argv.includes('--commit'), limit, report: argument('--report') }), null, 2));
    return;
  }
  throw new Error('Choose --scan, --plan or --apply');
}

if (process.argv[1]?.endsWith('seed-person-notices.mjs')) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
